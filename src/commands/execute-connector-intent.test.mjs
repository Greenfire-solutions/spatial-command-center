import test from 'node:test';
import assert from 'node:assert/strict';

import { executeConnectorUtterance } from './execute-connector-intent.js';

const screens = [
  { id: 's1', name: 'Research', title: 'Solar power' },
  { id: 's2', title: 'Claude' },
  { id: 's3', name: 'Finance', title: 'Dashboard' }
];

/* A stand-in for the store actions, recording what the voice path asked for.
 * This is the whole point of the split: the same actions a drag calls. */
const makeActions = (existing = []) => {
  const connectors = existing.slice();
  const calls = [];
  return {
    calls,
    connectors,
    connectWindows: (options) => {
      calls.push(['connectWindows', options]);
      const connector = {
        id: 'c' + (connectors.length + 1),
        sourceId: options.sourceId,
        targetId: options.targetId,
        sourceKind: options.sourceKind,
        targetKind: options.targetKind,
        mode: options.mode || 'reference'
      };
      connectors.push(connector);
      return connector.id;
    },
    configureConnector: (id, options) => { calls.push(['configureConnector', id, options]); return true; },
    removeConnector: (id) => {
      calls.push(['removeConnector', id]);
      const index = connectors.findIndex((connector) => connector.id === id);
      if (index >= 0) connectors.splice(index, 1);
    },
    connectorsForNode: (id) => connectors.filter((c) => c.sourceId === id || c.targetId === id),
    nameFor: (id) => screens.find((screen) => screen.id === id)?.name
      ?? screens.find((screen) => screen.id === id)?.title
      ?? id
  };
};

const context = { screens, agents: [], focusedId: 's1' };

test('a spoken connection calls the same action a drag calls', async () => {
  const actions = makeActions();
  const result = await executeConnectorUtterance('connect Research to Claude', context, actions);

  assert.equal(result.handled, true);
  assert.equal(result.ok, true);
  const [name, options] = actions.calls[0];
  assert.equal(name, 'connectWindows');
  assert.equal(options.sourceId, 's1');
  assert.equal(options.targetId, 's2');
});

test('a bare "connect" leaves the panel to ask, and configures nothing', async () => {
  const actions = makeActions();
  const result = await executeConnectorUtterance('connect Research to Claude', context, actions);
  assert.match(result.message, /How should they be connected\?/);
  assert.ok(
    !actions.calls.some(([name]) => name === 'configureConnector'),
    'saying only "connect" must not grant a mode the user did not choose'
  );
});

test('naming the mode answers the question in the same breath', async () => {
  const actions = makeActions();
  const result = await executeConnectorUtterance('summarize Research into Claude', context, actions);
  assert.equal(result.ok, true);
  assert.match(result.message, /Summarize/);
  const configure = actions.calls.find(([name]) => name === 'configureConnector');
  assert.ok(configure, 'a stated mode is applied');
  assert.equal(configure[2].mode, 'summarize');
});

test('narrowing by voice reaches configureConnector', async () => {
  const actions = makeActions();
  await executeConnectorUtterance('extract Research to Claude, only the links', context, actions);
  const configure = actions.calls.find(([name]) => name === 'configureConnector');
  assert.deepEqual(configure[2].capabilities, ['links']);
});

test('"connect this to Claude" uses the focused window', async () => {
  const actions = makeActions();
  await executeConnectorUtterance('connect this to Claude', context, actions);
  assert.equal(actions.calls[0][1].sourceId, 's1');
});

test('an ambiguous name asks instead of connecting', async () => {
  const twins = { screens: [{ id: 'a', name: 'Docs' }, { id: 'b', name: 'Docs' }, { id: 'c', name: 'Claude' }] };
  const actions = makeActions();
  const result = await executeConnectorUtterance('connect Docs to Claude', twins, actions);

  assert.equal(result.ok, false);
  assert.equal(result.needsAnswer, true);
  assert.match(result.message, /Which "docs"/i);
  assert.equal(actions.calls.length, 0, 'nothing is connected while the question is open');
});

