'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ContentExtractor,
  projectContent,
  enforcePayloadBudget,
  NEVER_RETURN,
  MAX_PAYLOAD_BYTES
} = require('../extraction/content-extractor.cjs');
const { buildPageScript } = require('../extraction/page-script.cjs');

const rawPage = () => ({
  url: 'https://example.com/article',
  title: 'Solar power',
  text: 'Photovoltaic cells convert light into electricity.',
  headings: [{ level: 1, text: 'Solar power' }],
  links: [{ href: 'https://example.com/wind', text: 'Wind', rel: '' }],
  images: [{ src: 'https://example.com/panel.jpg', alt: 'A panel', width: 800, height: 600 }],
  videos: [{ kind: 'embed', src: 'https://youtube.com/embed/x', poster: '', duration: null }],
  metadata: { description: 'About solar', openGraph: { title: 'Solar' }, twitter: {} },
  structuredData: [{ '@type': 'Article' }],
  tables: [{ headers: ['Year'], rows: [['2026']], caption: '' }],
  selection: 'convert light',
  capturedAt: '2026-09-02T00:00:00.000Z'
});

/* ---- the permission contract ---- */

test('only granted categories are returned', () => {
  const content = projectContent(rawPage(), ['title', 'links']);

  assert.equal(content.title, 'Solar power');
  assert.deepEqual(content.links.length, 1);
  assert.ok(!('text' in content), 'ungranted text is absent, not empty');
  assert.ok(!('images' in content));
  assert.deepEqual(content.granted, ['title', 'links']);
});

test('absent is distinguishable from empty', () => {
  const empty = { ...rawPage(), links: [] };
  const withLinks = projectContent(empty, ['links']);
  const withoutLinks = projectContent(empty, ['title']);

  assert.deepEqual(withLinks.links, [], 'granted but the page had none');
  assert.equal('links' in withoutLinks, false, 'not granted at all');
});

test('every forbidden category is refused, even asked for directly', () => {
  for (const forbidden of NEVER_RETURN) {
    const content = projectContent(rawPage(), ['title', forbidden]);
    assert.ok(!(forbidden in content), `${forbidden} must never be returned`);
    assert.ok(content.refused.includes(forbidden), `${forbidden} must be reported as refused`);
    assert.equal(content.title, 'Solar power', 'the legitimate request still succeeds');
  }
});

test('a forbidden category cannot ride along inside the raw page object', () => {
  const smuggled = { ...rawPage(), cookies: 'session=abc123', authTokens: ['bearer xyz'] };
  const content = projectContent(smuggled, ['title', 'text', 'metadata']);

  assert.ok(!('cookies' in content));
  assert.ok(!('authTokens' in content));
});

test('an unknown capability is refused rather than passed through', () => {
  const content = projectContent(rawPage(), ['title', 'everything']);
  assert.deepEqual(content.granted, ['title']);
  assert.ok(content.refused.includes('everything'));
});

test('structured data and tables travel together under one permission', () => {
  const content = projectContent(rawPage(), ['structuredData']);
  assert.equal(content.structuredData.length, 1);
  assert.equal(content.tables.length, 1);
});

test('granting nothing returns nothing', () => {
  const content = projectContent(rawPage(), []);
  assert.deepEqual(content.granted, []);
  for (const field of ['title', 'text', 'links', 'images']) {
    assert.ok(!(field in content), `${field} must be absent`);
  }
});

/* ---- bounds ---- */

test('an oversized payload is trimmed rather than refused', () => {
  const huge = {
    ...rawPage(),
    text: 'x'.repeat(MAX_PAYLOAD_BYTES),
    links: Array.from({ length: 5000 }, (_, index) => ({ href: `https://e.com/${index}`, text: 'l', rel: '' }))
  };
  const projected = projectContent(huge, ['text', 'links', 'title']);
  const { content, truncated } = enforcePayloadBudget(projected);

  assert.equal(truncated, true);
  assert.ok(JSON.stringify(content).length <= MAX_PAYLOAD_BYTES);
  assert.equal(content.title, 'Solar power', 'trimming keeps the small, useful fields');
});

