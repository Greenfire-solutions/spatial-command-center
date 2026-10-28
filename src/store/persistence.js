import { STORAGE_KEY, WORKSPACE_VERSION, defaultUrlForType } from '../constants.js';
import { clamp } from '../utils/math.js';
import { normalizeScreen, serializeScreen } from './workspace-schema.js';
import { NODE_KINDS, normalizeConnector, serializeConnector } from '../connectors/connector-schema.js';
import { normalizeAgentNode } from '../agents/agent-provider.js';

const BACKUP_KEY_PREFIX = STORAGE_KEY + ':incompatible-v';
const SAVE_DEBOUNCE_MS = 400;
const SAVE_MAX_DELAY_MS = 2000;

/*
 * Forward migrations, keyed by the version being migrated FROM. Each entry
 * returns a record one version newer. A missing step is a deliberate,
 * reported failure rather than a silent reset: the unreadable payload is
 * archived under BACKUP_KEY_PREFIX so a user's layout is never destroyed by
 * an upgrade.
 *
 * v1 -> v2: v1 records had no per-screen `source` object; the URL lived only
 * on the screen. normalizeScreen() derives an equivalent source from the
 * legacy fields, so the migration only has to restamp the version.
 *
 * v2 -> v3: connections became connectors — they gained a node kind at each
 * end, a connection mode, a direction, and an explicit capability list.
 * normalizeConnector() derives all of it from the legacy
 * `{ id, sourceId, targetId, agent }`, landing every existing connection on
 * the default mode. That is deliberate: the default grants a title and a URL
 * and nothing else, so upgrading a workspace can never retroactively widen
 * what an already-drawn line is allowed to read.
 *
 * v3 -> v4: agents became first-class workspace objects rather than a string
 * label on a connector. A v3 record simply has none; the migration adds the
 * empty collection so nothing downstream has to treat its absence as a case.
 *
 * v4 -> v5: every screen carries a real browser source. Before this, a source
 * was opt-in, and a screen without one fell back to placeholder content drawn
 * in an <Html> overlay. That reads as a populated workspace on a desktop and as
 * an empty frame in an immersive session, where <Html> renders nothing — so a
 * workspace saved under v4 would keep looking broken on a headset no matter how
 * the presets were fixed. The migration gives any sourceless screen the same
 * source the presets would now give it, keyed off the panel type, so a layout
 * someone already arranged is repaired in place rather than discarded.
 */
const MIGRATIONS = {
  1: (record) => ({ ...record, version: 2 }),
  2: (record) => ({
    ...record,
    connections: (Array.isArray(record.connections) ? record.connections : []).map(normalizeConnector),
    version: 3
  }),
  3: (record) => ({
    ...record,
    agents: Array.isArray(record.agents) ? record.agents : [],
    version: 4
  }),
  4: (record) => ({
    ...record,
    screens: (Array.isArray(record.screens) ? record.screens : []).map((screen) => {
      if (screen && screen.source && screen.source.type) return screen;
      const address = screen && screen.url ? screen.url : defaultUrlForType(screen && screen.type);
      return {
        ...screen,
        url: address,
        source: {
          id: `source-${screen && screen.id}`,
          sourceId: `browser-${screen && screen.id}`,
          type: 'chromium',
          title: (screen && screen.title) || '',
          url: address,
          browserWidth: 1280,
          browserHeight: 800
        }
      };
    }),
    version: 5
  })
};

export const migrateWorkspaceRecord = (rawRecord) => {
  if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
    return { ok: false, reason: 'The saved workspace is not an object.' };
  }
  if (!Array.isArray(rawRecord.screens)) {
    return { ok: false, reason: 'The saved workspace has no screen list.' };
  }

  // Saves written before versioning existed are treated as version 1.
  let version = Number(rawRecord.version);
  if (!Number.isInteger(version) || version < 1) version = 1;

  if (version > WORKSPACE_VERSION) {
    return {
      ok: false,
      reason: `The saved workspace uses format v${version}, but this build understands v${WORKSPACE_VERSION}.`,
      version
    };
  }

  let record = rawRecord;
  while (version < WORKSPACE_VERSION) {
    const migrate = MIGRATIONS[version];
    if (typeof migrate !== 'function') {
      return { ok: false, reason: `No migration exists from workspace format v${version}.`, version };
    }
    record = migrate(record);
    version += 1;
  }
  return { ok: true, record: { ...record, version: WORKSPACE_VERSION }, version };
};

const readStorage = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Could not read the saved spatial workspace.', error);
    return null;
  }
};

const archiveIncompatibleWorkspace = (raw, version) => {
  try {
    localStorage.setItem(BACKUP_KEY_PREFIX + version, raw);
  } catch (error) {
    console.warn('Could not archive the incompatible workspace.', error);
  }
};

