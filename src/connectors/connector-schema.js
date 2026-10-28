import { makeId } from '../utils/math.js';

/*
 * A connector is a relationship with a contract, not just a line.
 *
 * The workspace has drawn connections since the first preset:
 * `{ id, sourceId, targetId, agent }`, rendered as a Bézier cable with a
 * flowing particle. That shape was right and is preserved — every existing
 * saved workspace and preset normalizes forward without losing anything, and
 * `sourceId`/`targetId` keep their meaning so the renderer is untouched.
 *
 * What is added here is what the line has to *mean* before information can
 * travel along it:
 *
 *   kind      what is at each end. A window today, an agent tomorrow, and the
 *             renderer no longer has to assume both ends are screens.
 *   mode      how the two are connected — the answer to the question the
 *             configuration panel asks when a connector is drawn.
 *   direction which way information moves, because "A summarizes B" and
 *             "B summarizes A" are different relationships drawn identically.
 *   capabilities  exactly what may be read. This is the important one: a
 *             connector does not get everything simply because a line exists.
 *
 * Nothing here calls a provider or extracts anything. This module defines the
 * agreement; enforcing it is the extractor's job, and it can only be enforced
 * if it is written down first.
 */

/* What can be at either end of a connector. Windows exist today; the rest are
 * declared so the graph never has to be widened later to admit them. */
export const NODE_KINDS = Object.freeze({
  WINDOW: 'window',
  AGENT: 'agent',
  PROCESS: 'process'
});

const NODE_KIND_VALUES = new Set(Object.values(NODE_KINDS));

/*
 * Everything a connector may be permitted to read from a source.
 *
 * These name *categories of page content*, deliberately not DOM specifics, so
 * the same vocabulary works for a PDF, a video, or a terminal later.
 */
export const CAPABILITIES = Object.freeze({
  TITLE: 'title',
  URL: 'url',
  TEXT: 'text',
  HEADINGS: 'headings',
  LINKS: 'links',
  IMAGES: 'images',
  VIDEOS: 'videos',
  METADATA: 'metadata',
  STRUCTURED_DATA: 'structuredData',
  SELECTION: 'selection'
});

const CAPABILITY_VALUES = new Set(Object.values(CAPABILITIES));

/*
 * Categories that may never be granted, by any mode, at any time.
 *
 * This is a denylist rather than merely an absent allowlist because the
 * failure it prevents is a future contributor adding a "read everything" mode
 * and quietly sweeping credentials into an agent prompt. Asking for one of
 * these is treated as a bug in the caller and reported, not silently dropped.
 */
export const FORBIDDEN_CAPABILITIES = Object.freeze([
  'passwords',
  'credentials',
  'cookies',
  'authTokens',
  'sessionTokens',
  'paymentDetails',
  'cardNumbers',
  'hiddenFields',
  'formValues'
]);

const FORBIDDEN_SET = new Set(FORBIDDEN_CAPABILITIES);

/*
 * How two things are connected.
 *
 * Each mode carries the capabilities it needs by default, so choosing
 * "Summarize" in the panel grants reading text and headings and nothing else.
 * A user may narrow this afterwards ("extract only the links"); they may not
 * widen it past what the mode declares without choosing Custom.
 *
 * Modes are data so the configuration panel is generated from this table
 * rather than hard-coding a list that drifts away from what the graph accepts.
 */
