import { rank, similarity } from './fuzzy.js';

/*
 * Searching what the windows actually contain.
 *
 * "Find the window about solar panels" cannot be answered from names and page
 * titles alone — the useful thing is usually inside the page. So the index
 * asks the same extractor a connector uses, and ranks windows by what came
 * back.
 *
 * The permission question is different here and worth being explicit about,
 * because it would be easy to get quietly wrong. A connector is a standing
 * grant between two things: it persists, it can feed an agent, and it is
 * therefore configured deliberately. A search is a single first-party action
 * the user just asked for, against their own windows, whose result never
 * leaves the workspace. So it reads a deliberately narrow set — title, url,
 * headings, and text — never links, images, or structured data, and never
 * anything the extractor refuses by construction.
 *
 * Nothing is persisted. The index lives in memory for the session and expires,
 * because a durable copy of every page someone has opened is a different and
 * much heavier promise than a search box.
 */

/* What a search is allowed to read. Narrower than any connector mode: enough
 * to find a page, not enough to reconstruct it. */
export const SEARCH_CAPABILITIES = Object.freeze(['title', 'url', 'text', 'headings']);

const DEFAULT_TTL_MS = 60_000;
/* Only the opening of a page is kept. A match is for locating a window, not
 * for reading it, and holding whole documents in memory for a search box is
 * the wrong trade. */
const SNIPPET_CHARS = 4_000;

export class WorkspaceIndex {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.entries = new Map();
    this.ttlMs = ttlMs;
    this.now = now;
  }

  fresh(screenId) {
    const entry = this.entries.get(screenId);
    return entry && (this.now() - entry.at) < this.ttlMs ? entry : null;
  }

  put(screenId, content) {
    this.entries.set(screenId, {
      at: this.now(),
      title: content.title || '',
      url: content.url || '',
      headings: (content.headings || []).map((heading) => heading.text).filter(Boolean),
      text: String(content.text || '').slice(0, SNIPPET_CHARS)
    });
  }

  forget(screenId) { this.entries.delete(screenId); }
  clear() { this.entries.clear(); }

  /*
   * Bring the index up to date for the windows given.
   *
   * Extraction failures are not errors here: a page still loading, or one that
   * refuses, simply is not searchable this time. A search that fails because
   * one of six windows was busy would be worse than one that searches five.
   */
  async refresh(screens, { provider, force = false } = {}) {
    if (!provider || typeof provider.extract !== 'function') return { indexed: 0, skipped: screens.length };

    let indexed = 0;
    let skipped = 0;

    await Promise.all(screens.map(async (screen) => {
      const sourceId = screen.source?.sourceId;
      if (!sourceId || screen.source?.type !== 'chromium') { skipped += 1; return; }
      if (!force && this.fresh(screen.id)) { indexed += 1; return; }

      const result = await provider.extract(sourceId, { capabilities: SEARCH_CAPABILITIES });
      if (!result || !result.ok) { skipped += 1; return; }
      this.put(screen.id, result.content);
      indexed += 1;
    }));

    return { indexed, skipped };
  }

  /*
   * Rank windows against a query.
   *
   * Weighted by where the match was found: a name the user chose is the
   * strongest signal of intent, then the page's own title, then its headings,
   * then its body. A window called "Research" should win "find research" over
   * a page that merely says the word a hundred times.
   */
  search(query, screens, { limit = 5, threshold = 0.3 } = {}) {
    const phrase = String(query ?? '').trim();
    if (!phrase) return [];

    const results = [];
    for (const screen of screens) {
      const entry = this.entries.get(screen.id);
      const name = screen.name || '';
      const title = entry?.title || screen.title || '';

      const nameScore = name ? similarity(phrase, name) : 0;
      const titleScore = title ? similarity(phrase, title) : 0;

      let headingScore = 0;
      for (const heading of entry?.headings || []) {
        headingScore = Math.max(headingScore, similarity(phrase, heading));
      }

      /* Body text is scored by containment rather than similarity: a page is
       * not "similar to" a two-word query, it either discusses it or does not. */
      const body = (entry?.text || '').toLowerCase();
      const words = phrase.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
      const hits = words.filter((word) => body.includes(word)).length;
      const bodyScore = words.length > 0 ? hits / words.length : 0;

      const score = Math.max(
        nameScore,
        titleScore * 0.95,
        headingScore * 0.85,
        bodyScore * 0.7
      );

      if (score < threshold) continue;

      /* Say where it was found, so a spoken answer can explain itself rather
       * than asserting a match the user cannot see the basis for. */
      let where = 'name';
      if (score === titleScore * 0.95) where = 'title';
      if (score === headingScore * 0.85) where = 'a heading';
      if (score === bodyScore * 0.7) where = 'the page text';

      results.push({ screen, score, where, indexed: Boolean(entry) });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

/* A single index per session. Search is a workspace-wide affordance rather
 * than something a component owns. */
export const workspaceIndex = new WorkspaceIndex();

export { rank };
