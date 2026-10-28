import { NODE_KINDS } from '../connectors/connector-schema.js';
import { isDecisive, rank } from './fuzzy.js';

/*
 * Turning what someone said into which window they meant.
 *
 * "Connect Research to Claude" only works if "Research" and "Claude" can be
 * resolved to nodes. This module is the only place that decides how, so voice,
 * a future text console, and an agent planner all resolve names identically —
 * and so ambiguity is handled once, in a way that can be tested without a
 * microphone.
 *
 * It deliberately does not guess when it is unsure. Silently picking one of two
 * windows called "Docs" and connecting it to an AI is exactly the kind of
 * confident wrong answer that makes a voice system untrustworthy; returning the
 * candidates so the caller can ask is the correct behaviour.
 */

/* Words that mean "the thing I am looking at or last touched" rather than a
 * name. Resolved against the focused window. */
const DEICTIC = new Set(['this', 'that', 'it', 'this one', 'this window', 'that window', 'here']);

const normalize = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/* Speech recognizers routinely return a trailing article or filler. Stripping
 * them is safer than expecting the phrase parser to have caught every one. */
const STRIP_PREFIX = /^(the|my|a|an)\s+/;

const displayName = (screen) => screen.name || screen.title || screen.id;

const candidateTerms = (screen) => {
  const terms = [displayName(screen), screen.title, screen.name, screen.id];
  if (screen.source?.title) terms.push(screen.source.title);
  return terms.filter(Boolean).map(normalize).filter(Boolean);
};

/*
 * Score how well a spoken phrase matches a window.
 *
 * Ordered so that a deliberate exact name always beats an incidental substring
 * match in a page title, which is what keeps renamed windows addressable even
 * when a website's own title contains the same word.
 */
const scoreScreen = (screen, spoken) => {
  const terms = candidateTerms(screen);
  if (terms.includes(spoken)) return 100;
  if (terms.some((term) => term.startsWith(spoken))) return 70;
  if (terms.some((term) => spoken.startsWith(term))) return 60;
  if (terms.some((term) => term.includes(spoken))) return 40;

  /* Every spoken word appearing somewhere in the name, in any order. Catches
   * "solar research" against a window named "Research — Solar". */
  const words = spoken.split(' ').filter(Boolean);
  if (words.length > 1 && terms.some((term) => words.every((word) => term.includes(word)))) return 30;

  return 0;
};

/*
 * Resolve a spoken phrase to a single node.
 *
 * Returns one of:
 *   { ok: true, node }                      exactly one good match
 *   { ok: false, reason: 'ambiguous', candidates }   caller must ask
 *   { ok: false, reason: 'not-found' }
 *   { ok: false, reason: 'no-focus' }       "this" with nothing focused
 */
export const resolveNode = (phrase, { screens = [], agents = [], focusedId = null } = {}) => {
  const spokenRaw = normalize(phrase);
  const spoken = spokenRaw.replace(STRIP_PREFIX, '').trim();
  if (!spoken) return { ok: false, reason: 'not-found', phrase };

  if (DEICTIC.has(spoken) || DEICTIC.has(spokenRaw)) {
    if (!focusedId) return { ok: false, reason: 'no-focus', phrase };
    const focused = screens.find((screen) => screen.id === focusedId);
    if (!focused) return { ok: false, reason: 'no-focus', phrase };
    return { ok: true, node: { id: focused.id, kind: NODE_KINDS.WINDOW, name: displayName(focused) } };
  }

  const scored = [];

  for (const screen of screens) {
    const score = scoreScreen(screen, spoken);
    if (score > 0) scored.push({ score, id: screen.id, kind: NODE_KINDS.WINDOW, name: displayName(screen) });
  }
  for (const agent of agents) {
    const score = scoreScreen(agent, spoken);
    if (score > 0) scored.push({ score, id: agent.id, kind: NODE_KINDS.AGENT, name: displayName(agent) });
  }

  /* Nothing matched literally. Before giving up, try tolerantly: a recognizer
   * routinely returns "reserch" for Research and "cloud" for Claude, and
   * making someone repeat themselves is the failure that stops them using
   * voice at all. Ambiguity is still reported rather than guessed. */
  if (scored.length === 0) {
    const pool = [
      ...screens.map((screen) => ({ id: screen.id, kind: NODE_KINDS.WINDOW, name: displayName(screen), keys: [screen.name, screen.title].filter(Boolean) })),
      ...agents.map((agent) => ({ id: agent.id, kind: NODE_KINDS.AGENT, name: displayName(agent), keys: [agent.name, agent.title].filter(Boolean) }))
    ];
    const ranked = rank(spoken, pool, { keyOf: (entry) => entry.keys, threshold: 0.66 });
    if (ranked.length === 0) return { ok: false, reason: 'not-found', phrase };
    if (!isDecisive(ranked)) {
      return {
        ok: false,
        reason: 'ambiguous',
        phrase,
        candidates: ranked.map(({ item }) => ({ id: item.id, kind: item.kind, name: item.name }))
      };
    }
    const { item } = ranked[0];
    return { ok: true, node: { id: item.id, kind: item.kind, name: item.name }, approximate: true };
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const tied = scored.filter((entry) => entry.score === best.score);

  if (tied.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      phrase,
      candidates: tied.map(({ id, kind, name }) => ({ id, kind, name }))
    };
  }

  return { ok: true, node: { id: best.id, kind: best.kind, name: best.name } };
};

/* A question a caller can put to the user when resolution was ambiguous. */
export const describeAmbiguity = (result) => {
  if (!result || result.reason !== 'ambiguous') return '';
  const names = result.candidates.map((candidate) => candidate.name);
  const last = names[names.length - 1];
  const rest = names.slice(0, -1).join(', ');
  return `Which "${result.phrase}" did you mean: ${rest} or ${last}?`;
};

export { displayName };
