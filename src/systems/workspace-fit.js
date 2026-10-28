/*
 * Put the whole workspace in front of the person, at the size of a desk.
 *
 * Two complaints, one cause.
 *
 * "It is usually always behind me." A layout is authored in world coordinates —
 * screens sit around z = -2, which is in front of somebody facing -Z. Which way
 * the WEARER is facing when the session opens is decided by the runtime and by
 * which way they happened to be standing, and it has nothing to do with the
 * authored coordinates. So roughly half the time the workspace is behind them,
 * and there is no amount of "correct" placement in the preset that fixes it.
 *
 * "It needs to be smaller." One panel is not the problem: 2.2 m at 2.15 m is
 * 54 degrees, and a 27 inch monitor at desk distance is 53. The problem is that
 * eight of them wrap around you. A desk is a shallow arc you can take in
 * without moving your head; a workspace that surrounds you is a room you have
 * to search. And uniform scaling cannot fix it, because halving both the size
 * and the distance leaves the angle exactly where it was — only the RATIO of
 * extent to distance matters.
 *
 * So the fit solves for that ratio directly: place the layout's centre at a
 * fixed comfortable distance ahead of where the wearer is actually looking, and
 * scale the layout so its whole width subtends a chosen angle. Roughly 100
 * degrees is a triple-monitor desk — wide enough to be a workspace, narrow
 * enough to see at once.
 *
 * This is one transform on the workspace root. No window's stored position,
 * rotation or scale is touched, so nothing reloads and the arrangement someone
 * built is preserved exactly — it is simply carried to where they can see it.
 *
 * Pure maths, no three.js, so the arithmetic is checked by tests instead of by
 * someone turning round in a headset.
 */

/* A triple-monitor desk. Wide enough to be a workspace, narrow enough to take
 * in without hunting. */
export const DEFAULT_FIT_DEGREES = 100;

/* How far ahead the middle of the workspace sits. Meta's guidance for indirect
 * pointing is about a metre; a little further suits a wall of text. */
export const DEFAULT_FIT_DISTANCE = 1.7;

/*
 * The fit only ever pulls a workspace IN. It never enlarges one.
 *
 * Fitting to a target width in both directions sounds symmetrical and is
 * wrong: a single modest window would be inflated to fill a hundred degrees
 * because that is the width it was asked to fill. Someone who sized a panel
 * chose that size, and the fit has no business overruling them upward. It
 * exists to rescue a layout that has sprawled, so its ceiling is "leave it
 * alone".
 */
export const MIN_FIT_SCALE = 0.25;
export const MAX_FIT_SCALE = 1;

/*
 * Presets are authored for somebody facing -Z, so the layout's "front" is the
 * direction a viewer with this yaw would be looking. viewpointForwardHorizontal
 * gives (0,0,-1) for the default camera, and atan2(0,-1) is pi.
 */
const AUTHORED_YAW = Math.PI;

/**
 * The horizontal extent and centre of a set of screens, in workspace space.
 *
 * Uses each screen's own size and scale, so a layout of small panels is not
 * treated as if it were a layout of large ones.
 */
