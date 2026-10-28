import { CONNECTION_MODES, NODE_KINDS } from './connector-schema.js';
import { getAgentProvider } from '../agents/agent-provider.js';

/*
 * Making a connector actually carry something.
 *
 * A line becomes a data flow here: read the source with exactly the
 * permissions the connector holds, then deliver the result to the other end.
 * Both ends are uniform — a window and an agent are destinations of the same
 * kind — which is what lets "Research → Claude" and "Research → Comparison"
 * be the same machinery.
 *
 * Two properties are load-bearing:
 *
 *   The capability list travels from the connector to the extractor and is
 *   enforced by the host. Nothing here can widen it; this module has no way to
 *   ask for a category the connector does not hold, which is deliberate.
 *
 *   Delivery is a callback. Where content lands — a store slot a target window
 *   reads, an agent adapter, a future API — is the caller's business, so this
 *   module stays testable and free of transport.
 */

/* A source that can be read. Today a window backed by a browser; the same
 * check is where a PDF or a file source will be admitted later. */
const isReadable = (node) => node.kind === NODE_KINDS.WINDOW;

const sourceIdFor = (screen) => screen?.source?.sourceId || null;

/*
 * Run one connector.
 *
 * Resolves to { ok, delivered, content } or { ok: false, code, message }.
 * It reports rather than throws, because a graph of connectors must survive
 * one page being unreachable.
 */
export const runConnector = async (connector, {
  screens = [],
  agents = [],
  provider,
  deliver = async () => ({ ok: true })
} = {}) => {
  if (!connector) return { ok: false, code: 'NO_CONNECTOR', message: 'No connector was given.' };
  if (connector.enabled === false) {
    return { ok: false, code: 'DISABLED', message: 'That connection is turned off.' };
  }
  if (connector.unconfigured) {
    return {
      ok: false,
      code: 'UNCONFIGURED',
      message: 'That connection has not been told how to connect yet.'
    };
  }

  const mode = CONNECTION_MODES[connector.mode];
  if (!mode) return { ok: false, code: 'UNKNOWN_MODE', message: `Unknown mode ${connector.mode}.` };

  /* Reference is a relationship, not a flow. Running it is a no-op rather than
   * an error: drawing a line to remember a link is a legitimate thing to do. */
  if (connector.mode === 'reference') {
    return { ok: true, delivered: false, code: 'REFERENCE_ONLY' };
  }

  if (!connector.capabilities || connector.capabilities.length === 0) {
    return {
      ok: false,
      code: 'NO_CAPABILITIES',
      message: 'That connection is not permitted to read anything.'
    };
  }

  const source = { id: connector.sourceId, kind: connector.sourceKind };
  const target = { id: connector.targetId, kind: connector.targetKind };

  if (!isReadable(source)) {
    return { ok: false, code: 'SOURCE_NOT_READABLE', message: 'That source cannot be read from.' };
  }

  const sourceScreen = screens.find((screen) => screen.id === source.id);
  if (!sourceScreen) {
    return { ok: false, code: 'SOURCE_MISSING', message: 'The source window is gone.' };
  }

  const browserSourceId = sourceIdFor(sourceScreen);
  if (!browserSourceId) {
    return {
      ok: false,
      code: 'SOURCE_NOT_A_BROWSER',
      message: 'Only browser windows can be read from today.'
    };
  }
  if (!provider || typeof provider.extract !== 'function') {
    return { ok: false, code: 'EXTRACTION_UNAVAILABLE', message: 'No browser provider is connected.' };
  }

  const extracted = await provider.extract(browserSourceId, {
    capabilities: connector.capabilities
  });
  if (!extracted || !extracted.ok) {
    return {
      ok: false,
      code: extracted?.code || 'EXTRACTION_FAILED',
      message: extracted?.message || 'The page could not be read.'
    };
  }

  const payload = {
    connectorId: connector.id,
    mode: connector.mode,
    from: { ...source, name: sourceScreen.name || sourceScreen.title || source.id },
    to: target,
    content: extracted.content,
    truncated: Boolean(extracted.truncated),
    deliveredAt: new Date().toISOString()
  };

  /* An agent end runs the mode as a task; a window end simply receives. Both
   * go through the same deliver() so a caller can record either. */
  if (target.kind === NODE_KINDS.AGENT) {
    const agent = agents.find((candidate) => candidate.id === target.id);
    if (!agent) return { ok: false, code: 'AGENT_MISSING', message: 'That agent is gone.' };

    const adapter = agent.providerId ? getAgentProvider(agent.providerId) : null;
    if (!adapter || !adapter.available) {
      /* Deliver the context anyway. The content was permitted and extracted;
       * an offline model should not discard it, and the node can show that it
       * is holding work it cannot yet do. */
      await deliver({ ...payload, pending: true });
      return {
        ok: false,
        delivered: true,
        code: 'AGENT_OFFLINE',
        message: `${agent.name} is not connected to a model yet.`,
        content: extracted.content
      };
    }

    let result;
    try {
      result = await adapter.run({
        mode: connector.mode,
        instruction: agent.instruction || mode.description,
        inputs: [extracted.content]
      });
    } catch (error) {
      return { ok: false, code: 'AGENT_FAILED', message: error?.message || 'The agent failed.' };
    }
    if (!result || !result.ok) {
      return { ok: false, code: result?.code || 'AGENT_FAILED', message: result?.message || 'The agent failed.' };
    }

    await deliver({ ...payload, output: result.output });
    return { ok: true, delivered: true, content: extracted.content, output: result.output };
  }

  await deliver(payload);
  return { ok: true, delivered: true, content: extracted.content };
};

/*
 * Run every enabled connector leaving a node.
 *
 * Concurrent on purpose: three research windows feeding one agent should cost
 * one page load, not three in series. Each result is reported independently so
 * one unreachable page does not hide the others.
 */
export const runConnectorsFrom = async (nodeId, {
  connectors = [],
  kind = NODE_KINDS.WINDOW,
  ...options
} = {}) => {
  const outgoing = connectors.filter((connector) => (
    connector.sourceId === nodeId
    && connector.sourceKind === kind
    && connector.enabled !== false
    && !connector.unconfigured
    && connector.mode !== 'reference'
  ));

  const results = await Promise.all(
    outgoing.map(async (connector) => ({
      connectorId: connector.id,
      ...(await runConnector(connector, options))
    }))
  );

  return {
    ran: results.length,
    succeeded: results.filter((result) => result.ok).length,
    results
  };
};

/*
 * Everything flowing *into* a node.
 *
 * This is what makes a window a readable destination: content that arrived
 * over a connector is addressable by the window it arrived at, so a second
 * connector out of that window can carry it onward.
 */
export const collectDeliveries = (nodeId, deliveries = []) => (
  deliveries.filter((delivery) => delivery.to?.id === nodeId)
);