export const hydrateWorkspaceRecord = (record) => {
  const screens = record.screens.map(normalizeScreen);
  const ids = new Set(screens.map((screen) => screen.id));
  /* Drop connectors whose window ends no longer exist. Non-window ends — an
   * agent, a process — are not screens and must not be garbage-collected
   * against the screen list. */
  const agents = Array.isArray(record.agents) ? record.agents.map(normalizeAgentNode) : [];
  const agentIds = new Set(agents.map((agent) => agent.id));

  /* An end must still exist, whichever kind it is. An agent that was deleted
   * strands a connector exactly as a closed window does. */
  const endPresent = (id, kind) => (
    kind === NODE_KINDS.AGENT ? agentIds.has(id) : ids.has(id)
  );
  const connections = Array.isArray(record.connections)
    ? record.connections
        .map(normalizeConnector)
        .filter((connector) => (
          endPresent(connector.sourceId, connector.sourceKind)
          && endPresent(connector.targetId, connector.targetKind)
        ))
    : [];
  return {
    screens,
    connections,
    agents,
    currentPreset: record.currentPreset || 'Custom',
    rotationSnap: [0, 5, 15, 30, 45].includes(Number(record.rotationSnap)) ? Number(record.rotationSnap) : 15,
    positionSnap: record.positionSnap !== false,
    /* How the workspace is carried, not where the windows are. Restored so a
     * returning user gets the arrangement they chose rather than the default. */
    workspaceMode: record.workspaceMode === 'follow' ? 'follow' : 'world',
    uiSurface: record.uiSurface === 'spatial' ? 'spatial' : 'dom',
    arcSettings: {
      radius: clamp(Number(record.arcSettings && record.arcSettings.radius) || 5.5, 2.5, 10),
      spacing: clamp(Number(record.arcSettings && record.arcSettings.spacing) || 2.0, 0.8, 4),
      height: clamp(Number(record.arcSettings && record.arcSettings.height) || 1.55, -1, 5),
      arcAngle: clamp(Number(record.arcSettings && record.arcSettings.arcAngle) || 80, 20, 170)
    }
  };
};

export const loadWorkspace = () => {
  const raw = readStorage();
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('The saved spatial workspace is not valid JSON; starting from the default layout.', error);
    return null;
  }

  const migration = migrateWorkspaceRecord(parsed);
  if (!migration.ok) {
    console.warn(`${migration.reason} Archiving it and starting from the default layout.`);
    archiveIncompatibleWorkspace(raw, migration.version || 'unknown');
    return null;
  }

  try {
    return hydrateWorkspaceRecord(migration.record);
  } catch (error) {
    console.warn('Could not restore the saved spatial workspace.', error);
    return null;
  }
};

export const serializeWorkspace = (state) => ({
  version: WORKSPACE_VERSION,
  screens: state.screens.map(serializeScreen),
  connections: state.connections.map(serializeConnector),
  agents: (state.agents || []).map((agent) => ({ ...agent })),
  currentPreset: state.currentPreset,
  rotationSnap: state.rotationSnap,
  positionSnap: state.positionSnap,
  workspaceMode: state.workspaceMode === 'follow' ? 'follow' : 'world',
  uiSurface: state.uiSurface,
  arcSettings: { ...state.arcSettings },
  savedAt: new Date().toISOString()
});

/* Whoever shows messages to the person (the store's toast) registers here, so
 * a failed save is seen rather than only logged. A save that fails silently
 * means a layout that is gone on the next start with no warning. */
let saveErrorHandler = null;
export const onWorkspaceSaveError = (handler) => {
  saveErrorHandler = typeof handler === 'function' ? handler : null;
};

/* Immediate, synchronous write. Reserved for explicit saves and for flushing
 * pending work at shutdown. Everything else should use scheduleWorkspaceSave. */
export const writeWorkspace = (state) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeWorkspace(state)));
    return true;
  } catch (error) {
    console.warn('Could not save the spatial workspace.', error);
    if (saveErrorHandler) {
      try { saveErrorHandler(error); } catch (handlerError) { console.warn('Save error handler failed.', handlerError); }
    }
    return false;
  }
};

/*
 * Continuous manipulation (drag, wheel-depth, rotate) commits a transform on
 * every frame. Serializing the entire workspace at that rate is wasteful and
 * makes localStorage a hot path, so writes are coalesced: a trailing debounce
 * for responsiveness, plus a hard ceiling so a sustained gesture still reaches
 * disk periodically instead of only at the end.
 */
let pendingState = null;
let debounceTimer = null;
let maxDelayTimer = null;
let lifecycleBound = false;

const clearTimers = () => {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (maxDelayTimer !== null) {
    clearTimeout(maxDelayTimer);
    maxDelayTimer = null;
  }
};

export const flushWorkspaceSave = () => {
  clearTimers();
  if (!pendingState) return true;
  const state = pendingState;
  pendingState = null;
  return writeWorkspace(state);
};

const bindLifecycleFlush = () => {
  if (lifecycleBound || typeof window === 'undefined') return;
  lifecycleBound = true;
  // pagehide covers reload/close/navigation; visibilitychange covers the
  // window being hidden, which is the last reliable moment on some platforms.
  window.addEventListener('pagehide', flushWorkspaceSave);
  window.addEventListener('beforeunload', flushWorkspaceSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushWorkspaceSave();
  });
};

export const scheduleWorkspaceSave = (state) => {
  bindLifecycleFlush();
  pendingState = state;
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushWorkspaceSave, SAVE_DEBOUNCE_MS);
  if (maxDelayTimer === null) {
    maxDelayTimer = setTimeout(flushWorkspaceSave, SAVE_MAX_DELAY_MS);
  }
};

/* Test seam: report whether a coalesced write is still outstanding. */
export const hasPendingWorkspaceSave = () => pendingState !== null;