test('an unknown window is named in the reply', async () => {
  const actions = makeActions();
  const result = await executeConnectorUtterance('connect Research to Chemistry', context, actions);
  assert.equal(result.ok, false);
  assert.match(result.message, /could not find a window called "chemistry"/i);
  assert.equal(actions.calls.length, 0);
});

test('a non-connector utterance is passed on rather than swallowed', async () => {
  const actions = makeActions();
  const result = await executeConnectorUtterance('what time is it', context, actions);
  assert.equal(result.handled, false, 'other command families must still get a chance');
  assert.equal(actions.calls.length, 0);
});

test('disconnecting removes the connector that actually joins the two', async () => {
  const actions = makeActions([
    { id: 'c1', sourceId: 's1', targetId: 's2', mode: 'summarize' },
    { id: 'c2', sourceId: 's1', targetId: 's3', mode: 'reference' }
  ]);
  const result = await executeConnectorUtterance('disconnect Research from Claude', context, actions);

  assert.equal(result.ok, true);
  assert.deepEqual(actions.calls, [['removeConnector', 'c1']]);
  assert.deepEqual(actions.connectors.map((c) => c.id), ['c2'], 'the unrelated connector survives');
});

test('disconnecting things that are not connected says so', async () => {
  const actions = makeActions();
  const result = await executeConnectorUtterance('disconnect Research from Claude', context, actions);
  assert.equal(result.ok, false);
  assert.match(result.message, /are not connected/);
});

test('asking what something is connected to reports the modes', async () => {
  const actions = makeActions([
    { id: 'c1', sourceId: 's1', targetId: 's2', mode: 'summarize' }
  ]);
  const result = await executeConnectorUtterance('what is Research connected to', context, actions);
  assert.equal(result.ok, true);
  assert.match(result.message, /Claude \(Summarize\)/);
});

test('asking about an unconnected window is answered, not treated as an error', async () => {
  const actions = makeActions();
  const result = await executeConnectorUtterance('what is Research connected to', context, actions);
  assert.equal(result.ok, true);
  assert.match(result.message, /not connected to anything/);
});

/* ---- acting on connectors that already exist ---- */

const withConnector = (overrides = {}) => {
  const connector = {
    id: 'c1',
    sourceId: 's1',
    targetId: 's2',
    sourceKind: 'window',
    targetKind: 'window',
    mode: 'extract',
    capabilities: ['title', 'url', 'text', 'headings', 'links', 'images'],
    enabled: true,
    unconfigured: false,
    ...overrides
  };
  const actions = makeActions([connector]);
  actions.connectorById = (id) => (id === connector.id ? connector : null);
  actions.connectorBetween = (source, target) => (
    (connector.sourceId === source.id && connector.targetId === target.id)
      ? connector
      : null
  );
  actions.setConnectorEnabled = (id, enabled) => actions.calls.push(['setConnectorEnabled', id, enabled]);
  actions.runConnector = async (c) => { actions.calls.push(['runConnector', c.id]); return { ok: true }; };
  actions.addAgent = (options) => { actions.calls.push(['addAgent', options]); return 'agent-new'; };
  actions.removeAgent = (id) => actions.calls.push(['removeAgent', id]);
  return { connector, actions };
};

const focused = (actions, connectorId = 'c1') => ({ ...context, focusedConnectorId: connectorId });

test('a connection can be turned off by voice', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('turn off this connection', focused(actions), actions);
  assert.equal(result.ok, true);
  assert.deepEqual(actions.calls.find(([n]) => n === 'setConnectorEnabled'), ['setConnectorEnabled', 'c1', false]);
});

test('a connection can be turned back on', async () => {
  const { actions } = withConnector({ enabled: false });
  const result = await executeConnectorUtterance('turn on this connection', focused(actions), actions);
  assert.equal(result.ok, true);
  assert.deepEqual(actions.calls.find(([n]) => n === 'setConnectorEnabled'), ['setConnectorEnabled', 'c1', true]);
});

test('the mode of an existing connection can be changed, and the reply says what it now reads', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('make this connection a summary', focused(actions), actions);
  assert.equal(result.ok, true);
  const configure = actions.calls.find(([n]) => n === 'configureConnector');
  assert.equal(configure[2].mode, 'summarize');
  assert.match(result.message, /Summarize/);
  assert.match(result.message, /readable text/);
});

