/*
 * AgentProvider — the contract between a connector and whatever is thinking.
 *
 * Deliberately shaped like BrowserSourceProvider, for the same reason: the
 * workspace must not learn the name of one vendor. Claude, an OpenAI model, a
 * local model, or a person's own account reached through their own key are all
 * adapters behind this interface, and the connector graph cannot tell which it
 * is holding.
 *
 * An agent receives *structured content that a connector was permitted to
 * read*, never a page and never a credential. The permission decision has
 * already happened by the time anything arrives here, which is why this
 * interface has no way to ask for more.
 */

export const AGENT_STATUS = Object.freeze({
  IDLE: 'idle',
  WORKING: 'working',
  ERROR: 'error',
  OFFLINE: 'offline'
});

const notImplemented = (method) => () => Promise.reject(
  new Error(`AgentProvider.${method}() is not implemented by this adapter.`)
);

export class AgentProvider {
  /* A stable identifier for diagnostics, e.g. 'claude', 'openai', 'local'. */
  get id() { return 'abstract'; }

  /* Human name shown on the agent's spatial node. */
  get name() { return 'Agent'; }

  /* Whether this adapter can currently accept work. An adapter with no
   * credentials configured is offline, which is a normal state rather than an
   * error — the node shows as offline instead of failing on first use. */
  get available() { return false; }

  /* What this agent can be asked to do. Connector modes are matched against
   * this so a panel cannot offer Summarize to something that cannot summarize. */
  get capabilities() { return []; }

  /*
   * Do one piece of work.
   *
   * `task` is { mode, instruction, inputs }, where inputs is an array of
   * structured page contents already filtered to what was permitted.
   * Resolves to { ok, output } or { ok: false, code, message }.
   */
  run = notImplemented('run');
}

/*
 * The adapter registry.
 *
 * Adapters register themselves; the graph looks them up by id. Nothing
 * imports a concrete adapter, so a build with no AI configured still runs the
 * whole connector system and simply reports agents as offline.
 */
const adapters = new Map();

export const registerAgentProvider = (provider) => {
  if (!provider || !provider.id) throw new TypeError('An agent provider needs an id.');
  adapters.set(provider.id, provider);
  return () => adapters.delete(provider.id);
};

export const getAgentProvider = (id) => adapters.get(id) || null;

export const listAgentProviders = () => Array.from(adapters.values());

export const resetAgentProviders = () => adapters.clear();

/*
 * An agent node in the workspace.
 *
 * The spatial object a connector can point at. It carries which adapter backs
 * it, so several nodes can share one adapter — "Summarizer" and "Researcher"
 * may both be Claude with different instructions, and the graph treats them as
 * distinct destinations.
 */
export const normalizeAgentNode = (raw) => {
  const input = raw || {};
  return {
    id: input.id || `agent-${Math.random().toString(36).slice(2, 10)}`,
    name: input.name || 'Agent',
    providerId: input.providerId || null,
    instruction: typeof input.instruction === 'string' ? input.instruction : '',
    position: Array.isArray(input.position) ? input.position.slice(0, 3) : [0, 1.5, -2],
    status: Object.values(AGENT_STATUS).includes(input.status) ? input.status : AGENT_STATUS.IDLE,
    createdAt: input.createdAt || new Date().toISOString()
  };
};
