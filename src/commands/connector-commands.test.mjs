import test from 'node:test';
import assert from 'node:assert/strict';

import { parseConnectorUtterance, resolveConnectorIntent } from './connector-commands.js';
import { describeAmbiguity, resolveNode } from './resolve-node.js';

const screens = [
  { id: 's1', title: 'Wikipedia — Solar power', name: 'Research' },
  { id: 's2', title: 'Claude' },
  { id: 's3', title: 'Finance dashboard', name: 'Finance' },
  { id: 's4', title: 'Editor', name: 'Code' }
];

const agents = [{ id: 'agent-summarizer', name: 'Summarizer' }];
const context = { screens, agents, focusedId: 's1' };

/* ---- resolving what was said to what is in the workspace ---- */

test('a window resolves by the name the user gave it', () => {
  const result = resolveNode('Research', context);
  assert.equal(result.ok, true);
  assert.equal(result.node.id, 's1');
  assert.equal(result.node.kind, 'window');
});

test('a deliberate name beats an incidental match in a page title', () => {
  const withDecoy = {
    screens: [
      { id: 'a', title: 'Solar power research techniques' },
      { id: 'b', name: 'Research', title: 'Untitled' }
    ]
  };
  const result = resolveNode('Research', withDecoy);
  assert.equal(result.ok, true);
  assert.equal(result.node.id, 'b', 'the renamed window wins over a substring in a title');
});

test('an agent resolves the same way a window does', () => {
  const result = resolveNode('Summarizer', context);
  assert.equal(result.ok, true);
  assert.equal(result.node.kind, 'agent');
});

test('"this" means the focused window', () => {
  assert.equal(resolveNode('this', context).node.id, 's1');
  assert.equal(resolveNode('this window', context).node.id, 's1');
  assert.equal(resolveNode('this', { screens }).ok, false, 'with nothing focused it declines');
});

test('a leading article is ignored', () => {
  assert.equal(resolveNode('the Finance', context).node.id, 's3');
});

test('two equally good matches ask rather than guess', () => {
  const twins = { screens: [{ id: 'a', name: 'Docs' }, { id: 'b', name: 'Docs' }] };
  const result = resolveNode('Docs', twins);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  assert.match(describeAmbiguity(result), /Which "Docs" did you mean/);
});

test('an unknown name is reported, not guessed at', () => {
  assert.equal(resolveNode('Chemistry', context).reason, 'not-found');
});

/* ---- parsing what was said ---- */

test('connect X to Y is understood without a model', () => {
  const parsed = parseConnectorUtterance('Connect Research to Claude.');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.intent, 'connector.create');
  assert.equal(parsed.source, 'research');
  assert.equal(parsed.target, 'claude');
  assert.equal(parsed.mode, 'reference', 'a bare connect grants the least');
});

test('the verb can carry the mode', () => {
  assert.equal(parseConnectorUtterance('summarize Research into Claude').mode, 'summarize');
  assert.equal(parseConnectorUtterance('send Finance to Claude').mode, 'send');
  assert.equal(parseConnectorUtterance('compare Research and Finance').mode, 'compare');
  assert.equal(parseConnectorUtterance('watch Finance with Claude').mode, 'monitor');
});

test('a trailing "as" phrase overrides the verb', () => {
  const parsed = parseConnectorUtterance('connect Research to Claude as agent context');
  assert.equal(parsed.mode, 'agent-context');
  assert.equal(parsed.target, 'claude', 'the mode phrase is not left in the name');
});

test('capabilities can be narrowed by voice', () => {
  const parsed = parseConnectorUtterance('connect Research to Claude, only the links and images');
  assert.deepEqual(parsed.capabilities, ['links', 'images']);
  assert.equal(parsed.target, 'claude');
});

test('spoken synonyms for media map onto real capabilities', () => {
  const parsed = parseConnectorUtterance('extract Research to Claude, only the photos and meta data');
  assert.deepEqual(parsed.capabilities.sort(), ['images', 'metadata']);
});

test('disconnect and query forms are recognised', () => {
  const off = parseConnectorUtterance('disconnect Research from Claude');
  assert.equal(off.intent, 'connector.remove');

  const query = parseConnectorUtterance('show me what Research is connected to');
  assert.equal(query.intent, 'connector.list');
  assert.equal(query.source, 'research');
});

test('something that is not a connector command is declined cleanly', () => {
  assert.equal(parseConnectorUtterance('what time is it').ok, false);
  assert.equal(parseConnectorUtterance('').ok, false);
});

/* ---- parse plus resolve ---- */

test('an utterance becomes a resolved intent against the live workspace', () => {
  const resolved = resolveConnectorIntent(
    parseConnectorUtterance('summarize Research into Claude'),
    context
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source.id, 's1');
  assert.equal(resolved.target.id, 's2');
  assert.equal(resolved.mode, 'summarize');
});

test('"connect this to the summarizer" uses focus and reaches an agent', () => {
  const resolved = resolveConnectorIntent(
    parseConnectorUtterance('connect this to Summarizer as agent context'),
    context
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source.id, 's1');
  assert.equal(resolved.target.kind, 'agent');
  assert.equal(resolved.mode, 'agent-context');
});

test('an ambiguous end returns a question instead of a connection', () => {
  const twins = { screens: [{ id: 'a', name: 'Docs' }, { id: 'b', name: 'Docs' }, { id: 'c', name: 'Claude' }] };
  const resolved = resolveConnectorIntent(parseConnectorUtterance('connect Docs to Claude'), twins);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'ambiguous');
  assert.match(resolved.question, /Which "docs"/i);
});

test('connecting something to itself is refused', () => {
  const resolved = resolveConnectorIntent(parseConnectorUtterance('connect Research to Research'), context);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'same-node');
});

test('an unknown name reports which phrase failed', () => {
  const resolved = resolveConnectorIntent(parseConnectorUtterance('connect Research to Chemistry'), context);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'not-found');
  assert.equal(resolved.phrase, 'chemistry');
});

test('both placements of "is" in a query are understood', () => {
  for (const phrase of [
    'what is Research connected to',
    'show me what Research is connected to',
    'show what Research connects to'
  ]) {
    const parsed = parseConnectorUtterance(phrase);
    assert.equal(parsed.intent, 'connector.list', phrase);
    assert.equal(parsed.source, 'research', phrase);
  }
});
