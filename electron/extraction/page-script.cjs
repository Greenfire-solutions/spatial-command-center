'use strict';

/*
 * The script that runs inside a page to describe it.
 *
 * It executes in the remote page's own context, which is the only place that
 * can read a cross-origin document — and is also the reason it is written the
 * way it is. Three rules govern everything below:
 *
 *   1. It reads content, never credentials. No cookies, no storage, no form
 *      values, no password fields, nothing inside a login form. This is not
 *      filtered afterwards; it is never collected. A denylist applied later
 *      only helps if the collector was honest, so the collector is honest.
 *
 *   2. It is bounded. A page can be arbitrarily large and adversarial. Every
 *      list is capped, every string is truncated, and the walk stops at a node
 *      budget, so extraction costs a predictable amount on a page designed to
 *      make it cost an unpredictable one.
 *
 *   3. It returns plain JSON. The result crosses a process boundary, so
 *      anything unserializable is a bug, not a degradation.
 *
 * It always collects everything it is allowed to; the host then returns only
 * the categories a connector was actually granted. Collecting once and
 * filtering after keeps one definition of "what a page contains" rather than
 * one per permission combination.
 */

const LIMITS = Object.freeze({
  textChars: 120_000,
  headings: 300,
  links: 800,
  images: 300,
  videos: 60,
  tables: 20,
  tableRows: 200,
  structuredData: 40,
  nodeBudget: 60_000,
  fieldChars: 2_000
});

/*
 * Serialized verbatim into the page. Written as a single function so it can be
 * read as ordinary code here rather than as an opaque string, and stringified
 * at the bottom of this file.
 */
