import test from 'node:test';
import assert from 'node:assert/strict';

import { runConnector, runConnectorsFrom, collectDeliveries } from './connector-flow.js';
import { createConnector, normalizeConnector } from './connector-schema.js';
import {
  AgentProvider,
  normalizeAgentNode,
  registerAgentProvider,
  resetAgentProviders
} from '../agents/agent-provider.js';

const screens = [
  {
    id: 's1',
    name: 'Research',
    title: 'Solar power',
    source: { sourceId: 'browser-s1', type: 'chromium' }
  },
  {
    id: 's2',
    name: 'Notes',
    title: 'Notes',
    source: { sourceId: 'browser-s2', type: 'chromium' }
  }
];

/* A provider that records exactly which capabilities it was asked for. That
 * assertion is the point: the connector's permission must be what reaches the
 * host, unmodified. */
const makeProvider = (result) => {
  const asked = [];
  return {
    asked,
    extract: async (sourceId, options) => {
      asked.push({ sourceId, capabilities: options.capabilities });
      return result ?? {
        ok: true,
        content: { sourceId, title: 'Solar power', text: 'Photovoltaic cells.', granted: options.capabilities }
      };
    }
  };
};

const configured = (overrides) => normalizeConnector({
  sourceId: 's1',
  targetId: 's2',
  mode: 'send',
  unconfigured: false,
  ...overrides
});

test('a connector carries exactly the permissions it holds', async () => {
  const provider = makeProvider();
  const delivered = [];
  const connector = configured({ mode: 'extract', capabilities: ['text', 'links'] });

  const result = await runConnector(connector, {
    screens, provider, deliver: async (payload) => { delivered.push(payload); }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(provider.asked[0].capabilities, ['text', 'links']);
  assert.equal(provider.asked[0].sourceId, 'browser-s1', 'the browser source id, not the screen id');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].from.name, 'Research');
});

test('a freshly drawn connector carries nothing until the panel is answered', async () => {
  const provider = makeProvider();
  /* Through the real creation path — a drawn line is provisional, and that is
   * what must refuse to read a page. */
  const { connector } = createConnector({ sourceId: 's1', targetId: 's2' });
  assert.equal(connector.unconfigured, true);

  const result = await runConnector(connector, { screens, provider });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNCONFIGURED');
  assert.equal(provider.asked.length, 0, 'an unanswered panel must not read a page');
});

test('a disabled connector carries nothing', async () => {
  const provider = makeProvider();
  const result = await runConnector(configured({ enabled: false }), { screens, provider });
  assert.equal(result.code, 'DISABLED');
  assert.equal(provider.asked.length, 0);
});

test('a Reference connector is a relationship, not a flow', async () => {
  const provider = makeProvider();
  const result = await runConnector(configured({ mode: 'reference' }), { screens, provider });

  assert.equal(result.ok, true, 'drawing a line to remember a link is legitimate');
  assert.equal(result.delivered, false);
  assert.equal(provider.asked.length, 0, 'and it reads nothing');
});

test('a connector permitted nothing does not read the page', async () => {
  const provider = makeProvider();
  const result = await runConnector(configured({ mode: 'custom', capabilities: [] }), {
    screens, provider
  });
  assert.equal(result.code, 'NO_CAPABILITIES');
  assert.equal(provider.asked.length, 0);
});

test('a failed extraction is reported, not thrown', async () => {
  const provider = makeProvider({ ok: false, code: 'SOURCE_LOADING', message: 'still loading' });
  const result = await runConnector(configured(), { screens, provider });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_LOADING');
});

test('a vanished source window is reported', async () => {
  const result = await runConnector(configured({ sourceId: 'gone' }), {
    screens, provider: makeProvider()
  });
  assert.equal(result.code, 'SOURCE_MISSING');
});

/* ---- agents ---- */

class StubAgent extends AgentProvider {
  constructor({ id = 'stub', available = true, output = 'A summary.' } = {}) {
    super();
    this._id = id;
    this._available = available;
    this._output = output;
    this.received = [];
  }
  get id() { return this._id; }
  get name() { return 'Stub'; }
  get available() { return this._available; }
  run = async (task) => {
    this.received.push(task);
    return { ok: true, output: this._output };
  };
}