test('"only send the links" narrows an existing permission', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('only send the links', focused(actions), actions);
  const configure = actions.calls.find(([n]) => n === 'configureConnector');
  assert.deepEqual(configure[2].capabilities, ['links']);
  assert.match(result.message, /Now reads links/);
});

test('"also send the images" widens rather than replaces', async () => {
  const { actions } = withConnector({ capabilities: ['text'] });
  await executeConnectorUtterance('also send the images', focused(actions), actions);
  const configure = actions.calls.find(([n]) => n === 'configureConnector');
  assert.deepEqual(configure[2].capabilities, ['text', 'images']);
});

test('"stop sending images" removes just that one', async () => {
  const { actions } = withConnector({ capabilities: ['text', 'images', 'links'] });
  await executeConnectorUtterance('stop sending images', focused(actions), actions);
  const configure = actions.calls.find(([n]) => n === 'configureConnector');
  assert.deepEqual(configure[2].capabilities, ['text', 'links']);
});

test('a spoken widening cannot reach past what the mode allows', async () => {
  const { actions } = withConnector({ mode: 'reference', capabilities: ['title', 'url'] });
  const result = await executeConnectorUtterance('also send the readable text', focused(actions), actions);

  /* Reference permits title and url. Asking for text is refused and said out
   * loud — quietly applying an empty change would tell the user the opposite
   * of what happened. */
  assert.equal(result.ok, false);
  assert.match(result.message, /cannot read readable text/i);
  assert.ok(!actions.calls.some(([n]) => n === 'configureConnector'));
});

test('removing every capability is allowed and reported honestly', async () => {
  const { actions } = withConnector({ capabilities: ['links'] });
  const result = await executeConnectorUtterance('stop sending links', focused(actions), actions);
  assert.match(result.message, /reads nothing/);
});

test('a command about "this connection" with none in hand asks rather than guessing', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('turn off this connection', context, actions);
  assert.equal(result.ok, false);
  assert.match(result.message, /do not know which connection/);
  assert.equal(actions.calls.length, 0);
});

test('running everything that leaves a window sends each connection', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('extract everything from Research', context, actions);
  assert.equal(result.ok, true);
  assert.deepEqual(actions.calls.find(([n]) => n === 'runConnector'), ['runConnector', 'c1']);
});

test('running a window with nothing to carry it says so', async () => {
  const actions = makeActions([]);
  actions.runConnector = async () => ({ ok: true });
  const result = await executeConnectorUtterance('extract everything from Research', context, actions);
  assert.equal(result.ok, false);
  assert.match(result.message, /not connected to anything/);
});

test('a reference connection is not run by a bulk send', async () => {
  const { actions } = withConnector({ mode: 'reference' });
  const result = await executeConnectorUtterance('extract everything from Research', context, actions);
  assert.equal(result.ok, false);
  assert.ok(!actions.calls.some(([n]) => n === 'runConnector'));
});

/* ---- agents ---- */

test('an agent can be created by name', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('create an agent called Summarizer', context, actions);
  assert.equal(result.ok, true);
  assert.equal(actions.calls.find(([n]) => n === 'addAgent')[1].name, 'Summarizer');
  assert.match(result.message, /no model connected yet/);
});

test('a descriptive phrasing also creates one', async () => {
  const { actions } = withConnector();
  await executeConnectorUtterance('add a research agent', context, actions);
  assert.equal(actions.calls.find(([n]) => n === 'addAgent')[1].name, 'Research');
});

test('an agent can be removed by name', async () => {
  const { actions } = withConnector();
  const withAgent = { ...context, agents: [{ id: 'agent-1', name: 'Summarizer' }] };
  const result = await executeConnectorUtterance('remove the Summarizer agent', withAgent, actions);
  assert.equal(result.ok, true);
  assert.deepEqual(actions.calls.find(([n]) => n === 'removeAgent'), ['removeAgent', 'agent-1']);
});

test('asking to remove a window as an agent is refused rather than deleting it', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('remove the Research agent', context, actions);
  assert.equal(result.ok, false);
  assert.match(result.message, /is a window, not an agent/);
  assert.ok(!actions.calls.some(([n]) => n === 'removeAgent'));
});

