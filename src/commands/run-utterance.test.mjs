import test from 'node:test';
import assert from 'node:assert/strict';

import { buildActions, buildContext, clearPendingChoices, getPendingChoices, runUtterance } from './run-utterance.js';

/* A store stand-in. The runner's job is to assemble context and actions from
 * whatever the store currently holds, so a fake store is the honest way to
 * exercise it — no scene, no microphone, no browser. */
const makeStore = (overrides = {}) => {
  const calls = [];
  const state = {
    screens: [
      { id: 's1', name: 'Research', title: 'Solar power', source: { type: 'chromium', sourceId: 'b1' } },
      { id: 's2', name: 'Notes', title: 'Notes', source: { type: 'chromium', sourceId: 'b2' } }
    ],
    agents: [{ id: 'agent-claude', name: 'Claude' }],
    selectedScreen: 's1',
    configuringConnectorId: null,
    lastConnectorId: null,
    connections: [],
    showToast: (message) => calls.push(['toast', message]),
    connectWindows: (options) => { calls.push(['connectWindows', options]); return 'c1'; },
    configureConnector: (id, options) => calls.push(['configureConnector', id, options]),
    removeConnector: (id) => calls.push(['removeConnector', id]),
    setConnectorEnabled: (id, on) => calls.push(['setConnectorEnabled', id, on]),
    connectorsForNode: () => [],
    connectorById: () => null,
    connectorBetween: () => null,
    addAgent: (options) => { calls.push(['addAgent', options]); return 'agent-new'; },
    removeAgent: (id) => calls.push(['removeAgent', id]),
    ...overrides
  };
  return { calls, getState: () => state, state };
};

const workspaceActions = {
  addScreen: () => 'new-1',
  removeScreen: () => {},
  duplicateScreen: () => 'dup-1',
  toggleScreenLock: () => {},
  isLocked: () => false,
  renameScreen: () => {},
  updateScreenUrl: () => {},
  setSelectedScreen: () => {},
  focusCameraOnScreen: () => {},
  moveScreen: () => true,
  resizeScreen: () => true,
  applyPreset: () => {},
  arrangeWorkspace: () => {},
  saveCurrent: () => {},
  setInteractionMode: () => {},
  searchWorkspace: async () => []
};

const run = (text, store, announced) => runUtterance(text, {
  store,
  workspaceActions,
  announce: (message) => announced.push(message)
});

test('context is assembled from what the store currently holds', () => {
  const store = makeStore();
  const context = buildContext(store.getState());
  assert.equal(context.focusedId, 's1');
  assert.equal(context.screens.length, 2);
  assert.equal(context.agents.length, 1);
});

test('the open panel outranks the last connector as the subject of a follow-up', () => {
  const open = makeStore({ configuringConnectorId: 'c-open', lastConnectorId: 'c-last' });
  assert.equal(buildContext(open.getState()).focusedConnectorId, 'c-open');

  const closed = makeStore({ configuringConnectorId: null, lastConnectorId: 'c-last' });
  assert.equal(buildContext(closed.getState()).focusedConnectorId, 'c-last');
});

test('every action is a store or workspace action, never work of its own', () => {
  const store = makeStore();
  const actions = buildActions(store.getState(), workspaceActions);
  for (const name of ['connectWindows', 'addAgent', 'addScreen', 'moveScreen', 'searchWorkspace']) {
    assert.equal(typeof actions[name], 'function', `${name} must be reachable`);
  }
  assert.equal(actions.nameFor('s1'), 'Research');
  assert.equal(actions.nameFor('agent-claude'), 'Claude');
});

test('a transcript runs and is announced', async (t) => {
  t.after(clearPendingChoices);
  const store = makeStore();
  const announced = [];
  const result = await run('connect Research to Claude', store, announced);

  assert.equal(result.ok, true);
  assert.ok(store.calls.some(([name]) => name === 'connectWindows'));
  assert.equal(announced.length, 1);
});

test('an empty transcript does nothing at all', async () => {
  const store = makeStore();
  const announced = [];
  const result = await run('   ', store, announced);
  assert.equal(result.handled, false);
  assert.equal(store.calls.length, 0);
  assert.equal(announced.length, 0, 'silence is not a failed command');
});

test('something that is not a command says so rather than failing silently', async (t) => {
  t.after(clearPendingChoices);
  const store = makeStore();
  const announced = [];
  await run('what is the weather today', store, announced);
  assert.match(announced[0], /do not know how to/);
});

/* ---- the property that made this a shared module ---- */

test('a question asked through one microphone is answerable through the other', async (t) => {
  t.after(clearPendingChoices);
  clearPendingChoices();

  const store = makeStore({
    screens: [{ id: 'a', name: 'Docs' }, { id: 'b', name: 'Doc' }],
    agents: []
  });
  const announced = [];

  const asked = await run('kill the docs thing', store, announced);
  if (!asked.needsAnswer) return; // the grammar answered it outright; nothing to carry

  assert.ok(getPendingChoices(), 'the question is held by the runner, not by a component');

  /* A second call — as a different microphone would make — sees the same
   * pending question, because it does not live in either input component. */
  const answered = await run('the first one', store, announced);
  assert.equal(answered.handled, true);
  assert.equal(getPendingChoices(), null, 'and it is put down once answered');
});

test('an unrelated command puts a standing question down', async (t) => {
  t.after(clearPendingChoices);
  clearPendingChoices();

  const store = makeStore({
    screens: [{ id: 'a', name: 'Docs' }, { id: 'b', name: 'Doc' }],
    agents: []
  });
  const announced = [];

  const asked = await run('kill the docs thing', store, announced);
  if (!asked.needsAnswer) return;

  await run('new window', store, announced);
  assert.equal(getPendingChoices(), null, 'a list left standing would swallow the next command');
});
