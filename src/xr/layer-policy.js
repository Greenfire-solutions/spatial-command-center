/*
 * Which screens become WebXR composition layers, and in what order.
 *
 * Measured on a Quest 3 (docs/WEBXR_HEADSET_FINDINGS.md): a textured mesh
 * cannot resolve small type, while the same canvas as a quad layer at
 * `quality="text-optimized"` reads down to 10px. That is the difference
 * between a browser surface being readable and being decorative, so inside a
 * session a browser screen should be a layer whenever it can be.
 *
 * "Whenever it can be" is the whole problem, and it is why this is a module
 * rather than a boolean:
 *
 *   Layers are not depth-tested. Not against each other and not against the
 *   scene — the spec composites them strictly back-to-front in array order.
 *   Ordering is therefore ours to get right, and the ordering is by view
 *   distance, farthest first.
 *
 *   The runtime has a ceiling and does not publish it. updateRenderState()
 *   throws when it is exceeded, so the count must be bounded by something we
 *   choose, and exceeding it must degrade to a mesh rather than lose a frame.
 *
 *   The base layer draws on top. @pmndrs/xr pushes it last, so anything the
 *   WebGL scene paints hides every layer beneath it. A layer is visible only
 *   through a hole, which makes the opaque background and the environment
 *   constraints rather than free choices.
 *
 * Pure and side-effect free, so all of that is testable without a headset.
 */

/*
 * How many layers to ask for.
 *
 * Conservative on purpose. The OpenXR-adjacent reference point is 16 total,
 * but the Quest browser publishes nothing, and the cost of guessing high is an
 * exception mid-session. Four covers a focused screen plus its neighbours,
 * which is where legibility actually matters, and the ceiling is raised by
 * measurement rather than by optimism.
 */
export const DEFAULT_LAYER_BUDGET = 4;

/* Tiers that justify a layer. browser-quality.js already decides which screens
 * the user is actually looking at; spending the scarce resource on the same
 * screens keeps one attention model rather than two. */
const LAYER_WORTHY_TIERS = new Set(['focused', 'near']);

/*
 * Reasons a screen renders as a mesh. Returned rather than implied so a
 * diagnostic panel can say why a surface is soft, which on a headset is
 * otherwise unanswerable.
 */
export const MESH_REASONS = Object.freeze({
  NO_SESSION: 'no-session',
  LAYERS_UNSUPPORTED: 'layers-unsupported',
  LAYERS_DISABLED: 'layers-disabled',
  NOT_A_BROWSER: 'not-a-browser',
  NO_CONTENT: 'no-content',
  TIER: 'tier',
  BUDGET: 'budget'
});

const distanceFrom = (viewer, position) => {
  if (!viewer || !Array.isArray(position)) return Infinity;
  const dx = position[0] - viewer[0];
  const dy = position[1] - viewer[1];
  const dz = position[2] - viewer[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/* A screen worth promoting has actual pixels to show. A layer over a surface
 * that has never painted is a transparent hole in the scene. */
const hasContent = (screen) => Boolean(
  screen.hasContent ?? (screen.source && screen.source.type === 'chromium')
);

/*
 * Decide the layer set for one frame.
 *
 * Returns { layers, meshes, order } where `layers` is already sorted
 * back-to-front — the order the runtime must receive them in — and every
 * screen appears in exactly one of the two lists.
 */
export const planLayers = ({
  screens = [],
  tiers = new Map(),
  viewerPosition = null,
  presenting = false,
  layersSupported = false,
  enabled = true,
  budget = DEFAULT_LAYER_BUDGET,
  positionOf = (screen) => screen.position
} = {}) => {
  const meshes = [];
  const push = (screen, reason) => meshes.push({ id: screen.id, reason });

  if (!presenting) {
    for (const screen of screens) push(screen, MESH_REASONS.NO_SESSION);
    return { layers: [], meshes, order: [] };
  }
  if (!layersSupported) {
    for (const screen of screens) push(screen, MESH_REASONS.LAYERS_UNSUPPORTED);
    return { layers: [], meshes, order: [] };
  }
  if (!enabled) {
    for (const screen of screens) push(screen, MESH_REASONS.LAYERS_DISABLED);
    return { layers: [], meshes, order: [] };
  }

  const candidates = [];
  for (const screen of screens) {
    if (!hasContent(screen)) {
      push(screen, screen.source && screen.source.type === 'chromium'
        ? MESH_REASONS.NO_CONTENT
        : MESH_REASONS.NOT_A_BROWSER);
      continue;
    }
    const tier = tiers.get ? tiers.get(screen.id) : tiers[screen.id];
    if (!LAYER_WORTHY_TIERS.has(tier)) {
      push(screen, MESH_REASONS.TIER);
      continue;
    }
    candidates.push({
      id: screen.id,
      tier,
      distance: distanceFrom(viewerPosition, positionOf(screen))
    });
  }

  /* Nearest first to decide *who* gets a layer — the closest screens are where
   * small type is actually being read. */
  candidates.sort((a, b) => a.distance - b.distance);

  const cap = Math.max(0, Math.floor(budget));
  const chosen = candidates.slice(0, cap);
  for (const rejected of candidates.slice(cap)) {
    meshes.push({ id: rejected.id, reason: MESH_REASONS.BUDGET });
  }

  /* Farthest first to decide the *order* they are submitted in — layers are
   * painted back to front with no depth test, so this is what makes a near
   * screen occlude a far one instead of the reverse. */
  const layers = chosen.slice().sort((a, b) => b.distance - a.distance);

  return { layers, meshes, order: layers.map((entry) => entry.id) };
};

/*
 * Lower the budget after the runtime refused.
 *
 * updateRenderState() throws rather than reporting a limit, so the limit is
 * learned by being told no. Backing off by one and remembering it turns a
 * hard failure into one soft frame.
 */
export const reduceBudget = (budget) => Math.max(0, Math.floor(budget) - 1);

/*
 * Whether the renderer must be built for layers at all.
 *
 * This cannot be decided per frame: a WebGL context's alpha is fixed at
 * creation, and a layer is only visible where the base layer is transparent.
 * So the decision is made once, at mount, and it is a real tradeoff — an
 * alpha context costs a little on the desktop, where no layer will ever exist.
 */
export const needsTransparentBaseLayer = ({ layersEnabled = true, probe = false } = {}) => (
  Boolean(layersEnabled || probe)
);

/*
 * What the scene may paint when layers are live.
 *
 * A skybox, a room, or an opaque clear colour all sit in the base layer, which
 * @pmndrs/xr composites on top — so any of them hides every layer beneath.
 * Inside a session with layers the environment must not draw. This is the same
 * separation §13A requires for passthrough, arrived at from the other
 * direction: there, the environment is absent because reality replaces it.
 */
export const environmentAllowed = ({ presenting = false, layersActive = false } = {}) => (
  !(presenting && layersActive)
);