function extractPageContent(limits) {
  const cap = (value, max) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max) : text;
  };

  const absolute = (url) => {
    if (!url) return '';
    try { return new URL(url, document.baseURI).href; } catch { return ''; }
  };

  /* Schemes that are content, not credentials or code. javascript: is excluded
   * deliberately: forwarding it to an agent that might render or follow it is
   * a real hazard, and it is never information. */
  const safeScheme = (url) => /^(https?:|mailto:|tel:)/i.test(url);

  /*
   * Regions never read, at any depth.
   *
   * Password inputs and their surrounding form are the important entry: a
   * login form's labels and placeholder text are not interesting, and the
   * fields themselves must never be touched.
   */
  const isSensitive = (element) => {
    if (!element || !element.closest) return false;
    if (element.closest('[data-spatial-no-extract]')) return true;
    if (element.closest('form') && element.closest('form').querySelector('input[type="password"]')) return true;
    const tag = element.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
    return false;
  };

  const isHidden = (element) => {
    if (!element || !element.getBoundingClientRect) return false;
    if (element.hidden) return true;
    if (element.getAttribute && element.getAttribute('aria-hidden') === 'true') return true;
    const style = window.getComputedStyle(element);
    if (!style) return false;
    return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
  };

  /* Prefer the page's own idea of its main content, then fall back to body.
   * This is what separates an article from a wall of navigation. */
  const mainRoot = () => document.querySelector('main, [role="main"], article')
    || document.body
    || document.documentElement;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS',
    'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'IFRAME'
  ]);

  const readableText = () => {
    const root = mainRoot();
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (isSensitive(parent)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (isHidden(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const parts = [];
    let length = 0;
    let visited = 0;
    let node = walker.nextNode();
    while (node && length < limits.textChars && visited < limits.nodeBudget) {
      visited += 1;
      const text = node.nodeValue.replace(/\s+/g, ' ').trim();
      if (text) { parts.push(text); length += text.length + 1; }
      node = walker.nextNode();
    }
    return parts.join(' ').slice(0, limits.textChars);
  };

  const headings = () => {
    const found = [];
    const nodes = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const node of nodes) {
      if (found.length >= limits.headings) break;
      if (isSensitive(node) || isHidden(node)) continue;
      const text = cap(node.textContent, 300);
      if (text) found.push({ level: Number(node.tagName[1]), text });
    }
    return found;
  };

  const links = () => {
    const seen = new Set();
    const found = [];
    for (const node of document.querySelectorAll('a[href]')) {
      if (found.length >= limits.links) break;
      if (isSensitive(node)) continue;
      const href = absolute(node.getAttribute('href'));
      if (!href || !safeScheme(href) || seen.has(href)) continue;
      seen.add(href);
      found.push({
        href,
        text: cap(node.textContent, 300),
        rel: cap(node.getAttribute('rel') || '', 60)
      });
    }
    return found;
  };

  const images = () => {
    const seen = new Set();
    const found = [];
    for (const node of document.querySelectorAll('img[src], img[data-src], picture source[srcset]')) {
      if (found.length >= limits.images) break;
      const raw = node.getAttribute('src') || node.getAttribute('data-src')
        || (node.getAttribute('srcset') || '').split(',')[0].trim().split(' ')[0];
      const src = absolute(raw);
      if (!src || seen.has(src)) continue;
      /* Tracking pixels and spacers are not information. */
      const width = Number(node.naturalWidth || node.getAttribute('width') || 0);
      const height = Number(node.naturalHeight || node.getAttribute('height') || 0);
      if (width && height && width <= 2 && height <= 2) continue;
      seen.add(src);
      found.push({ src, alt: cap(node.getAttribute('alt') || '', 300), width, height });
    }
    return found;
  };

  const videos = () => {
    const found = [];
    for (const node of document.querySelectorAll('video')) {
      if (found.length >= limits.videos) break;
      const src = absolute(node.getAttribute('src') || node.querySelector('source')?.getAttribute('src') || '');
      found.push({
        kind: 'video',
        src,
        poster: absolute(node.getAttribute('poster') || ''),
        duration: Number.isFinite(node.duration) ? node.duration : null
      });
    }
    /* Embedded players are videos to a person, so they are videos here. */
    for (const node of document.querySelectorAll('iframe[src]')) {
      if (found.length >= limits.videos) break;
      const src = absolute(node.getAttribute('src'));
      if (!src) continue;
      if (!/youtube|youtu\.be|vimeo|dailymotion|wistia|loom|twitch/i.test(src)) continue;
      found.push({ kind: 'embed', src, poster: '', duration: null });
    }
    return found;
  };

  const metadata = () => {
    const meta = {
      description: '',
      canonical: absolute(document.querySelector('link[rel="canonical"]')?.getAttribute('href') || ''),
      lang: cap(document.documentElement.getAttribute('lang') || '', 20),
      siteName: '',
      author: '',
      publishedAt: '',
      openGraph: {},
      twitter: {}
    };

    for (const node of document.querySelectorAll('meta[name], meta[property]')) {
      const key = (node.getAttribute('property') || node.getAttribute('name') || '').toLowerCase();
      const value = cap(node.getAttribute('content') || '', limits.fieldChars);
      if (!key || !value) continue;
      if (key === 'description') meta.description = value;
      else if (key === 'author') meta.author = value;
      else if (key === 'article:published_time') meta.publishedAt = value;
      else if (key === 'og:site_name') meta.siteName = value;
      else if (key.startsWith('og:')) meta.openGraph[key.slice(3)] = value;
      else if (key.startsWith('twitter:')) meta.twitter[key.slice(8)] = value;
    }
    if (!meta.description && meta.openGraph.description) meta.description = meta.openGraph.description;
    return meta;
  };

  const structuredData = () => {
    const found = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      if (found.length >= limits.structuredData) break;
      try {
        const parsed = JSON.parse(node.textContent || '');
        found.push(parsed);
      } catch {
        /* A malformed block is skipped; one bad script must not lose the rest. */
      }
    }
    return found;
  };

  const tables = () => {
    const found = [];
    for (const table of document.querySelectorAll('table')) {
      if (found.length >= limits.tables) break;
      if (isSensitive(table) || isHidden(table)) continue;
      const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th'))
        .map((cell) => cap(cell.textContent, 200));
      const rows = [];
      for (const row of table.querySelectorAll('tbody tr, tr')) {
        if (rows.length >= limits.tableRows) break;
        const cells = Array.from(row.querySelectorAll('td')).map((cell) => cap(cell.textContent, 200));
        if (cells.length > 0) rows.push(cells);
      }
      if (headers.length > 0 || rows.length > 0) {
        found.push({ headers, rows, caption: cap(table.querySelector('caption')?.textContent || '', 200) });
      }
    }
    return found;
  };

  const selection = () => {
    try {
      const value = window.getSelection?.().toString() || '';
      return cap(value, limits.fieldChars * 4);
    } catch {
      return '';
    }
  };

  const startedAt = Date.now();
  const result = {
    url: location.href,
    title: cap(document.title, 500),
    text: readableText(),
    headings: headings(),
    links: links(),
    images: images(),
    videos: videos(),
    metadata: metadata(),
    structuredData: structuredData(),
    tables: tables(),
    selection: selection(),
    capturedAt: new Date().toISOString(),
    extractionMs: 0
  };
  result.extractionMs = Date.now() - startedAt;
  return result;
}

/* Serialized into the page as an immediately-invoked expression. */
const buildPageScript = (limits = LIMITS) => (
  `(${extractPageContent.toString()})(${JSON.stringify(limits)})`
);

module.exports = { buildPageScript, extractPageContent, LIMITS };
