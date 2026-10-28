import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUtterance } from './registry.js';
import { resolveWindowIntent } from './window-commands.js';
import { resolveNode } from './resolve-node.js';
import { executeWindowIntent } from './execute-window-intent.js';
import { interpret } from './interpret.js';
import { WorkspaceIndex, SEARCH_CAPABILITIES } from './workspace-index.js';

const screens = [
  { id: 's1', name: 'Research', title: 'Solar power', source: { type: 'chromium', sourceId: 'b1' }, locked: false },
  { id: 's2', name: 'Finance', title: 'Dashboard', source: { type: 'chromium', sourceId: 'b2' }, locked: true },
  { id: 's3', name: 'Code', title: 'Editor', source: { type: 'iframe' }, locked: false }
];
const context = { screens, agents: [{ id: 'agent-claude', name: 'Claude' }], focusedId: 's1' };

const makeActions = () => {
  const calls = [];
  return {
    calls,
    addScreen: (options) => { calls.push(['addScreen', options]); return 'new-1'; },
    removeScreen: (id) => calls.push(['removeScreen', id]),
    duplicateScreen: (id) => { calls.push(['duplicateScreen', id]); return 'dup-1'; },
    toggleScreenLock: (id) => calls.push(['toggleScreenLock', id]),
    isLocked: (id) => screens.find((s) => s.id === id)?.locked ?? false,
    renameScreen: (id, name) => calls.push(['renameScreen', id, name]),
    setSelectedScreen: (id) => calls.push(['setSelectedScreen', id]),
    focusCameraOnScreen: (id) => calls.push(['focusCameraOnScreen', id]),
    updateScreenUrl: (id, url) => calls.push(['updateScreenUrl', id, url]),
    moveScreen: (id, direction) => { calls.push(['moveScreen', id, direction]); return true; },
    resizeScreen: (id, factor) => { calls.push(['resizeScreen', id, factor]); return true; },
    applyPreset: (name) => calls.push(['applyPreset', name]),
    arrangeWorkspace: () => calls.push(['arrangeWorkspace']),
    saveCurrent: () => calls.push(['saveCurrent']),
    setInteractionMode: (mode) => calls.push(['setInteractionMode', mode]),
    searchWorkspace: async (query) => { calls.push(['searchWorkspace', query]); return []; }
  };
};

const run = async (utterance, actions, ctx = context) => {
  const parsed = parseUtterance(utterance);
  assert.equal(parsed.ok, true, `should parse: ${utterance}`);
  const resolved = resolveWindowIntent(parsed, ctx, resolveNode);
  assert.equal(resolved.ok, true, `should resolve: ${utterance} (${resolved.reason})`);
  return executeWindowIntent(resolved, actions);
};

/* ---- creating and navigating ---- */

test('a new window can be asked for plainly', async () => {
  const actions = makeActions();
  await run('new window', actions);
  assert.deepEqual(actions.calls[0], ['addScreen', undefined]);
});

test('a new window can be opened on a site', async () => {
  const actions = makeActions();
  await run('open a new window on example.com', actions);
  assert.equal(actions.calls[0][1].url, 'https://example.com/');
});

test('"open youtube" creates a window rather than hunting for one', async () => {
  const actions = makeActions();
  await run('open youtube', actions);
  assert.equal(actions.calls[0][0], 'addScreen');
});

test('"open Research" focuses the window that already exists', async () => {
  const actions = makeActions();
  await run('open Research', actions);
  assert.ok(actions.calls.some(([name, id]) => name === 'setSelectedScreen' && id === 's1'));
});

test('an existing window can be pointed somewhere new', async () => {
  const actions = makeActions();
  await run('open example.com in Research', actions);
  assert.deepEqual(actions.calls[0], ['updateScreenUrl', 's1', 'https://example.com/']);
});

test('an address that is not one is refused rather than opened', () => {
  const parsed = parseUtterance('open a new window on  ');
  /* Either it does not parse as a URL command at all, or it resolves badly —
   * both are acceptable; silently opening something is not. */
  if (parsed.ok && parsed.intent === 'window.create' && parsed.url) {
    const resolved = resolveWindowIntent(parsed, context, resolveNode);
    assert.equal(resolved.ok, false);
  }
});

/* ---- lifecycle ---- */

test('a window can be closed, duplicated and renamed by name', async () => {
  const actions = makeActions();
  await run('close Research', actions);
  await run('duplicate Finance', actions);
  await run('rename Code to Editor', actions);

  assert.deepEqual(actions.calls[0], ['removeScreen', 's1']);
  assert.deepEqual(actions.calls[1], ['duplicateScreen', 's2']);
  assert.deepEqual(actions.calls[2], ['renameScreen', 's3', 'Editor'],
    'a spoken name is stored cased, not as the lowercased utterance');
});

test('locking an already-locked window does not turn it loose', async () => {
  const actions = makeActions();
  const result = await run('lock Finance', actions);
  assert.match(result.message, /already locked/);
  assert.ok(!actions.calls.some(([n]) => n === 'toggleScreenLock'), 'a toggle must not undo an absolute');
});