test('content reaches an agent as a task, and the answer comes back', async (t) => {
  t.after(resetAgentProviders);
  const agentProvider = new StubAgent();
  registerAgentProvider(agentProvider);

  const agents = [normalizeAgentNode({ id: 'agent-claude', name: 'Claude', providerId: 'stub' })];
  const delivered = [];
  const connector = configured({
    targetId: 'agent-claude',
    targetKind: 'agent',
    mode: 'summarize'
  });

  const result = await runConnector(connector, {
    screens, agents, provider: makeProvider(), deliver: async (p) => { delivered.push(p); }
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, 'A summary.');
  assert.equal(agentProvider.received[0].mode, 'summarize');
  assert.equal(agentProvider.received[0].inputs.length, 1);
  assert.equal(delivered[0].output, 'A summary.');
});

test('an agent with no model still receives its context rather than losing it', async (t) => {
  t.after(resetAgentProviders);
  const agents = [normalizeAgentNode({ id: 'agent-x', name: 'Researcher', providerId: null })];
  const delivered = [];

  const result = await runConnector(
    configured({ targetId: 'agent-x', targetKind: 'agent', mode: 'analyze' }),
    { screens, agents, provider: makeProvider(), deliver: async (p) => { delivered.push(p); } }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_OFFLINE');
  assert.equal(result.delivered, true, 'permitted content that was already read is not discarded');
  assert.equal(delivered[0].pending, true);
});

test('nothing imports a concrete vendor — an unregistered adapter is simply offline', async (t) => {
  t.after(resetAgentProviders);
  const agents = [normalizeAgentNode({ id: 'agent-y', name: 'Claude', providerId: 'not-registered' })];
  const result = await runConnector(
    configured({ targetId: 'agent-y', targetKind: 'agent', mode: 'summarize' }),
    { screens, agents, provider: makeProvider(), deliver: async () => {} }
  );
  assert.equal(result.code, 'AGENT_OFFLINE');
});

/* ---- a graph, not a single line ---- */

test('every connector out of a window runs, and one failure does not hide the rest', async () => {
  const provider = {
    extract: async (sourceId) => (sourceId === 'browser-s1'
      ? { ok: true, content: { text: 'ok' } }
      : { ok: false, code: 'SOURCE_LOADING', message: 'loading' })
  };
  const connectors = [
    configured({ id: 'a', sourceId: 's1', targetId: 's2', mode: 'send' }),
    configured({ id: 'b', sourceId: 's1', targetId: 's2', mode: 'summarize' }),
    configured({ id: 'c', sourceId: 's2', targetId: 's1', mode: 'send' })
  ];

  const summary = await runConnectorsFrom('s1', { connectors, screens, provider, deliver: async () => {} });

  assert.equal(summary.ran, 2, 'only connectors leaving s1');
  assert.equal(summary.succeeded, 2);
  assert.deepEqual(summary.results.map((r) => r.connectorId).sort(), ['a', 'b']);
});

test('unconfigured and reference connectors are skipped by a bulk run', async () => {
  const connectors = [
    normalizeConnector({ id: 'a', sourceId: 's1', targetId: 's2', mode: 'send', unconfigured: true }),
    configured({ id: 'b', sourceId: 's1', targetId: 's2', mode: 'reference' }),
    configured({ id: 'c', sourceId: 's1', targetId: 's2', mode: 'send' })
  ];
  const summary = await runConnectorsFrom('s1', {
    connectors, screens, provider: makeProvider(), deliver: async () => {}
  });
  assert.equal(summary.ran, 1);
  assert.equal(summary.results[0].connectorId, 'c');
});

test('what arrived at a window is addressable, so it can travel on', async () => {
  const deliveries = [
    { connectorId: 'a', to: { id: 's2', kind: 'window' }, content: { text: 'one' } },
    { connectorId: 'b', to: { id: 's3', kind: 'window' }, content: { text: 'two' } }
  ];
  const atS2 = collectDeliveries('s2', deliveries);
  assert.equal(atS2.length, 1);
  assert.equal(atS2[0].content.text, 'one');
});