export const CONNECTION_MODES = Object.freeze({
  reference: {
    id: 'reference',
    label: 'Reference',
    description: 'A relationship only. Nothing is read from the source.',
    defaultCapabilities: [CAPABILITIES.TITLE, CAPABILITIES.URL],
    directional: false
  },
  extract: {
    id: 'extract',
    label: 'Extract',
    description: 'Pull structured content out of the source.',
    defaultCapabilities: [
      CAPABILITIES.TITLE, CAPABILITIES.URL, CAPABILITIES.TEXT,
      CAPABILITIES.HEADINGS, CAPABILITIES.LINKS, CAPABILITIES.IMAGES
    ],
    directional: true
  },
  send: {
    id: 'send',
    label: 'Send',
    description: 'Push the source’s content to the target once.',
    defaultCapabilities: [CAPABILITIES.TITLE, CAPABILITIES.URL, CAPABILITIES.TEXT],
    directional: true
  },
  synchronize: {
    id: 'synchronize',
    label: 'Synchronize',
    description: 'Keep the target following the source as it changes.',
    defaultCapabilities: [CAPABILITIES.TITLE, CAPABILITIES.URL],
    directional: true
  },
  summarize: {
    id: 'summarize',
    label: 'Summarize',
    description: 'The target produces a shorter form of the source.',
    defaultCapabilities: [CAPABILITIES.TITLE, CAPABILITIES.TEXT, CAPABILITIES.HEADINGS],
    directional: true
  },
  analyze: {
    id: 'analyze',
    label: 'Analyze',
    description: 'The target reasons over the source’s content and data.',
    defaultCapabilities: [
      CAPABILITIES.TITLE, CAPABILITIES.URL, CAPABILITIES.TEXT,
      CAPABILITIES.HEADINGS, CAPABILITIES.STRUCTURED_DATA
    ],
    directional: true
  },
  monitor: {
    id: 'monitor',
    label: 'Monitor',
    description: 'Watch the source and report when it changes.',
    defaultCapabilities: [CAPABILITIES.TITLE, CAPABILITIES.URL],
    directional: true
  },
  compare: {
    id: 'compare',
    label: 'Compare',
    description: 'Both ends are read together and set against each other.',
    defaultCapabilities: [CAPABILITIES.TITLE, CAPABILITIES.TEXT, CAPABILITIES.HEADINGS],
    directional: false
  },
  transform: {
    id: 'transform',
    label: 'Transform',
    description: 'Content is reshaped on its way from source to target.',
    defaultCapabilities: [CAPABILITIES.TEXT],
    directional: true
  },
  'agent-context': {
    id: 'agent-context',
    label: 'Agent Context',
    description: 'The source becomes usable context for an agent.',
    defaultCapabilities: [
      CAPABILITIES.TITLE, CAPABILITIES.URL, CAPABILITIES.TEXT,
      CAPABILITIES.HEADINGS, CAPABILITIES.LINKS, CAPABILITIES.METADATA
    ],
    directional: true
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    description: 'Choose exactly what may be read.',
    defaultCapabilities: [],
    directional: true
  }
});

export const CONNECTION_MODE_LIST = Object.freeze(Object.values(CONNECTION_MODES));

/* The mode a freshly drawn connector gets before the user answers the panel.
 * Reference is deliberately the least capable: drawing a line must never be
 * the same act as granting access to a page. */
export const DEFAULT_MODE = 'reference';

export const DIRECTIONS = Object.freeze({
  FORWARD: 'forward',
  REVERSE: 'reverse',
  BIDIRECTIONAL: 'bidirectional'
});

const DIRECTION_VALUES = new Set(Object.values(DIRECTIONS));

export const isForbiddenCapability = (capability) => FORBIDDEN_SET.has(String(capability));

/*
 * Reduce a requested capability list to what is actually permitted.
 *
 * Returns the granted list plus whatever was refused and why, because a
 * connector that silently drops half of what was asked for is impossible to
 * debug from the panel.
 */
export const normalizeCapabilities = (requested, mode = DEFAULT_MODE) => {
  const modeDefinition = CONNECTION_MODES[mode] || CONNECTION_MODES[DEFAULT_MODE];
  const list = Array.isArray(requested) ? requested : modeDefinition.defaultCapabilities;

  /* A mode is a ceiling, not just a starting point. Choosing Summarize and
   * then asking for images should not quietly grant them — the mode is what
   * the user agreed to. Custom is the deliberate exception: its whole purpose
   * is to say exactly what may be read, so it has no ceiling of its own. */
  const ceiling = mode === 'custom' ? null : new Set(modeDefinition.defaultCapabilities);

  const granted = [];
  const forbidden = [];
  const unknown = [];
  const outOfScope = [];

  for (const raw of list) {
    const capability = String(raw);
    if (FORBIDDEN_SET.has(capability)) { forbidden.push(capability); continue; }
    if (!CAPABILITY_VALUES.has(capability)) { unknown.push(capability); continue; }
    if (ceiling && !ceiling.has(capability)) { outOfScope.push(capability); continue; }
    if (!granted.includes(capability)) granted.push(capability);
  }

  return { granted, forbidden, unknown, outOfScope };
};

