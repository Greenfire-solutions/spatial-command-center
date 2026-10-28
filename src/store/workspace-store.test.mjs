import assert from 'node:assert/strict';
import test from 'node:test';

/* The store reads localStorage at import time, so the stand-in comes first. */
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}
const storage = new MemoryStorage();
globalThis.localStorage = storage;

const { STORAGE_KEY } = await import('../constants.js');
const { useStore } = await import('./workspace-store.js');

test('a first start opens the neutral Welcome layout, not someone else\'s tools', () => {
  const state = useStore.getState();
  assert.equal(state.currentPreset, 'Welcome');
  assert.equal(state.connections.length, 0);
  for (const screen of state.screens) {
    assert.doesNotMatch(screen.url, /claude\.ai|github\.com|ycombinator|developer\.mozilla/);
  }
  const titles = state.screens.map((screen) => screen.title).join(' ');
  assert.doesNotMatch(titles, /Code Reviewer|Pair Programmer|VS Code|Terminal/);
});

test('pressing Save on the default layout really saves and says so', () => {
  storage.map.clear();
  const ok = useStore.getState().saveCurrent();
  assert.equal(ok, true);
  assert.equal(useStore.getState().toast.message, 'Workspace saved');
  assert.ok(storage.getItem(STORAGE_KEY), 'something was written');
});

test('pressing Save on the 5-screen Developer layout saves too', () => {
  useStore.getState().applyPreset('Developer');
  storage.map.clear();
  assert.equal(useStore.getState().saveCurrent(), true);
  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(saved.screens.length, 5);
  assert.equal(saved.connections.length, 3);
});

test('a save that fails is shown to the person', () => {
  const original = storage.setItem;
  const warn = console.warn;
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  console.warn = () => {};
  try {
    assert.equal(useStore.getState().saveCurrent(), false);
  } finally {
    storage.setItem = original;
    console.warn = warn;
  }
  assert.match(useStore.getState().toast.message, /could not be saved/);
});
