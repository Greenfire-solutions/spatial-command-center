import { create } from 'zustand';
import { clamp, makeId, normalizeRotation, normalizeVec3 } from '../utils/math.js';
import { browserViewportForScreen, normalizeScreen, serializeScreen } from './workspace-schema.js';
import {
  flushWorkspaceSave,
  loadWorkspace,
  onWorkspaceSaveError,
  scheduleWorkspaceSave,
  writeWorkspace
} from './persistence.js';
import { clonePreset } from '../presets/workspace-presets.js';
import { AGENT_STATUS, normalizeAgentNode } from '../agents/agent-provider.js';
import {
  CONNECTION_MODES,
  DEFAULT_MODE,
  NODE_KINDS,
  createConnector as buildConnector,
  isDuplicateConnector,
  normalizeCapabilities,
  normalizeConnector
} from '../connectors/connector-schema.js';

/*
 * The single source of truth for the workspace.
 *
 * Durable state (screens, connections, snapping preferences, arc settings) is
 * written through the coalesced persistence layer, never synchronously on a
 * per-frame path. Transient interaction state (selection, mode, manipulation)
 * is intentionally not persisted.
 *
 * A screen's spatial transform and its content source stay separate here as
 * well: mutations that move a screen must not touch screen.source, because
 * that is what keeps a Chromium webContents alive across manipulation.
 */
const restoredWorkspace = loadWorkspace();
const DEFAULT_PRESET = 'Welcome';
const defaultWorkspace = clonePreset(DEFAULT_PRESET);
let transitionSequence = 0;
let toastSequence = 0;
let commandSequence = 0;