test('a payload within budget is untouched', () => {
  const projected = projectContent(rawPage(), ['title', 'text']);
  const { content, truncated } = enforcePayloadBudget(projected);
  assert.equal(truncated, false);
  assert.deepEqual(content, projected);
});

/* ---- the in-page script ---- */

test('the page script is a self-contained expression carrying its limits', () => {
  const script = buildPageScript({ textChars: 1234, links: 7 });
  assert.match(script, /^\(function extractPageContent/);
  assert.match(script, /"textChars":1234/);
  assert.match(script, /"links":7/);
});

test('the page script never reads credentials or storage', () => {
  const script = buildPageScript();
  for (const forbidden of ['document.cookie', 'localStorage', 'sessionStorage', '.value']) {
    assert.ok(!script.includes(forbidden), `the collector must not reference ${forbidden}`);
  }
  assert.ok(script.includes('input[type="password"]'), 'it must recognise login forms to skip them');
});

/* ---- the extractor against a stub source ---- */

const stubManager = ({ loading = false, result = rawPage(), fail = null, destroyed = false } = {}) => ({
  getRecord: (id) => (id === 'missing' ? null : {
    window: {
      isDestroyed: () => destroyed,
      webContents: {
        isDestroyed: () => destroyed,
        isLoading: () => loading,
        executeJavaScript: () => (fail ? Promise.reject(fail) : Promise.resolve(result))
      }
    }
  })
});

test('extracting a real source projects only what was granted', async () => {
  const extractor = new ContentExtractor({ manager: stubManager() });
  const outcome = await extractor.extract('s1', { capabilities: ['title', 'text'] });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.content.sourceId, 's1');
  assert.equal(outcome.content.title, 'Solar power');
  assert.ok(!('links' in outcome.content));
});

test('a missing source is reported, not thrown', async () => {
  const extractor = new ContentExtractor({ manager: stubManager() });
  const outcome = await extractor.extract('missing', { capabilities: ['title'] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'SOURCE_NOT_FOUND');
});

test('a loading page is refused rather than half-read', async () => {
  const extractor = new ContentExtractor({ manager: stubManager({ loading: true }) });
  const outcome = await extractor.extract('s1', { capabilities: ['text'] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'SOURCE_LOADING');
});

test('a connector permitted nothing does not even run the script', async () => {
  let ran = false;
  const manager = stubManager();
  const original = manager.getRecord;
  manager.getRecord = (id) => {
    const record = original(id);
    record.window.webContents.executeJavaScript = () => { ran = true; return Promise.resolve(rawPage()); };
    return record;
  };

  const extractor = new ContentExtractor({ manager });
  const outcome = await extractor.extract('s1', { capabilities: [] });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'NO_CAPABILITIES');
  assert.equal(ran, false, 'a page with no permission is not read at all');
});

test('a page that throws is reported as a failure, not a crash', async () => {
  const extractor = new ContentExtractor({ manager: stubManager({ fail: new Error('detached frame') }) });
  const outcome = await extractor.extract('s1', { capabilities: ['text'] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'EXTRACTION_FAILED');
  assert.match(outcome.message, /detached frame/);
});

test('a page that never answers times out instead of hanging the graph', async () => {
  const manager = {
    getRecord: () => ({
      window: {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isLoading: () => false,
          executeJavaScript: () => new Promise(() => {})
        }
      }
    })
  };
  const extractor = new ContentExtractor({ manager, timeoutMs: 40 });
  const outcome = await extractor.extract('s1', { capabilities: ['text'] });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'EXTRACTION_TIMEOUT');
});

test('an extractor needs a real manager', () => {
  assert.throws(() => new ContentExtractor({}), /BrowserSourceManager is required/);
});
