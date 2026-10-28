import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITIES,
  CONNECTION_MODES,
  DEFAULT_MODE,
  DIRECTIONS,
  FORBIDDEN_CAPABILITIES,
  NODE_KINDS,
  createConnector,
  isDuplicateConnector,
  normalizeCapabilities,
  normalizeConnector
} from './connector-schema.js';

test('a legacy connection normalizes forward without losing what it had', () => {
  const legacy = { id: 'c1', sourceId: 's3', targetId: 's1', agent: 'Context Extractor' };
  const connector = normalizeConnector(legacy);

  assert.equal(connector.id, 'c1');
  assert.equal(connector.sourceId, 's3');
  assert.equal(connector.targetId, 's1');
  assert.equal(connector.agent, 'Context Extractor', 'the cable label survives');
  assert.equal(connector.sourceKind, NODE_KINDS.WINDOW, 'both ends default to windows');
  assert.equal(connector.targetKind, NODE_KINDS.WINDOW);
  assert.equal(connector.enabled, true);
});

test('an upgraded legacy connection cannot read more than it used to', () => {
  const connector = normalizeConnector({ id: 'c1', sourceId: 'a', targetId: 'b' });
  assert.equal(connector.mode, DEFAULT_MODE);
  assert.deepEqual(connector.capabilities, [CAPABILITIES.TITLE, CAPABILITIES.URL]);
  assert.ok(!connector.capabilities.includes(CAPABILITIES.TEXT), 'a migration must not grant page text');
});

test('drawing a line grants the least, not the most', () => {
  const { ok, connector } = createConnector({ sourceId: 'a', targetId: 'b' });
  assert.equal(ok, true);
  assert.equal(connector.mode, 'reference');
  assert.equal(connector.unconfigured, true, 'provisional until the panel is answered');
  assert.ok(!connector.capabilities.includes(CAPABILITIES.TEXT));
});

test('every forbidden category is refused and reported, whatever the mode', () => {
  for (const forbidden of FORBIDDEN_CAPABILITIES) {
    const result = normalizeCapabilities([CAPABILITIES.TEXT, forbidden], 'agent-context');
    assert.ok(result.granted.includes(CAPABILITIES.TEXT));
    assert.ok(!result.granted.includes(forbidden), `${forbidden} must never be granted`);
    assert.ok(result.forbidden.includes(forbidden), `${forbidden} must be reported, not silently dropped`);
  }
});

test('a forbidden category cannot be smuggled in through a connector record', () => {
  const connector = normalizeConnector({
    sourceId: 'a',
    targetId: 'b',
    mode: 'extract',
    capabilities: [CAPABILITIES.TEXT, 'cookies', 'authTokens']
  });
  assert.deepEqual(connector.capabilities, [CAPABILITIES.TEXT]);
});

test('an unknown capability is refused rather than passed through', () => {
  const result = normalizeCapabilities(['text', 'everything'], 'extract');
  assert.deepEqual(result.granted, ['text']);
  assert.deepEqual(result.unknown, ['everything']);
});

test('each mode carries its own default permissions', () => {
  const summarize = normalizeConnector({ sourceId: 'a', targetId: 'b', mode: 'summarize' });
  assert.deepEqual(
    summarize.capabilities,
    [CAPABILITIES.TITLE, CAPABILITIES.TEXT, CAPABILITIES.HEADINGS]
  );

  const reference = normalizeConnector({ sourceId: 'a', targetId: 'b', mode: 'reference' });
  assert.ok(!reference.capabilities.includes(CAPABILITIES.TEXT));
});

test('narrowing to only the links is respected', () => {
  const connector = normalizeConnector({
    sourceId: 'a',
    targetId: 'b',
    mode: 'extract',
    capabilities: [CAPABILITIES.LINKS]
  });
  assert.deepEqual(connector.capabilities, [CAPABILITIES.LINKS]);
});

test('a symmetric mode has no direction to get backwards', () => {
  const compare = normalizeConnector({ sourceId: 'a', targetId: 'b', mode: 'compare', direction: 'forward' });
  assert.equal(compare.direction, DIRECTIONS.BIDIRECTIONAL);

  const summarize = normalizeConnector({ sourceId: 'a', targetId: 'b', mode: 'summarize' });
  assert.equal(summarize.direction, DIRECTIONS.FORWARD);
});

