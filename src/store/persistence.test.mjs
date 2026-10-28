import assert from 'node:assert/strict';
import test from 'node:test';

/* A minimal localStorage stand-in so persistence can be tested in Node. */
class MemoryStorage {
  constructor() { this.map = new Map(); this.writes = 0; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.writes += 1; this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

const storage = new MemoryStorage();
globalThis.localStorage = storage;

const { STORAGE_KEY, WORKSPACE_VERSION } = await import('../constants.js');
const {
  flushWorkspaceSave,
  hasPendingWorkspaceSave,
  loadWorkspace,
  migrateWorkspaceRecord,
  scheduleWorkspaceSave,
  writeWorkspace
} = await import('./persistence.js');

const sampleState = () => ({
  screens: [{
    id: 's1',
    title: 'One',
    type: 'browser',
    position: [0, 1, -2],
    rotation: [0, 0, 0, 'YXZ'],
    scale: [1, 1, 1],
    size: [2.2, 1.35],
    url: 'https://example.com/',
    locked: false,
    source: { id: 'source-s1', type: 'iframe', title: 'One', url: 'https://example.com/' }
  }],
  connections: [],
  currentPreset: 'Custom',
  rotationSnap: 15,
  positionSnap: true,
  arcSettings: { radius: 5.5, spacing: 2, height: 1.55, arcAngle: 80 }
});

test('workspace records migrate forward and unknown versions are refused', () => {
  const v1 = { screens: [], connections: [] };
  const migratedV1 = migrateWorkspaceRecord(v1);
  assert.equal(migratedV1.ok, true, 'a pre-versioned record is treated as v1 and migrated');
  assert.equal(migratedV1.record.version, WORKSPACE_VERSION);

  const current = migrateWorkspaceRecord({ version: WORKSPACE_VERSION, screens: [] });
  assert.equal(current.ok, true);

  const future = migrateWorkspaceRecord({ version: WORKSPACE_VERSION + 5, screens: [] });
  assert.equal(future.ok, false, 'a newer format is refused rather than misread');
  assert.match(future.reason, /v\d+/);

  assert.equal(migrateWorkspaceRecord(null).ok, false);
  assert.equal(migrateWorkspaceRecord({ version: 2 }).ok, false, 'a record without screens is invalid');
});

test('an unreadable workspace is archived instead of silently destroyed', () => {
  const hostile = JSON.stringify({ version: 999, screens: [] });
  storage.map.clear();
  storage.setItem(STORAGE_KEY, hostile);

  assert.equal(loadWorkspace(), null, 'falls back to defaults');
  const archived = [...storage.map.entries()].find(([key]) => key.includes('incompatible'));
  assert.ok(archived, 'the incompatible payload is archived');
  assert.equal(archived[1], hostile, 'the archive is byte-identical to what the user had');
});

test('high-frequency saves are coalesced but never lost', async () => {
  storage.map.clear();
  storage.writes = 0;

  // Simulate a continuous drag committing a transform every frame.
  for (let frame = 0; frame < 120; frame += 1) scheduleWorkspaceSave(sampleState());
  assert.equal(storage.writes, 0, 'no synchronous write happens during the gesture');
  assert.equal(hasPendingWorkspaceSave(), true);

  flushWorkspaceSave();
  assert.equal(storage.writes, 1, '120 commits collapse into a single write');
  assert.equal(hasPendingWorkspaceSave(), false);

  const restored = loadWorkspace();
  assert.ok(restored, 'the coalesced write is readable');
  assert.equal(restored.screens.length, 1);
  assert.equal(restored.screens[0].url, 'https://example.com/');
});

test('an explicit save writes through immediately and round-trips', () => {
  storage.map.clear();
  storage.writes = 0;
  assert.equal(writeWorkspace(sampleState()), true);
  assert.equal(storage.writes, 1);

  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(saved.version, WORKSPACE_VERSION, 'the current version is stamped on every save');
  assert.ok(saved.savedAt, 'saves carry a timestamp');

  const restored = loadWorkspace();
  assert.equal(restored.currentPreset, 'Custom');
  assert.equal(restored.rotationSnap, 15);
  assert.equal(restored.positionSnap, true);
});

test('v2 connections migrate into connectors without gaining permissions', () => {
  const v2 = {
    version: 2,
    screens: [],
    connections: [{ id: 'c1', sourceId: 's3', targetId: 's1', agent: 'Context Extractor' }]
  };

  const result = migrateWorkspaceRecord(v2);
  assert.equal(result.ok, true);
  assert.equal(result.record.version, WORKSPACE_VERSION);

  const [connector] = result.record.connections;
  assert.equal(connector.id, 'c1', 'the connector keeps its identity');
  assert.equal(connector.agent, 'Context Extractor', 'and its label');
  assert.equal(connector.sourceKind, 'window');
  assert.equal(connector.targetKind, 'window');
  assert.equal(connector.mode, 'reference');
  assert.deepEqual(
    connector.capabilities,
    ['title', 'url'],
    'an upgrade must never retroactively widen what an existing line may read'
  );
  assert.ok(!connector.capabilities.includes('text'));
});

test('a connector whose window end is gone is dropped, but an agent end is kept', () => {
  const record = {
    version: WORKSPACE_VERSION,
    screens: [{
      id: 's1', title: 'One', type: 'browser',
      position: [0, 1, -2], rotation: [0, 0, 0, 'YXZ'], scale: [1, 1, 1],
      size: [2.2, 1.35], url: 'https://example.com/', locked: false
    }],
    agents: [{ id: 'agent-claude', name: 'Claude' }],
    connections: [
      { id: 'keep', sourceId: 's1', targetId: 'agent-claude', targetKind: 'agent', mode: 'agent-context' },
      { id: 'drop', sourceId: 's1', targetId: 's-missing', mode: 'reference' },
      { id: 'drop-agent', sourceId: 's1', targetId: 'agent-gone', targetKind: 'agent', mode: 'agent-context' }
    ]
  };

  storage.setItem(STORAGE_KEY, JSON.stringify(record));
  const loaded = loadWorkspace();
  const ids = loaded.connections.map((connector) => connector.id);

  assert.deepEqual(
    ids,
    ['keep'],
    'an agent end survives the screen sweep, but an agent that is gone strands its connector just as a closed window does'
  );
});

/* 2026-10-28 buyer test: the default 5-screen layout never saved. Preset
 * connections were stored in the short legacy shape and serializeConnector
 * read .capabilities.slice() off undefined; the error was only logged. */
test('every built-in layout saves and loads back without losing a screen', async () => {
  const { PRESETS, clonePreset } = await import('../presets/workspace-presets.js');
  for (const name of Object.keys(PRESETS)) {
    const preset = clonePreset(name);
    const state = {
      ...preset,
      agents: [],
      currentPreset: name,
      rotationSnap: 15,
      positionSnap: true,
      uiSurface: 'dom',
      arcSettings: { radius: 5.5, spacing: 2, height: 1.55, arcAngle: 80 }
    };
    assert.equal(writeWorkspace(state), true, `${name} layout must save`);
    const loaded = loadWorkspace();
    assert.equal(loaded.screens.length, preset.screens.length, `${name} screens round-trip`);
    assert.equal(loaded.connections.length, preset.connections.length, `${name} connections round-trip`);
    assert.equal(loaded.currentPreset, name);
  }
});

test('a legacy-shaped connector in the store is normalized on save, not fatal', async () => {
  const { serializeConnector } = await import('../connectors/connector-schema.js');
  const out = serializeConnector({ id: 'c1', sourceId: 's1', targetId: 's2', agent: 'x' });
  assert.ok(Array.isArray(out.capabilities));
});

test('a failed save is reported to whoever shows messages, not only logged', async () => {
  const { onWorkspaceSaveError } = await import('./persistence.js');
  const seen = [];
  onWorkspaceSaveError((error) => seen.push(error));
  const original = storage.setItem;
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(writeWorkspace(sampleState()), false);
  } finally {
    storage.setItem = original;
    console.warn = warn;
    onWorkspaceSaveError(null);
  }
  assert.equal(seen.length, 1);
  assert.match(String(seen[0].message), /Quota/);
});
