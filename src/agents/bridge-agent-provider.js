import { AgentProvider, registerAgentProvider } from './agent-provider.js';

/*
 * An agent adapter that lives on the other side of the trust boundary.
 *
 * The renderer never holds an API key. Each adapter in the main process is
 * mirrored here by one of these, which forwards a task over IPC and returns
 * the result. The connector graph sees an ordinary AgentProvider and cannot
 * tell the difference — which is the point: a future in-renderer adapter, a
 * local model, or a different vendor all satisfy the same contract.
 */
export class BridgeAgentProvider extends AgentProvider {
  constructor({ bridge, descriptor }) {
    super();
    this.bridge = bridge;
    this.descriptor = descriptor;
  }

  get id() { return this.descriptor.id; }
  get name() { return this.descriptor.name; }
  get available() { return Boolean(this.descriptor.available); }
  get capabilities() { return this.descriptor.capabilities || []; }

  run = async (task) => {
    if (!this.bridge || typeof this.bridge.runAgent !== 'function') {
      return { ok: false, code: 'NO_BRIDGE', message: 'The agent bridge is unavailable.' };
    }
    try {
      return await this.bridge.runAgent(this.id, task);
    } catch (error) {
      return { ok: false, code: 'AGENT_FAILED', message: error?.message || 'The agent failed.' };
    }
  };
}

/*
 * Discover and register whatever the host offers.
 *
 * Called once at startup. A build with no host bridge, or a host with no
 * adapters configured, simply registers nothing — the connector system runs
 * unchanged and agent nodes report themselves offline, which is the honest
 * state rather than an error.
 */
export const registerHostAgents = async ({ bridge = (typeof window !== 'undefined' ? window.spatialBrowser : null) } = {}) => {
  if (!bridge || typeof bridge.listAgents !== 'function') return [];
  let descriptors;
  try {
    descriptors = await bridge.listAgents();
  } catch {
    return [];
  }
  if (!Array.isArray(descriptors)) return [];

  const registered = [];
  for (const descriptor of descriptors) {
    if (!descriptor || !descriptor.id) continue;
    const provider = new BridgeAgentProvider({ bridge, descriptor });
    registerAgentProvider(provider);
    registered.push(provider);
  }
  return registered;
};

export default BridgeAgentProvider;