test('an agent can be either end', () => {
  const { ok, connector } = createConnector({
    sourceId: 's3',
    targetId: 'agent-claude',
    targetKind: NODE_KINDS.AGENT,
    mode: 'agent-context'
  });
  assert.equal(ok, true);
  assert.equal(connector.targetKind, NODE_KINDS.AGENT);
  assert.equal(connector.sourceKind, NODE_KINDS.WINDOW);
  assert.ok(connector.capabilities.includes(CAPABILITIES.TEXT));
});

test('a connector needs two distinct ends', () => {
  assert.equal(createConnector({ sourceId: 'a' }).ok, false);
  assert.equal(createConnector({ sourceId: 'a', targetId: 'a' }).ok, false);
  assert.equal(
    createConnector({ sourceId: 'a', targetId: 'a', targetKind: NODE_KINDS.AGENT }).ok,
    true,
    'the same id in different kinds is a different node'
  );
});

test('duplicates are recognised, and mirrored ones only when the mode is symmetric', () => {
  const existing = [normalizeConnector({ sourceId: 'a', targetId: 'b', mode: 'summarize' })];
  const same = normalizeConnector({ sourceId: 'a', targetId: 'b', mode: 'summarize' });
  const mirrored = normalizeConnector({ sourceId: 'b', targetId: 'a', mode: 'summarize' });

  assert.equal(isDuplicateConnector(existing, same), true);
  assert.equal(isDuplicateConnector(existing, mirrored), false, 'B summarizes A is a different relationship');

  const compare = [normalizeConnector({ sourceId: 'a', targetId: 'b', mode: 'compare' })];
  assert.equal(
    isDuplicateConnector(compare, normalizeConnector({ sourceId: 'b', targetId: 'a', mode: 'compare' })),
    true,
    'comparing A with B twice is the same relationship'
  );
});

test('a different mode between the same two windows is a distinct connector', () => {
  const existing = [normalizeConnector({ sourceId: 'a', targetId: 'b', mode: 'summarize' })];
  const analyze = normalizeConnector({ sourceId: 'a', targetId: 'b', mode: 'analyze' });
  assert.equal(isDuplicateConnector(existing, analyze), false);
});

test('the mode table is what the configuration panel can offer', () => {
  for (const mode of Object.values(CONNECTION_MODES)) {
    assert.equal(typeof mode.label, 'string');
    assert.equal(typeof mode.description, 'string');
    assert.ok(Array.isArray(mode.defaultCapabilities));
    const { forbidden } = normalizeCapabilities(mode.defaultCapabilities, mode.id);
    assert.deepEqual(forbidden, [], `${mode.id} must not default to a forbidden capability`);
  }
});

test('an unknown mode falls back rather than throwing', () => {
  const connector = normalizeConnector({ sourceId: 'a', targetId: 'b', mode: 'exfiltrate' });
  assert.equal(connector.mode, DEFAULT_MODE);
});

test('a mode is a ceiling, not merely a starting point', () => {
  const result = normalizeCapabilities([CAPABILITIES.TEXT, CAPABILITIES.IMAGES], 'summarize');
  assert.ok(result.granted.includes(CAPABILITIES.TEXT), 'summarize permits text');
  assert.ok(!result.granted.includes(CAPABILITIES.IMAGES), 'and does not quietly grow to images');
  assert.deepEqual(result.outOfScope, [CAPABILITIES.IMAGES], 'the refusal is reported');
});

test('custom is the deliberate exception, because saying exactly what to read is its purpose', () => {
  const result = normalizeCapabilities(
    [CAPABILITIES.TEXT, CAPABILITIES.IMAGES, CAPABILITIES.VIDEOS],
    'custom'
  );
  assert.deepEqual(result.granted, [CAPABILITIES.TEXT, CAPABILITIES.IMAGES, CAPABILITIES.VIDEOS]);
  assert.deepEqual(result.outOfScope, []);
});

test('the ceiling never admits a forbidden category, even under custom', () => {
  const result = normalizeCapabilities([CAPABILITIES.TEXT, 'cookies'], 'custom');
  assert.deepEqual(result.granted, [CAPABILITIES.TEXT]);
  assert.deepEqual(result.forbidden, ['cookies']);
});