const useStore = create((set, get) => ({
  screens: restoredWorkspace ? restoredWorkspace.screens : defaultWorkspace.screens,
  connections: restoredWorkspace ? restoredWorkspace.connections : defaultWorkspace.connections,
  /* Agents are workspace objects, not a property of a connector. A connector
   * points at one the same way it points at a window. */
  agents: restoredWorkspace ? (restoredWorkspace.agents || []) : [],
  currentPreset: restoredWorkspace ? restoredWorkspace.currentPreset : DEFAULT_PRESET,
  selectedScreen: null,

  /*
   * The two workspace modes, and there are only two.
   *
   *   'world'  — the workspace root never moves. You walk around your screens.
   *   'follow' — the root travels with you. Your screens come with you.
   *
   * This is deliberately NOT the same axis as interactionMode. One decides
   * where the workspace lives; the other decides whether a gesture manipulates
   * a window or its contents. Conflating them is how an application ends up
   * with six modes nobody can name.
   */
  workspaceMode: restoredWorkspace ? (restoredWorkspace.workspaceMode || 'world') : 'world',

  /* Whether the wearer has been asked, this session, how the workspace should
   * behave. Not persisted: it is a question about now, not a preference. */
  workspaceModeChosen: false,

  /* Bumped to ask the workspace root to re-place itself in front of the wearer.
   * A counter rather than a boolean, so two requests in a row both take. */
  workspaceFitNonce: 0,

  interactionMode: 'browse',
  isManipulatingScreen: false,
  manipulationKind: null,
  rotationModifier: false,
  rotationSnap: restoredWorkspace ? restoredWorkspace.rotationSnap : 15,
  positionSnap: restoredWorkspace ? restoredWorkspace.positionSnap : true,
  /* Which surface renders essential screen chrome.
   *
   * 'dom'     — drei <Html> overlays. Crisp and familiar on a desktop, but it
   *             does not exist inside an immersive WebXR session.
   * 'spatial' — real in-scene geometry driven by rays. Works identically for a
   *             mouse, a controller, or a hand, and is what a headset will use.
   *
   * The desktop default stays 'dom' so nothing regresses; entering XR will
   * force 'spatial' regardless of this preference. */
  uiSurface: restoredWorkspace ? restoredWorkspace.uiSurface : 'dom',
  advancedGizmo: false,
  advancedTransformMode: 'translate',
  arcSettings: restoredWorkspace ? restoredWorkspace.arcSettings : {
    radius: 5.5,
    spacing: 2.0,
    height: 1.55,
    arcAngle: 80
  },
  snapGuide: null,
  /* The connector whose configuration panel is open. Set when a line is drawn
   * so the question is asked at the moment it is raised, and settable later so
   * an existing connector can be reconfigured. */
  configuringConnectorId: null,
  /* The connector most recently created or configured. "Only send the links"
   * after "connect Research to Claude" plainly means that one, even though no
   * panel is open — without this the follow-up has no referent and the user is
   * asked a question they already answered. */
  lastConnectorId: null,
  /* An in-progress connector being drawn. Transient interaction state, so it
   * is deliberately not persisted. `hoverTargetId` is the node the pointer is
   * currently over, which is what the draft cable snaps to. */
  connectorDraft: null,
  /* Which screens are currently rendered as WebXR composition layers, in the
   * order they must be submitted. Transient — recomputed from the session, the
   * attention tiers and the runtime budget, never persisted. */
  layerScreenIds: [],
  /* User-facing switch. Layers are the difference between readable and
   * decorative text in a headset, but they forbid an opaque background, so
   * turning them off has to remain possible. */
  browserLayersEnabled: true,
  toast: null,
  urlFocusRequest: null,
  cameraCommand: null,
  cameraFocused: false,

  setSelectedScreen: (id) => set({ selectedScreen: id }),
  setInteractionMode: (mode) => {
    if (get().isManipulatingScreen) return;
    set({ interactionMode: mode === 'arrange' ? 'arrange' : 'browse', snapGuide: null });
  },
  toggleInteractionMode: () => {
    if (get().isManipulatingScreen) return;
    set((state) => ({
      interactionMode: state.interactionMode === 'arrange' ? 'browse' : 'arrange',
      snapGuide: null
    }));
  },
  /*
   * Switching workspace mode changes one thing: the reference the root follows.
   * It must not touch a single window — no reloads, no repositioning, no lost
   * page state — because the layout is the thing the user built and the mode is
   * only how it is carried.
   */
  setWorkspaceMode: (mode) => set({
    workspaceMode: mode === 'follow' ? 'follow' : 'world',
    workspaceModeChosen: true
  }),

  setWorkspaceModeChosen: (chosen) => set({ workspaceModeChosen: Boolean(chosen) }),

  /* "Bring my screens to me." The escape hatch that makes a workspace which has
   * ended up behind you recoverable without taking the headset off. */
  refitWorkspace: () => set((state) => ({ workspaceFitNonce: state.workspaceFitNonce + 1 })),

  setManipulatingScreen: (active, kind) => set({
    isManipulatingScreen: Boolean(active),
    manipulationKind: active ? kind || 'move' : null
  }),
  setRotationModifier: (active) => set({ rotationModifier: Boolean(active) }),
  setRotationSnap: (angle) => {
    const value = [0, 5, 15, 30, 45].includes(Number(angle)) ? Number(angle) : 15;
    set({ rotationSnap: value });
    scheduleWorkspaceSave(get());
  },
  setPositionSnap: (enabled) => {
    set({ positionSnap: Boolean(enabled), snapGuide: null });
    scheduleWorkspaceSave(get());
  },
  setUiSurface: (surface) => {
    set({ uiSurface: surface === 'spatial' ? 'spatial' : 'dom' });
    scheduleWorkspaceSave(get());
  },
  setAdvancedGizmo: (enabled) => set({ advancedGizmo: Boolean(enabled) }),
  setAdvancedTransformMode: (mode) => set({
    advancedTransformMode: ['translate', 'rotate', 'scale'].includes(mode) ? mode : 'translate'
  }),
  setArcSettings: (partial) => {
    set((state) => ({
      arcSettings: {
        radius: clamp(Number(partial.radius ?? state.arcSettings.radius), 2.5, 10),
        spacing: clamp(Number(partial.spacing ?? state.arcSettings.spacing), 0.8, 4),
        height: clamp(Number(partial.height ?? state.arcSettings.height), -1, 5),
        arcAngle: clamp(Number(partial.arcAngle ?? state.arcSettings.arcAngle), 20, 170)
      }
    }));
    scheduleWorkspaceSave(get());
  },
  setSnapGuide: (guide) => set((state) => {
    if ((!guide && !state.snapGuide) || (guide && state.snapGuide && guide.key === state.snapGuide.key)) {
      return state;
    }
    return { snapGuide: guide };
  }),
  showToast: (message) => set({ toast: { id: ++toastSequence, message } }),
  clearToast: (id) => set((state) => state.toast && state.toast.id === id ? { toast: null } : state),

  updateScreenUrl: (id, url) => {
    set((state) => ({
      screens: state.screens.map((screen) => {
        if (screen.id !== id) return screen;
        const sourceType = screen.source.type === 'mock' ? 'iframe' : screen.source.type;
        return {
          ...screen,
          url,
          source: {
            ...screen.source,
            type: sourceType,
            title: screen.title,
            url
          }
        };
      }),
      currentPreset: 'Custom'
    }));
    scheduleWorkspaceSave(get());
  },

  switchScreenSource: (id, requestedType) => {
    const targetType = requestedType === 'chromium' ? 'chromium' : 'iframe';
    let changed = false;
    set((state) => ({
      screens: state.screens.map((screen) => {
        if (screen.id !== id || screen.source.type === targetType) return screen;
        changed = true;
        const calculatedViewport = browserViewportForScreen(screen);
        const keepViewport = Boolean(screen.source.browserViewportExplicit);
        return {
          ...screen,
          source: {
            ...screen.source,
            type: targetType,
            title: screen.title,
            url: screen.url || screen.source.url || '',
            sourceId: screen.source.sourceId || 'browser-' + screen.id,
            browserWidth: targetType === 'chromium' && !keepViewport
              ? calculatedViewport.browserWidth
              : screen.source.browserWidth || calculatedViewport.browserWidth,
            browserHeight: targetType === 'chromium' && !keepViewport
              ? calculatedViewport.browserHeight
              : screen.source.browserHeight || calculatedViewport.browserHeight,
            browserViewportExplicit: keepViewport
          }
        };
      }),
      selectedScreen: id,
      currentPreset: changed ? 'Custom' : state.currentPreset
    }));
    if (!changed) return;
    scheduleWorkspaceSave(get());
    get().showToast(targetType === 'chromium' ? 'Full Browser enabled' : 'Direct iframe enabled');
  },

  /*
   * Re-create every browser source, after the transport comes back.
   *
   * A reconnect restores the socket but not the sources: the host has forgotten
   * them, and nothing in the workspace re-issues createSource, so every screen
   * holds its last painted frame forever. That reads as a live workspace and is
   * a still photograph of one, which is the most confusing failure this system
   * can produce — a person describes a working screen while the host serves
   * nothing.
   *
   * Reuses the retry nonce, so recovery and a manual retry are the same path.
   */
  recreateBrowserSources: () => {
    let changed = false;
    set((state) => ({
      screens: state.screens.map((screen) => {
        if (screen.source.type !== 'chromium') return screen;
        changed = true;
        return { ...screen, _browserRetryNonce: (screen._browserRetryNonce || 0) + 1 };
      })
    }));
    if (changed) get().showToast('Browser sources reconnected');
  },

  retryBrowserSource: (id) => {
    let changed = false;
    set((state) => ({
      screens: state.screens.map((screen) => {
        if (screen.id !== id || screen.source.type !== 'chromium') return screen;
        changed = true;
        return { ...screen, _browserRetryNonce: (screen._browserRetryNonce || 0) + 1 };
      }),
      selectedScreen: id
    }));
    if (!changed) return;
    scheduleWorkspaceSave(get());
    get().showToast('Reconnecting Full Browser…');
  },

  syncBrowserSource: (id, browserState) => {
    const current = get().screens.find((screen) => screen.id === id);
    if (!current || current.source.type !== 'chromium') return;
    const url = typeof browserState.url === 'string' && browserState.url ? browserState.url : current.url;
    const title = browserState.title || current.title;
    const favicon = browserState.favicon || current.source.favicon || '';
    if (url === current.url && title === current.title && favicon === current.source.favicon) return;
    set((state) => ({
      screens: state.screens.map((screen) => {
        if (screen.id !== id || screen.source.type !== 'chromium') return screen;
        return {
          ...screen,
          url,
          title,
          source: {
            ...screen.source,
            url,
            title,
            favicon
          }
        };
      })
    }));
    scheduleWorkspaceSave(get());
  },

  commitScreenTransform: (id, position, rotation, scale) => {
    set((state) => ({
      screens: state.screens.map((screen) => {
        if (screen.id !== id) return screen;
        const next = {
          ...screen,
          position: normalizeVec3(position, screen.position),
          rotation: normalizeRotation(rotation),
          scale: normalizeVec3(scale, screen.scale).map((value) => clamp(value, 0.35, 3))
        };
        delete next._transition;
        return next;
      }),
      currentPreset: 'Custom'
    }));
    scheduleWorkspaceSave(get());
  },

  addScreen: (screenInput) => {
    const screen = normalizeScreen(screenInput);
    set((state) => ({
      screens: state.screens.concat(screen),
      selectedScreen: screen.id,
      currentPreset: 'Custom',
      interactionMode: 'browse',
      urlFocusRequest: { id: screen.id, nonce: ++commandSequence }
    }));
    scheduleWorkspaceSave(get());
    return screen.id;
  },

  duplicateScreen: (id, liveTransform) => {
    const sourceScreen = get().screens.find((screen) => screen.id === id);
    if (!sourceScreen) return null;
    const newId = makeId('screen');
    const position = liveTransform && liveTransform.position
      ? liveTransform.position.slice(0, 3)
      : sourceScreen.position.slice(0, 3);
    position[0] += 0.35;
    position[1] += 0.22;
    position[2] += 0.08;
    const duplicate = normalizeScreen({
      ...serializeScreen(sourceScreen),
      id: newId,
      title: sourceScreen.title + ' Copy',
      position,
      rotation: liveTransform && liveTransform.rotation ? liveTransform.rotation : sourceScreen.rotation,
      scale: liveTransform && liveTransform.scale ? liveTransform.scale : sourceScreen.scale,
      locked: false,
      source: {
        ...sourceScreen.source,
        id: 'source-' + newId,
        sourceId: ''
      }
    });
    set((state) => ({
      screens: state.screens.concat(duplicate),
      selectedScreen: newId,
      currentPreset: 'Custom'
    }));
    scheduleWorkspaceSave(get());
    get().showToast('Screen duplicated');
    return newId;
  },

  /* ---- Connectors ----------------------------------------------------
   *
   * One creation path for every input. A mouse drag, a controller stretch, a
   * hand pinch and a spoken "connect Research to Claude" all land in
   * connectWindows(), so there is a single definition of what drawing a line
   * does and a single place where the default permission is decided.
   */
  setLayerScreenIds: (ids) => set((state) => {
    const next = Array.isArray(ids) ? ids : [];
    if (next.length === state.layerScreenIds.length
      && next.every((id, index) => id === state.layerScreenIds[index])) {
      return state; // Identical plans must not re-render every screen.
    }
    return { layerScreenIds: next };
  }),

  setBrowserLayersEnabled: (enabled) => set({ browserLayersEnabled: Boolean(enabled) }),

  setConfiguringConnector: (id) => set({ configuringConnectorId: id || null }),

  /* ---- Agent nodes ---------------------------------------------------- */
  addAgent: (options = {}) => {
    const agent = normalizeAgentNode(options);
    set((state) => ({ agents: [...state.agents, agent], currentPreset: 'Custom' }));
    scheduleWorkspaceSave(get());
    get().showToast(`${agent.name} added`);
    return agent.id;
  },

  updateAgent: (id, patch = {}) => {
    set((state) => ({
      agents: state.agents.map((agent) => agent.id === id
        ? normalizeAgentNode({ ...agent, ...patch, id: agent.id })
        : agent)
    }));
    scheduleWorkspaceSave(get());
  },

  setAgentStatus: (id, status) => set((state) => ({
    agents: state.agents.map((agent) => agent.id === id
      ? { ...agent, status: Object.values(AGENT_STATUS).includes(status) ? status : agent.status }
      : agent)
  })),

  /* Removing an agent collects the connectors that pointed at it, exactly as
   * closing a window does. */
  removeAgent: (id) => {
    set((state) => ({
      agents: state.agents.filter((agent) => agent.id !== id),
      connections: state.connections.filter((connector) => !(
        (connector.sourceKind === NODE_KINDS.AGENT && connector.sourceId === id)
        || (connector.targetKind === NODE_KINDS.AGENT && connector.targetId === id)
      )),
      currentPreset: 'Custom'
    }));
    scheduleWorkspaceSave(get());
    get().showToast('Agent removed');
  },

  /* ---- Drawing a connector -------------------------------------------
   *
   * The draft is input-agnostic: it carries world-space points, never pixels,
   * so a mouse ray, a controller ray and a pinch ray drive it identically.
   */
  beginConnectorDraft: ({ sourceId, sourceKind = NODE_KINDS.WINDOW, point } = {}) => {
    if (!sourceId) return;
    set({
      connectorDraft: {
        sourceId,
        sourceKind,
        point: Array.isArray(point) ? point.slice(0, 3) : null,
        hoverTargetId: null,
        hoverTargetKind: null
      }
    });
  },

  updateConnectorDraft: ({ point, hoverTargetId, hoverTargetKind } = {}) => {
    const draft = get().connectorDraft;
    if (!draft) return;
    set({
      connectorDraft: {
        ...draft,
        point: Array.isArray(point) ? point.slice(0, 3) : draft.point,
        hoverTargetId: hoverTargetId === undefined ? draft.hoverTargetId : hoverTargetId,
        hoverTargetKind: hoverTargetKind === undefined ? draft.hoverTargetKind : hoverTargetKind
      }
    });
  },

  /* Release. A draft dropped on empty space is abandoned rather than creating
   * a dangling connector. */
  completeConnectorDraft: () => {
    const draft = get().connectorDraft;
    set({ connectorDraft: null });
    if (!draft || !draft.hoverTargetId) return null;
    return get().connectWindows({
      sourceId: draft.sourceId,
      sourceKind: draft.sourceKind,
      targetId: draft.hoverTargetId,
      targetKind: draft.hoverTargetKind || NODE_KINDS.WINDOW
    });
  },

  cancelConnectorDraft: () => set({ connectorDraft: null }),

  connectWindows: ({ sourceId, targetId, sourceKind, targetKind, mode, agent, capabilities } = {}) => {
    const built = buildConnector({ sourceId, targetId, sourceKind, targetKind, mode, agent, capabilities });
    if (!built.ok) {
      get().showToast(built.reason);
      return null;
    }
    if (isDuplicateConnector(get().connections, built.connector)) {
      get().showToast('Those are already connected that way');
      return null;
    }
    set((state) => ({
      connections: [...state.connections, built.connector],
      currentPreset: 'Custom',
      /* Ask immediately. A provisional connector that is never configured
       * reads nothing, so leaving the question unanswered is safe but useless. */
      configuringConnectorId: built.connector.unconfigured
        ? built.connector.id
        : state.configuringConnectorId,
      lastConnectorId: built.connector.id
    }));
    scheduleWorkspaceSave(get());
    return built.connector.id;
  },

  /* Answering the configuration panel. Changing the mode re-derives the
   * permissions from that mode unless the caller states them, so a connector
   * can never keep capabilities its new mode does not justify. */
  configureConnector: (id, { mode, direction, capabilities, agent, label } = {}) => {
    const existing = get().connections.find((connector) => connector.id === id);
    if (!existing) return false;
    const nextMode = CONNECTION_MODES[mode] ? mode : existing.mode;
    const modeChanged = nextMode !== existing.mode;
    const requested = Array.isArray(capabilities)
      ? capabilities
      : (modeChanged ? CONNECTION_MODES[nextMode].defaultCapabilities : existing.capabilities);
    const permitted = normalizeCapabilities(requested, nextMode);

    set((state) => ({
      connections: state.connections.map((connector) => connector.id === id
        ? normalizeConnector({
            ...connector,
            mode: nextMode,
            direction: direction ?? connector.direction,
            capabilities: permitted.granted,
            agent: agent ?? connector.agent,
            label: label ?? connector.label,
            unconfigured: false
          })
        : connector),
      lastConnectorId: id,
      currentPreset: 'Custom'
    }));
    scheduleWorkspaceSave(get());
    if (permitted.forbidden.length > 0) {
      get().showToast(`Refused: ${permitted.forbidden.join(', ')}`);
    }
    return true;
  },

  setConnectorEnabled: (id, enabled) => {
    set((state) => ({
      connections: state.connections.map((connector) => connector.id === id
        ? { ...connector, enabled: Boolean(enabled) }
        : connector)
    }));
    scheduleWorkspaceSave(get());
  },

  removeConnector: (id) => {
    set((state) => ({
      connections: state.connections.filter((connector) => connector.id !== id),
      configuringConnectorId: state.configuringConnectorId === id ? null : state.configuringConnectorId,
      lastConnectorId: state.lastConnectorId === id ? null : state.lastConnectorId,
      currentPreset: 'Custom'
    }));
    scheduleWorkspaceSave(get());
    get().showToast('Disconnected');
  },

  /* Semantic identity, separate from the page's own <title>. A window keeps
   * the name its owner gave it while the page beneath it changes. */
  renameScreen: (id, name) => {
    const clean = String(name || '').trim();
    if (!clean) return false;
    set((state) => ({
      screens: state.screens.map((screen) => screen.id === id ? { ...screen, name: clean } : screen),
      currentPreset: 'Custom'
    }));
    scheduleWorkspaceSave(get());
    return true;
  },

  isScreenLocked: (id) => Boolean(get().screens.find((screen) => screen.id === id)?.locked),

  connectorById: (id) => get().connections.find((connector) => connector.id === id) || null,

  /* The connector joining two nodes, in either direction — "turn off Research
   * to Claude" should find it whichever way it was drawn. */
  connectorBetween: (source, target) => get().connections.find((connector) => (
    (connector.sourceId === source.id && connector.targetId === target.id)
    || (connector.sourceId === target.id && connector.targetId === source.id)
  )) || null,

  connectorsForNode: (nodeId, kind = NODE_KINDS.WINDOW) => get().connections.filter((connector) => (
    (connector.sourceId === nodeId && connector.sourceKind === kind)
    || (connector.targetId === nodeId && connector.targetKind === kind)
  )),

  removeScreen: (id) => {
    set((state) => ({
      screens: state.screens.filter((screen) => screen.id !== id),
      connections: state.connections.filter((connector) => !(
        (connector.sourceKind === NODE_KINDS.WINDOW && connector.sourceId === id)
        || (connector.targetKind === NODE_KINDS.WINDOW && connector.targetId === id)
      )),
      selectedScreen: state.selectedScreen === id ? null : state.selectedScreen,
      currentPreset: 'Custom',
      snapGuide: null
    }));
    scheduleWorkspaceSave(get());
    get().showToast('Screen closed');
  },

  toggleScreenLock: (id) => {
    const current = get().screens.find((screen) => screen.id === id);
    if (!current) return;
    const nextLocked = !current.locked;
    set((state) => ({
      screens: state.screens.map((screen) => screen.id === id ? { ...screen, locked: nextLocked } : screen),
      currentPreset: 'Custom'
    }));
    scheduleWorkspaceSave(get());
    get().showToast(nextLocked ? 'Screen locked' : 'Screen unlocked');
  },

  applyPreset: (presetName) => {
    const preset = clonePreset(presetName);
    const token = ++transitionSequence;
    const screens = preset.screens.map((screen) => ({ ...screen, _transition: token }));
    set({
      screens,
      connections: preset.connections.map(normalizeConnector),
      selectedScreen: null,
      currentPreset: presetName,
      snapGuide: null,
      toast: { id: ++toastSequence, message: presetName.replace(/([a-z])([A-Z])/g, '$1 $2') + ' workspace' }
    });
    scheduleWorkspaceSave(get());
  },

  animateScreens: (screens, label) => {
    const token = ++transitionSequence;
    set({
      screens: screens.map((screen) => ({ ...normalizeScreen(screen), _transition: token })),
      currentPreset: 'Custom',
      snapGuide: null,
      toast: label ? { id: ++toastSequence, message: label } : get().toast
    });
    scheduleWorkspaceSave(get());
  },

  /* An explicit save writes now and reports what really happened. It used to
   * schedule a deferred write and read its (always undefined) return value. */
  saveCurrent: () => {
    flushWorkspaceSave();
    const saved = writeWorkspace(get());
    get().showToast(saved ? 'Workspace saved' : SAVE_FAILED_MESSAGE);
    return saved;
  },
  requestUrlFocus: (id) => set({ urlFocusRequest: { id, nonce: ++commandSequence } }),
  focusCameraOnScreen: (id) => set({
    cameraCommand: { type: 'focus', screenId: id, nonce: ++commandSequence },
    cameraFocused: true
  }),
  returnCameraToWorkspace: () => set({
    cameraCommand: { type: 'return', nonce: ++commandSequence },
    cameraFocused: false
  })
}));

const SAVE_FAILED_MESSAGE = 'Your layout could not be saved. Your screens still work, but changes may be lost when you close the app.';
onWorkspaceSaveError(() => useStore.getState().showToast(SAVE_FAILED_MESSAGE));

export { useStore };
export default useStore;
