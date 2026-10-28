'use strict';

const { buildPageScript, LIMITS } = require('./page-script.cjs');

/*
 * Structured page content, on the trusted side of the boundary.
 *
 * A connector says what it may read. This is where that is enforced — in the
 * main process, beside validation.cjs, never in the renderer. A permission
 * checked only on the client is a suggestion, and the renderer is the half an
 * attacker reaches first.
 *
 * The shape returned is the one connectors and agents consume:
 *
 *   { sourceId, url, title, text, headings, links, images, videos,
 *     metadata, structuredData, tables, selection, capturedAt, granted }
 *
 * Fields the connector was not granted are absent rather than empty, so a
 * consumer cannot mistake "not permitted" for "the page had none".
 */

/* Which extracted fields each capability unlocks. One table, so adding a
 * capability is a one-line change and there is no second place for the two
 * lists to disagree. */
const CAPABILITY_FIELDS = Object.freeze({
  title: ['title'],
  url: ['url'],
  text: ['text'],
  headings: ['headings'],
  links: ['links'],
  images: ['images'],
  videos: ['videos'],
  metadata: ['metadata'],
  /* Machine-readable content of a page: JSON-LD blocks and rendered tables. */
  structuredData: ['structuredData', 'tables'],
  selection: ['selection']
});

const KNOWN_CAPABILITIES = Object.freeze(Object.keys(CAPABILITY_FIELDS));

/*
 * Categories that are never returned regardless of what was asked for.
 *
 * The page script never collects these, so this is defence in depth rather
 * than the primary control. It exists because the script and this filter will
 * be edited by different people at different times, and the expensive failure
 * is the one where a new collector is added and nobody remembers the contract.
 */
const NEVER_RETURN = Object.freeze([
  'cookies', 'localStorage', 'sessionStorage', 'formValues', 'passwords',
  'credentials', 'authTokens', 'sessionTokens', 'paymentDetails', 'cardNumbers'
]);

/* An upper bound on what crosses the boundary, independent of the in-page
 * caps. A page that defeats one limit should still not be able to hand an
 * agent an unbounded payload. */
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/*
 * Reduce a raw extraction to exactly what was granted.
 *
 * Pure, so the security-relevant half of this module is testable without
 * Electron, without a page, and without a browser.
 */
const projectContent = (raw, capabilities, { sourceId = null } = {}) => {
  const granted = [];
  const refused = [];

  for (const requested of Array.isArray(capabilities) ? capabilities : []) {
    const capability = String(requested);
    if (NEVER_RETURN.includes(capability)) { refused.push(capability); continue; }
    if (!KNOWN_CAPABILITIES.includes(capability)) { refused.push(capability); continue; }
    if (!granted.includes(capability)) granted.push(capability);
  }

  const projected = {
    sourceId,
    capturedAt: raw?.capturedAt || new Date().toISOString(),
    granted: granted.slice(),
    refused
  };

  for (const capability of granted) {
    for (const field of CAPABILITY_FIELDS[capability]) {
      if (raw && Object.prototype.hasOwnProperty.call(raw, field)) {
        projected[field] = raw[field];
      }
    }
  }

  /* Never allow a category to arrive by riding along inside another. */
  for (const forbidden of NEVER_RETURN) delete projected[forbidden];

  return projected;
};

/* Trim the largest fields until the payload fits, rather than refusing it.
 * A truncated article is useful; a rejected extraction is not. */
const enforcePayloadBudget = (content, maxBytes = MAX_PAYLOAD_BYTES) => {
  let serialized = JSON.stringify(content);
  if (serialized.length <= maxBytes) return { content, truncated: false };

  const trimmed = { ...content, truncated: true };
  const order = ['structuredData', 'tables', 'images', 'links', 'videos', 'text'];
  for (const field of order) {
    if (serialized.length <= maxBytes) break;
    if (!(field in trimmed)) continue;
    if (field === 'text' && typeof trimmed.text === 'string') {
      trimmed.text = trimmed.text.slice(0, Math.floor(trimmed.text.length / 2));
    } else if (Array.isArray(trimmed[field])) {
      trimmed[field] = trimmed[field].slice(0, Math.floor(trimmed[field].length / 2));
    }
    serialized = JSON.stringify(trimmed);
  }
  return { content: trimmed, truncated: true };
};

class ContentExtractor {
  /*
   * `manager` is the BrowserSourceManager that owns the real webContents.
   * Injected rather than reached for, so this is testable with a stub and so
   * the extractor never acquires its own way of finding a browser.
   */
  constructor({ manager, timeoutMs = 10_000, logger = console } = {}) {
    if (!manager || typeof manager.getRecord !== 'function') {
      throw new TypeError('A BrowserSourceManager is required.');
    }
    this.manager = manager;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  webContentsFor(sourceId) {
    const record = this.manager.getRecord(sourceId);
    if (!record || !record.window || record.window.isDestroyed?.()) return null;
    const contents = record.window.webContents;
    return contents && !contents.isDestroyed?.() ? contents : null;
  }

  /*
   * Extract from one source.
   *
   * Resolves to { ok, content } or { ok: false, code, message }. It reports
   * rather than throws because an extraction is triggered by a connector, and
   * one unreachable page must not break a graph of them.
   */
  async extract(sourceId, { capabilities = [], limits = LIMITS } = {}) {
    const contents = this.webContentsFor(sourceId);
    if (!contents) {
      return { ok: false, code: 'SOURCE_NOT_FOUND', message: `No browser source called ${sourceId}.` };
    }
    if (contents.isLoading?.()) {
      /* Extracting mid-load yields a half-built document that looks like a
       * thin page rather than an incomplete one. */
      return { ok: false, code: 'SOURCE_LOADING', message: 'The page is still loading.' };
    }

    const requested = Array.isArray(capabilities) ? capabilities : [];
    if (requested.length === 0) {
      return { ok: false, code: 'NO_CAPABILITIES', message: 'This connector is not permitted to read anything.' };
    }

    let raw;
    try {
      raw = await this.withTimeout(
        contents.executeJavaScript(buildPageScript(limits), true),
        this.timeoutMs
      );
    } catch (error) {
      return {
        ok: false,
        code: error?.code === 'TIMEOUT' ? 'EXTRACTION_TIMEOUT' : 'EXTRACTION_FAILED',
        message: error?.message || 'The page could not be read.'
      };
    }

    if (!raw || typeof raw !== 'object') {
      return { ok: false, code: 'EXTRACTION_FAILED', message: 'The page returned nothing usable.' };
    }

    const projected = projectContent(raw, requested, { sourceId });
    const { content, truncated } = enforcePayloadBudget(projected);
    return { ok: true, content, truncated };
  }

  withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Reading the page took longer than ${ms}ms.`);
        error.code = 'TIMEOUT';
        reject(error);
      }, ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }
}

module.exports = {
  ContentExtractor,
  projectContent,
  enforcePayloadBudget,
  CAPABILITY_FIELDS,
  KNOWN_CAPABILITIES,
  NEVER_RETURN,
  MAX_PAYLOAD_BYTES
};