test('unlocking a locked window does toggle it', async () => {
  const actions = makeActions();
  await run('unlock Finance', actions);
  assert.deepEqual(actions.calls[0], ['toggleScreenLock', 's2']);
});

/* ---- placement ---- */

test('a window can be moved relative to the viewer', async () => {
  const actions = makeActions();
  await run('move Research to my left', actions);
  await run('bring Finance closer', actions);
  await run('push Code away', actions);

  assert.deepEqual(actions.calls[0], ['moveScreen', 's1', 'left']);
  assert.deepEqual(actions.calls[1], ['moveScreen', 's2', 'closer']);
  assert.deepEqual(actions.calls[2], ['moveScreen', 's3', 'farther']);
});

test('a window can be resized', async () => {
  const actions = makeActions();
  await run('make Research bigger', actions);
  assert.equal(actions.calls[0][0], 'resizeScreen');
  assert.ok(actions.calls[0][2] > 1);
});

/* ---- the workspace ---- */

test('layouts are addressable by how people describe them', async () => {
  const actions = makeActions();
  await run('arrange everything for coding', actions);
  await run('put me in a command arc', actions);
  await run('switch to surround', actions);

  assert.deepEqual(actions.calls.map(([, name]) => name), ['Developer', 'CommandArc', 'Surround']);
});

test('the workspace can be tidied, saved, and switched between modes', async () => {
  const actions = makeActions();
  await run('arrange everything', actions);
  await run('save this layout', actions);
  await run('arrange mode', actions);

  assert.deepEqual(actions.calls[0], ['arrangeWorkspace']);
  assert.deepEqual(actions.calls[1], ['saveCurrent']);
  assert.deepEqual(actions.calls[2], ['setInteractionMode', 'arrange']);
});

/* ---- the tolerant layer applies to this family too, for free ---- */

test('a padded, polite workspace command still works', () => {
  const result = interpret('um, could you please close Research', context);
  assert.equal(result.ok, true);
  assert.equal(result.intent.intent, 'window.close');
});

test('a conversational phrasing reaches the grammar', () => {
  const result = interpret('get rid of Finance', context);
  assert.equal(result.ok, true);
  assert.equal(result.intent.intent, 'window.close');
});

test('a guess may focus a window but never close one', () => {
  const focus = interpret('look at the reserch one', context);
  assert.equal(focus.ok, true);
  assert.equal(focus.intent.intent, 'window.focus', 'focusing is safe to act on however it was reached');

  /* A destructive reading is always offered, never performed, however
   * confident the match. */
  const close = interpret('kill the reserch thing', context);
  assert.equal(close.ok, false);
  assert.equal(close.reason, 'choose');
  assert.ok(close.choices.some((choice) => choice.intent === 'window.close'));
});

/* ---- searching what the windows contain ---- */

test('a search reads a deliberately narrow slice of a page', async () => {
  const asked = [];
  const provider = {
    extract: async (sourceId, options) => {
      asked.push(options.capabilities);
      return { ok: true, content: { title: 'Solar power', text: 'photovoltaic panels', headings: [] } };
    }
  };
  const index = new WorkspaceIndex();
  await index.refresh(screens, { provider });

  assert.ok(asked.length > 0);
  for (const capabilities of asked) {
    assert.deepEqual(capabilities, SEARCH_CAPABILITIES);
    assert.ok(!capabilities.includes('links'), 'a search is not an extraction');
    assert.ok(!capabilities.includes('images'));
  }
});

test('only browser windows are indexed', async () => {
  const provider = { extract: async () => ({ ok: true, content: { title: 'x', text: '' } }) };
  const index = new WorkspaceIndex();
  const outcome = await index.refresh(screens, { provider });
  assert.equal(outcome.indexed, 2, 'the iframe screen has no chromium source to read');
});

test('a page that cannot be read is skipped, not fatal', async () => {
  const provider = {
    extract: async (sourceId) => (sourceId === 'b1'
      ? { ok: true, content: { title: 'Solar power', text: 'panels' } }
      : { ok: false, code: 'SOURCE_LOADING' })
  };
  const index = new WorkspaceIndex();
  const outcome = await index.refresh(screens, { provider });
  assert.equal(outcome.indexed, 1);
  assert.equal(outcome.skipped, 2);
});

test('a window is found by what its page says, not only by its name', async () => {
  const provider = {
    extract: async (sourceId) => ({
      ok: true,
      content: sourceId === 'b1'
        ? { title: 'Solar power', text: 'photovoltaic panels convert light', headings: [{ text: 'Panels' }] }
        : { title: 'Dashboard', text: 'quarterly revenue', headings: [] }
    })
  };
  const index = new WorkspaceIndex();
  await index.refresh(screens, { provider });

  const results = index.search('photovoltaic panels', screens);
  assert.equal(results[0].screen.id, 's1');
  assert.ok(['a heading', 'the page text', 'title'].includes(results[0].where));
});