export const layoutBounds = (screens) => {
  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  let minZ = Infinity; let maxZ = -Infinity;
  let counted = 0;

  for (const screen of screens || []) {
    const position = screen?.position;
    if (!Array.isArray(position) || position.length < 3) continue;
    if (!position.every(Number.isFinite)) continue;
    const scaleX = Number(screen?.scale?.[0]) || 1;
    const scaleY = Number(screen?.scale?.[1]) || 1;
    const halfW = ((Number(screen?.size?.[0]) || 0) * scaleX) / 2;
    const halfH = ((Number(screen?.size?.[1]) || 0) * scaleY) / 2;

    minX = Math.min(minX, position[0] - halfW);
    maxX = Math.max(maxX, position[0] + halfW);
    minY = Math.min(minY, position[1] - halfH);
    maxY = Math.max(maxY, position[1] + halfH);
    minZ = Math.min(minZ, position[2]);
    maxZ = Math.max(maxZ, position[2]);
    counted += 1;
  }

  if (!counted) return null;

  /* Depth counts toward width. A layout wrapped around the viewer is wide in Z
   * as well as X, and ignoring that would leave the wrapped panels outside the
   * envelope the fit was supposed to guarantee. */
  const width = Math.max(maxX - minX, maxZ - minZ);

  return Object.freeze({
    center: Object.freeze([(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]),
    width,
    height: maxY - minY,
    count: counted
  });
};

/**
 * Solve the workspace root transform that puts a layout in front of the viewer
 * at a comfortable angular size.
 *
 * @returns {{position:number[], yaw:number, scale:number}|null}
 */
export const fitWorkspaceToView = ({
  screens,
  viewerPosition,
  viewerYaw,
  degrees = DEFAULT_FIT_DEGREES,
  distance = DEFAULT_FIT_DISTANCE
}) => {
  const bounds = layoutBounds(screens);
  if (!bounds) return null;
  if (!Array.isArray(viewerPosition) || !viewerPosition.every(Number.isFinite)) return null;
  if (!Number.isFinite(viewerYaw)) return null;

  /* Turn the layout so its authored front faces the way the wearer is actually
   * looking. This is the half of the fix that stops it being behind them. */
  const yaw = viewerYaw - AUTHORED_YAW;

  /* Scale so the layout's width subtends `degrees` at `distance`. A degenerate
   * layout — one window, or several stacked exactly — has no width to fit, so
   * it keeps its authored size rather than being scaled by infinity. */
  const targetWidth = 2 * distance * Math.tan((degrees * Math.PI) / 360);
  const scale = bounds.width > 0.01
    ? Math.min(MAX_FIT_SCALE, Math.max(MIN_FIT_SCALE, targetWidth / bounds.width))
    : MAX_FIT_SCALE;

  /* Where the middle of the workspace should end up: straight ahead, at eye
   * level, at the chosen distance. */
  const forwardX = Math.sin(viewerYaw);
  const forwardZ = Math.cos(viewerYaw);
  const target = [
    viewerPosition[0] + forwardX * distance,
    viewerPosition[1],
    viewerPosition[2] + forwardZ * distance
  ];

  /* The root maps a local point p to  position + R(yaw) * (scale * p).
   * Solving that for the centre landing on the target gives the translation. */
  const scaled = [bounds.center[0] * scale, bounds.center[1] * scale, bounds.center[2] * scale];
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const rotated = [
    scaled[0] * cos + scaled[2] * sin,
    scaled[1],
    -scaled[0] * sin + scaled[2] * cos
  ];

  return Object.freeze({
    position: Object.freeze([target[0] - rotated[0], target[1] - rotated[1], target[2] - rotated[2]]),
    yaw,
    scale,
    /* Reported so a caller can say what it did, and a test can assert it. */
    fittedDegrees: degrees,
    layoutWidth: bounds.width,
    screenCount: bounds.count
  });
};

/**
 * Where a workspace-local point ends up once a fit is applied.
 * Exists so tests can assert about what the wearer will actually see.
 */
export const applyFit = (fit, point) => {
  const cos = Math.cos(fit.yaw);
  const sin = Math.sin(fit.yaw);
  const s = [point[0] * fit.scale, point[1] * fit.scale, point[2] * fit.scale];
  return [
    fit.position[0] + s[0] * cos + s[2] * sin,
    fit.position[1] + s[1],
    fit.position[2] - s[0] * sin + s[2] * cos
  ];
};

/** Signed angle between the viewer's forward and a world point, in degrees. */
export const angleFromForward = (viewerPosition, viewerYaw, point) => {
  const dx = point[0] - viewerPosition[0];
  const dz = point[2] - viewerPosition[2];
  const pointYaw = Math.atan2(dx, dz);
  let delta = (pointYaw - viewerYaw) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return (delta * 180) / Math.PI;
};
