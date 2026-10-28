import { executeConnectorUtterance } from './execute-connector-intent.js';
import { createWorkspaceActions } from './window-actions.js';
import { runConnector } from '../connectors/connector-flow.js';
import { resolveBrowserProvider } from '../providers/index.js';

/*
 * One utterance, one pipeline, whichever microphone heard it.
 *
 * There are two now: Web Speech in the page, for a desktop; and the bridge in
 * voice-channel.js, for a headset whose useful microphone is on the desk. They
 * are different transports for the same act, so they must not become different
 * behaviours — and in particular they must share the *question* state. A
 * clarifying question asked after a spoken command has to be answerable by the
 * next utterance regardless of which microphone carried it, which it cannot be
 * if each input owns its own copy.
 *
 * So the pending question lives here, with the runner, rather than in either
 * component.
 */

let pendingChoices = null;

/* The store is loaded on first use rather than imported at the top, so a
 * caller that injects one — a test, or a second workspace later — never
 * constructs the real workspace as a side effect of importing this module. */
let cachedStore = null;
const defaultStore = async () => {
  if (!cachedStore) ({ useStore: cachedStore } = await import('../store/workspace-store.js'));
  return cachedStore;
};

export const getPendingChoices = () => pendingChoices;
export const clearPendingChoices = () => { pendingChoices = null; };

const nameFor = (state, id) => {
  const screen = state.screens.find((candidate) => candidate.id === id);
  if (screen) return screen.name || screen.title || id;
  const agent = (state.agents || []).find((candidate) => candidate.id === id);
  return agent ? agent.name : id;
};

/*
 * Assemble the action surface a command acts through.
 *
 * Every entry is a store action or a workspace action — nothing here does work
 * of its own, which is what keeps a spoken command and a clicked button the
 * same operation rather than two implementations that drift.
 */
export const buildActions = (state, workspaceActions) => ({
  ...workspaceActions,
  connectWindows: state.connectWindows,
  configureConnector: state.configureConnector,
  removeConnector: state.removeConnector,
  setConnectorEnabled: state.setConnectorEnabled,
  connectorsForNode: state.connectorsForNode,
  connectorById: state.connectorById,
  connectorBetween: state.connectorBetween,
  addAgent: state.addAgent,
  removeAgent: state.removeAgent,
  runConnector: (connector) => runConnector(connector, {
    screens: state.screens,
    agents: state.agents || [],
    provider: resolveBrowserProvider(),
    deliver: async () => {}
  }),
  nameFor: (id) => nameFor(state, id)
});

export const buildContext = (state) => ({
  screens: state.screens,
  agents: state.agents || [],
  focusedId: state.selectedScreen,
  /* The open panel first, then the connector just made — "only send the links"
   * is a follow-up, not a fresh command with no subject. */
  focusedConnectorId: state.configuringConnectorId || state.lastConnectorId,
  pendingChoices
});

/*
 * Run one transcript.
 *
 * Returns the result so a caller can react, and reports through the existing
 * toast so voice feedback is the same surface every other action uses.
 */
export const runUtterance = async (transcript, {
  store = null,
  workspaceActions = null,
  announce = null
} = {}) => {
  const text = String(transcript ?? '').trim();
  if (!text) return { handled: false, ok: false, message: null };

  const resolvedStore = store || await defaultStore();
  const state = resolvedStore.getState();
  const actions = buildActions(state, workspaceActions || createWorkspaceActions({ store: resolvedStore }));
  const result = await executeConnectorUtterance(text, buildContext(state), actions);

  /* Carry the question forward, or put it down. A list left standing would
   * swallow the next unrelated command. */
  if (result.needsAnswer && result.choices) pendingChoices = result.choices;
  else if (result.handled) pendingChoices = null;

  const say = announce || ((message) => resolvedStore.getState().showToast(message));
  if (!result.handled) say(`I do not know how to "${text}" yet.`);
  else if (result.message) say(result.message);

  return result;
};

export default runUtterance;