/* ---- tolerant interpretation ---- */

test('a polite, padded command still connects', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance(
    'um, could you please connect Research to Claude',
    context,
    actions
  );
  assert.equal(result.handled, true);
  assert.equal(result.ok, true);
});

test('a conversational phrasing still connects', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('hook research up to claude', context, actions);
  assert.equal(result.ok, true);
  const call = actions.calls.find(([n]) => n === 'connectWindows');
  assert.equal(call[1].sourceId, 's1');
});

test('a sentence matching no rule is still understood from its pieces', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance(
    'put the research window into claude',
    context,
    actions
  );
  assert.equal(result.handled, true);
  assert.equal(result.ok, true);
  const call = actions.calls.find(([n]) => n === 'connectWindows');
  assert.equal(call[1].sourceId, 's1');
  assert.equal(call[1].targetId, 's2');
});

test('a mangled name is recovered rather than refused', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('connect reserch to cloud', context, actions);
  assert.equal(result.ok, true);
});

test('something that is not a command at all is still passed on', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('what is the weather today', context, actions);
  assert.equal(result.handled, false);
  assert.equal(actions.calls.length, 0);
});

/* ---- being asked, and answering ---- */

const closeCall = {
  screens: [{ id: 'a', name: 'Docs' }, { id: 'b', name: 'Doc' }],
  agents: []
};

test('when two readings are close the user is offered a numbered list', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('connect docs and doc', closeCall, actions);
  if (result.needsAnswer) {
    assert.ok(Array.isArray(result.choices) && result.choices.length >= 2);
    assert.match(result.message, /1\./);
    assert.equal(actions.calls.length, 0, 'nothing happens while the question is open');
  }
});

test('an offered choice is carried out when answered by position', async () => {
  const { actions } = withConnector();
  const choices = [
    { intent: 'connector.create', source: { id: 's1', kind: 'window', name: 'Research' },
      target: { id: 's2', kind: 'window', name: 'Notes' }, mode: 'summarize', label: 'Connect Research to Notes' },
    { intent: 'connector.run', source: { id: 's1', kind: 'window', name: 'Research' },
      label: 'Send everything from Research' }
  ];
  const result = await executeConnectorUtterance('the first one', { ...context, pendingChoices: choices }, actions);
  assert.equal(result.ok, true);
  const call = actions.calls.find(([n]) => n === 'connectWindows');
  assert.equal(call[1].mode, 'summarize');
});

test('an offered choice can be declined', async () => {
  const { actions } = withConnector();
  const choices = [{ intent: 'connector.run', source: { id: 's1', kind: 'window', name: 'Research' }, label: 'x' }];
  const result = await executeConnectorUtterance('no, never mind', { ...context, pendingChoices: choices }, actions);
  assert.equal(result.clearChoices, true);
  assert.equal(actions.calls.length, 0);
});

test('a new command while a question is open is treated as a new command', async () => {
  const { actions } = withConnector();
  const choices = [{ intent: 'connector.run', source: { id: 's1', kind: 'window', name: 'Research' }, label: 'x' }];
  const result = await executeConnectorUtterance(
    'connect Research to Claude',
    { ...context, pendingChoices: choices },
    actions
  );
  assert.equal(result.ok, true);
  assert.ok(actions.calls.some(([n]) => n === 'connectWindows'));
});

test('asking for something the mode forbids is refused, not silently emptied', async () => {
  const { actions } = withConnector({ mode: 'reference', capabilities: ['title', 'url'] });
  const result = await executeConnectorUtterance('only send the links', focused(actions), actions);

  assert.equal(result.ok, false);
  assert.match(result.message, /cannot read links/i);
  assert.match(result.message, /make this connection an extract/i, 'and says what would fix it');
  assert.ok(
    !actions.calls.some(([n]) => n === 'configureConnector'),
    'a refused change must not be applied as an empty one'
  );
});

test('a spoken agent name is stored and reported cased', async () => {
  const { actions } = withConnector();
  const result = await executeConnectorUtterance('create an agent called summarizer', context, actions);
  assert.equal(actions.calls.find(([n]) => n === 'addAgent')[1].name, 'Summarizer');
  assert.match(result.message, /Added Summarizer/);
});