test('a name the user chose outranks a page that merely mentions the word', async () => {
  const provider = {
    extract: async (sourceId) => ({
      ok: true,
      content: sourceId === 'b2'
        ? { title: 'Dashboard', text: 'research research research', headings: [] }
        : { title: 'Solar power', text: '', headings: [] }
    })
  };
  const index = new WorkspaceIndex();
  await index.refresh(screens, { provider });

  const results = index.search('research', screens);
  assert.equal(results[0].screen.id, 's1', 'the window actually called Research wins');
});

test('nothing relevant returns nothing rather than the least-bad window', async () => {
  const index = new WorkspaceIndex();
  assert.deepEqual(index.search('chemistry', screens), []);
});

test('the index expires rather than becoming a durable copy of every page', async () => {
  let clock = 0;
  const provider = { extract: async () => ({ ok: true, content: { title: 'x', text: 'y' } }) };
  const index = new WorkspaceIndex({ ttlMs: 100, now: () => clock });

  await index.refresh([screens[0]], { provider });
  assert.ok(index.fresh('s1'));
  clock = 500;
  assert.equal(index.fresh('s1'), null);
});

test('a decisive search focuses the window; a close call asks', async () => {
  const actions = makeActions();
  actions.searchWorkspace = async () => ([
    { screen: screens[0], score: 0.9, where: 'title' },
    { screen: screens[1], score: 0.3, where: 'the page text' }
  ]);
  const decisive = await executeWindowIntent({ intent: 'workspace.find', query: 'solar' }, actions);
  assert.equal(decisive.ok, true);
  assert.ok(actions.calls.some(([n, id]) => n === 'setSelectedScreen' && id === 's1'));

  const tied = makeActions();
  tied.searchWorkspace = async () => ([
    { screen: screens[0], score: 0.8, where: 'title' },
    { screen: screens[1], score: 0.78, where: 'title' }
  ]);
  const ask = await executeWindowIntent({ intent: 'workspace.find', query: 'dash' }, tied);
  assert.equal(ask.needsAnswer, true);
  assert.ok(!tied.calls.some(([n]) => n === 'setSelectedScreen'));
});

/* ---- the live workspace action surface ---- */

test('a spoken move writes through the same commit path a drag uses', async () => {
  const { createWorkspaceActions } = await import('./window-actions.js');
  const commits = [];
  const object = {
    position: { x: 0, y: 1.5, z: -2, toArray: () => [0, 1.5, -2], addScaledVector() { return this; }, clone() { return { sub: () => ({ length: () => 2, normalize() { return this; } }) }; }, copy() { return this; } },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, setScalar(v) { this.x = v; }, toArray: () => [1, 1, 1] },
    lookAt: () => {}
  };

  const { sceneRuntime } = await import('../systems/scene-runtime.js');
  sceneRuntime.screenObjects.set('s1', object);

  const store = {
    getState: () => ({
      isScreenLocked: () => false,
      commitScreenTransform: (...args) => commits.push(args)
    })
  };

  const actions = createWorkspaceActions({ store });
  actions.resizeScreen('s1', 1.2);

  assert.equal(commits.length, 1);
  const [id, position, rotation, scale] = commits[0];
  assert.equal(id, 's1');
  assert.ok(Array.isArray(position) && Array.isArray(rotation) && Array.isArray(scale),
    'commitScreenTransform takes positional arrays, not an options object');

  sceneRuntime.screenObjects.delete('s1');
});

test('a locked window refuses to be moved or resized', async () => {
  const { createWorkspaceActions } = await import('./window-actions.js');
  const store = { getState: () => ({ isScreenLocked: () => true, commitScreenTransform: () => {} }) };
  const actions = createWorkspaceActions({ store });
  assert.equal(actions.moveScreen('s1', 'left'), 'locked');
  assert.equal(actions.resizeScreen('s1', 1.2), 'locked');
});


test('a multi-word window name is not split at the first "to"', async () => {
  const actions = makeActions();
  const ctx = {
    screens: [{ id: 's9', title: 'Chromium POC', source: { type: 'chromium', sourceId: 'b9' } }],
    agents: []
  };
  await run('rename the Chromium POC to Research', actions, ctx);
  assert.deepEqual(
    actions.calls[0],
    ['renameScreen', 's9', 'Research'],
    'the last "to" is the separator, not the first'
  );
});

test('"call this Notes" renames without a separator', async () => {
  const actions = makeActions();
  await run('call this Notes', actions);
  assert.deepEqual(actions.calls[0], ['renameScreen', 's1', 'Notes']);
});

test('a window that is not in the scene says so, rather than claiming to be locked', async () => {
  const { createWorkspaceActions } = await import('./window-actions.js');
  const store = { getState: () => ({ isScreenLocked: () => false, commitScreenTransform: () => {} }) };
  const actions = createWorkspaceActions({ store });
  assert.equal(actions.moveScreen('not-in-scene', 'left'), 'absent');

  const result = await executeWindowIntent(
    { intent: 'window.move', target: { id: 'not-in-scene', name: 'Ghost' }, direction: 'left' },
    { ...makeActions(), moveScreen: () => 'absent' }
  );
  assert.match(result.message, /not on screen/);
  assert.ok(!/locked/.test(result.message), 'reporting the wrong refusal sends someone hunting for a padlock');
});