const normalizeNodeKind = (kind) => (
  NODE_KIND_VALUES.has(kind) ? kind : NODE_KINDS.WINDOW
);

/*
 * Bring any connector-shaped record up to the current schema.
 *
 * Accepts the legacy `{ id, sourceId, targetId, agent }` written by every
 * existing preset and saved workspace. A legacy record keeps its ids and its
 * agent label, gains window kinds, and lands on the default mode — which
 * grants nothing beyond a title and a URL, so an upgrade cannot retroactively
 * widen what an old connection could read.
 */
export const normalizeConnector = (raw) => {
  const input = raw || {};
  const mode = CONNECTION_MODES[input.mode] ? input.mode : DEFAULT_MODE;
  const modeDefinition = CONNECTION_MODES[mode];

  const capabilities = normalizeCapabilities(
    Array.isArray(input.capabilities) ? input.capabilities : modeDefinition.defaultCapabilities,
    mode
  );

  const direction = modeDefinition.directional
    ? (DIRECTION_VALUES.has(input.direction) ? input.direction : DIRECTIONS.FORWARD)
    : DIRECTIONS.BIDIRECTIONAL;

  return {
    id: input.id || makeId('connector'),
    sourceId: input.sourceId ?? null,
    targetId: input.targetId ?? null,
    sourceKind: normalizeNodeKind(input.sourceKind),
    targetKind: normalizeNodeKind(input.targetKind),
    mode,
    direction,
    capabilities: capabilities.granted,
    /* Preserved from the original model: a human label for what the
     * connection is doing, shown on the cable. */
    agent: typeof input.agent === 'string' ? input.agent : '',
    enabled: input.enabled !== false,
    /* True until the user answers the configuration panel. The renderer uses
     * this to show a connector as provisional rather than active. */
    unconfigured: input.unconfigured === true,
    label: typeof input.label === 'string' ? input.label : '',
    createdAt: input.createdAt || new Date().toISOString()
  };
};

export const serializeConnector = (connector) => {
  /* Anything that reached the store without passing through the normalizer
   * (a legacy-shaped connector) is normalized here rather than crashing the
   * whole save on a missing capability list. */
  const clean = connector && Array.isArray(connector.capabilities) ? connector : normalizeConnector(connector);
  return { ...clean, capabilities: clean.capabilities.slice() };
};

/*
 * Build a connector from a drawn or spoken gesture.
 *
 * Every input route — mouse drag, controller stretch, hand pinch, voice —
 * lands here, so there is exactly one definition of what drawing a line
 * creates and one place where the default permission is decided.
 */
export const createConnector = ({
  sourceId,
  targetId,
  sourceKind = NODE_KINDS.WINDOW,
  targetKind = NODE_KINDS.WINDOW,
  mode = DEFAULT_MODE,
  agent = '',
  capabilities = null
} = {}) => {
  if (!sourceId || !targetId) {
    return { ok: false, reason: 'A connector needs both a source and a target.' };
  }
  if (sourceId === targetId && sourceKind === targetKind) {
    return { ok: false, reason: 'A connector cannot loop back to the same node.' };
  }
  return {
    ok: true,
    connector: normalizeConnector({
      sourceId,
      targetId,
      sourceKind,
      targetKind,
      mode,
      agent,
      capabilities,
      /* A newly drawn connector is provisional until the panel is answered. */
      unconfigured: mode === DEFAULT_MODE
    })
  };
};

/* Would this connector duplicate one already in the graph? Direction matters
 * for directional modes; for a symmetric mode like Compare, A→B and B→A are
 * the same relationship drawn twice. */
export const isDuplicateConnector = (connectors, candidate) => (
  (connectors || []).some((existing) => {
    const sameEnds = existing.sourceId === candidate.sourceId
      && existing.targetId === candidate.targetId
      && existing.sourceKind === candidate.sourceKind
      && existing.targetKind === candidate.targetKind;
    const mirrored = existing.sourceId === candidate.targetId
      && existing.targetId === candidate.sourceId
      && existing.sourceKind === candidate.targetKind
      && existing.targetKind === candidate.sourceKind;
    if (existing.mode !== candidate.mode) return false;
    const symmetric = !CONNECTION_MODES[candidate.mode]?.directional;
    return sameEnds || (symmetric && mirrored);
  })
);
