import { CAPABILITIES, CONNECTION_MODES } from '../connectors/connector-schema.js';
import { parseUtterance } from './registry.js';
import { isDecisive, rank, similarity } from './fuzzy.js';

/*
 * Understanding what was meant, not only what was said.
 *
 * The rule grammar is exact and fast, and it should stay that way — "connect
 * Research to Claude" must never cost a guess. But people do not speak in
 * grammars. They say "uh, can you hook the research one up to cloud", and a
 * system that answers "I don't know how to do that" is a system they stop
 * talking to.
 *
 * So interpretation is layered, cheapest and most certain first:
 *
 *   1. the exact grammar, on what was heard
 *   2. the exact grammar, on a cleaned-up version — fillers and politeness
 *      removed, contractions expanded
 *   3. a semantic scan: find the pieces anywhere in the sentence — known
 *      window and agent names, a mode word, capability words, an action verb —
 *      and propose what they add up to
 *
 * Layer 3 is what makes almost anything work, and it is also the layer that
 * can be wrong. So it never acts silently: it returns ranked candidates, and
 * the caller acts only when one is decisively ahead. Otherwise the user is
 * offered the top few and picks. Asking is cheap; a confidently wrong action
 * on someone's workspace is not.
 */

/* Removed before re-parsing. Politeness and hesitation carry no instruction,
 * and every one of them breaks an anchored pattern. */
const FILLERS = [
  'um', 'uh', 'erm', 'ah', 'oh', 'like', 'you know', 'i mean',
  'please', 'thanks', 'thank you', 'ok', 'okay', 'alright', 'right',
  'can you', 'could you', 'would you', 'will you', 'i want to', 'i want you to',
  'i would like to', "i'd like to", 'i need you to', 'i need to',
  'let us', "let's", 'lets', 'go ahead and', 'for me', 'if you can',
  'hey', 'hi', 'now', 'just', 'maybe', 'actually', 'basically', 'kind of'
];

const CONTRACTIONS = [
  [/\bdon't\b/g, 'do not'],
  [/\bdoesn't\b/g, 'does not'],
  [/\bcan't\b/g, 'can not'],
  [/\bwon't\b/g, 'will not'],
  [/\bit's\b/g, 'it is'],
  [/\bthat's\b/g, 'that is'],
  [/\bwhat's\b/g, 'what is'],
  [/\bi'm\b/g, 'i am']
];

/* Words a recognizer commonly substitutes in this vocabulary. Only entries
 * that are unambiguous in a workspace command belong here — a general spelling
 * corrector would do more harm than good. */
const HEARD_AS = [
  [/\bconnected\s+to\s+/g, 'connect to '],
  [/\bconnects?\s+up\s+(?:to|with)\s+/g, 'connect to '],
  [/\bhook(?:ed|s)?\s+up\s+(?:to|with)?\s*/g, 'connect '],
  [/\bhook(?:ed|s)?\s+/g, 'connect '],
  /* "connect research up to claude" — the particle is left stranded once the
   * verb is rewritten, and it breaks the anchored pattern. */
  [/\s+up\s+(?:to|with)\s+/g, ' to '],
  [/\bwire\s+(?:up\s+)?/g, 'connect '],
  [/\bplug\s+(?:in\s+)?/g, 'connect '],
  [/\bsummarise\b/g, 'summarize'],
  [/\banalyse\b/g, 'analyze'],
  [/\bshut\s+off\b/g, 'turn off'],
  [/\bswitch\s+off\b/g, 'turn off'],
  [/\bswitch\s+on\b/g, 'turn on'],
  [/\bget\s+rid\s+of\b/g, 'remove']
];

export const normalizeUtterance = (utterance) => {
  let text = String(utterance ?? '').toLowerCase().replace(/[^\w\s'-]/g, ' ');
  for (const [pattern, replacement] of CONTRACTIONS) text = text.replace(pattern, replacement);
  for (const filler of FILLERS) {
    text = text.replace(new RegExp(`(^|\\s)${filler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'g'), ' ');
  }
  for (const [pattern, replacement] of HEARD_AS) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, ' ').trim();
};

/* Action verbs that suggest an intent, with the intent they suggest. */
const ACTION_HINTS = [
  { intent: 'connector.create', words: ['connect', 'link', 'attach', 'join', 'hook', 'wire', 'feed', 'give', 'send', 'put'] },
  { intent: 'connector.remove', words: ['disconnect', 'unlink', 'detach', 'separate', 'unhook'] },
  { intent: 'connector.toggle.off', words: ['turn off', 'disable', 'pause', 'mute', 'stop'] },
  { intent: 'connector.toggle.on', words: ['turn on', 'enable', 'resume', 'unpause'] },
  { intent: 'connector.run', words: ['run', 'refresh', 'update', 'resend', 'extract', 'pull', 'gather', 'read'] },
  { intent: 'connector.list', words: ['what', 'show', 'list', 'which'] },
  { intent: 'window.focus', words: ['focus', 'select', 'look at', 'bring up', 'switch to'] },
  /* Destructive. Proposed but never acted on from a guess — see interpret(). */
  { intent: 'window.close', words: ['close', 'dismiss', 'kill'], destructive: true },
  { intent: 'agent.create', words: ['create agent', 'add agent', 'new agent', 'make agent'] },
  { intent: 'agent.remove', words: ['remove agent', 'delete agent'] }
];

const CAPABILITY_WORDS = {
  text: CAPABILITIES.TEXT, words: CAPABILITIES.TEXT,
  links: CAPABILITIES.LINKS, urls: CAPABILITIES.LINKS,
  headings: CAPABILITIES.HEADINGS, headlines: CAPABILITIES.HEADINGS,
  images: CAPABILITIES.IMAGES, photos: CAPABILITIES.IMAGES, pictures: CAPABILITIES.IMAGES,
  videos: CAPABILITIES.VIDEOS, metadata: CAPABILITIES.METADATA,
  title: CAPABILITIES.TITLE, selection: CAPABILITIES.SELECTION,
  tables: CAPABILITIES.STRUCTURED_DATA
};

const displayName = (node) => node.name || node.title || node.id;

/* Every addressable thing, with the several names it might be called by. */
const addressable = ({ screens = [], agents = [] }) => ([
  ...screens.map((screen) => ({
    id: screen.id,
    kind: 'window',
    name: displayName(screen),
    keys: [screen.name, screen.title, screen.source?.title].filter(Boolean)
  })),
  ...agents.map((agent) => ({
    id: agent.id,
    kind: 'agent',
    name: agent.name,
    keys: [agent.name].filter(Boolean)
  }))
]);

/*
 * Find the named things in a sentence, in the order they appear.
 *
 * Scans word windows rather than the whole string, so "hook the research one
 * up to cloud" yields Research then Claude — which is what makes the semantic
 * layer able to reconstruct a connection from a sentence that matches no rule.
 */
export const findNodes = (text, context, { threshold = 0.66 } = {}) => {
  const nodes = addressable(context);
  if (nodes.length === 0) return [];

  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const found = [];

  for (let start = 0; start < words.length; start += 1) {
    /* Try every span from this word, shortest first, and keep the longest one
     * that genuinely improves the match. Extending a span must earn its keep:
     * otherwise a phrase merely *containing* a name scores as well as the name
     * and consumes the other names in the sentence. */
    let chosen = null;
    for (let span = 1; span <= Math.min(3, words.length - start); span += 1) {
      const phrase = words.slice(start, start + span).join(' ');
      if (phrase.length < 3) continue;
      const ranked = rank(phrase, nodes, { keyOf: (node) => node.keys, threshold });
      if (ranked.length === 0) continue;
      if (!chosen || ranked[0].score > chosen.ranked[0].score + 0.06) {
        chosen = { span, ranked };
      }
    }

    if (chosen) {
      const { span, ranked } = chosen;
      const best = ranked[0];
      /* One mention per node: "send research to research's notes" should not
       * resolve both ends to the same window. */
      if (!found.some((entry) => entry.id === best.item.id)) {
        found.push({
          id: best.item.id,
          kind: best.item.kind,
          name: best.item.name,
          score: best.score,
          at: start,
          alternatives: ranked.slice(1, 3).map((entry) => ({
            id: entry.item.id, kind: entry.item.kind, name: entry.item.name, score: entry.score
          }))
        });
        start += span - 1;
      }
    }
  }

  return found;
};

const findMode = (text) => {
  const entries = Object.values(CONNECTION_MODES).map((mode) => ({
    id: mode.id,
    keys: [mode.id, mode.label, mode.id.replace('-', ' ')]
  }));
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  let best = null;
  for (const word of words) {
    if (word.length < 4) continue;
    const ranked = rank(word, entries, { keyOf: (entry) => entry.keys, threshold: 0.7 });
    if (ranked.length > 0 && (!best || ranked[0].score > best.score)) {
      best = { mode: ranked[0].item.id, score: ranked[0].score };
    }
  }
  return best;
};

const findCapabilities = (text) => {
  const found = [];
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  for (const word of words) {
    for (const [term, capability] of Object.entries(CAPABILITY_WORDS)) {
      if (similarity(word, term) >= 0.85 && !found.includes(capability)) found.push(capability);
    }
  }
  return found.length > 0 ? found : null;
};

const findAction = (text) => {
  let best = null;
  for (const hint of ACTION_HINTS) {
    for (const word of hint.words) {
      if (!new RegExp(`\\b${word}\\b`).test(text)) continue;
      const score = word.includes(' ') ? 0.9 : 0.75;
      if (!best || score > best.score) {
        best = { intent: hint.intent, score, word, destructive: Boolean(hint.destructive) };
      }
    }
  }
  return best;
};

const describe = (candidate) => {
  switch (candidate.intent) {
    case 'connector.create':
      return `Connect ${candidate.source.name} to ${candidate.target.name}`
        + (candidate.mode && candidate.mode !== 'reference'
          ? `: ${CONNECTION_MODES[candidate.mode].label}` : '');
    case 'connector.remove':
      return `Disconnect ${candidate.source.name} from ${candidate.target.name}`;
    case 'connector.toggle':
      return `${candidate.enabled ? 'Turn on' : 'Turn off'} ${candidate.source.name} → ${candidate.target.name}`;
    case 'connector.run':
      return `Send everything from ${candidate.source.name}`;
    case 'connector.list':
      return `Show what ${candidate.source.name} is connected to`;
    case 'window.focus':
      return `Focus ${candidate.target.name}`;
    case 'window.close':
      return `Close ${candidate.target.name}`;
    case 'agent.remove':
      return `Remove ${candidate.agent.name}`;
    default:
      return candidate.intent;
  }
};

/*
 * Propose what a sentence might mean, from its pieces.
 *
 * Only shapes the pieces actually support are proposed — two nodes and a
 * connecting verb become a connection; one node and a run verb becomes a run.
 * Nothing is invented to fill a gap, because a plausible-looking option the
 * user did not mean is worse than a short list.
 */
export const proposeCandidates = (text, context) => {
  const nodes = findNodes(text, context);
  const action = findAction(text);
  const mode = findMode(text);
  const capabilities = findCapabilities(text);
  const candidates = [];

  const nodeConfidence = nodes.length > 0
    ? nodes.reduce((total, node) => total + node.score, 0) / nodes.length
    : 0;

  if (nodes.length >= 2) {
    const [source, target] = nodes;
    const base = (nodeConfidence * 0.6) + ((action?.score ?? 0.35) * 0.4);

    if (!action || action.intent === 'connector.create') {
      candidates.push({
        intent: 'connector.create',
        source, target,
        mode: mode?.mode || 'reference',
        capabilities,
        score: base + (mode ? 0.08 : 0)
      });
    }
    if (action?.intent === 'connector.remove') {
      candidates.push({ intent: 'connector.remove', source, target, score: base });
    }
    if (action?.intent === 'connector.toggle.off' || action?.intent === 'connector.toggle.on') {
      candidates.push({
        intent: 'connector.toggle',
        source, target,
        enabled: action.intent.endsWith('.on'),
        score: base
      });
    }
    /* A second reading worth offering: the same two names, connected the other
     * way round. Word order in speech is not reliable. */
    if (!action || action.intent === 'connector.create') {
      candidates.push({
        intent: 'connector.create',
        source: target, target: source,
        mode: mode?.mode || 'reference',
        capabilities,
        score: base - 0.15
      });
    }
  }

  if (nodes.length === 1) {
    const [source] = nodes;
    const base = (nodeConfidence * 0.6) + ((action?.score ?? 0.3) * 0.4);
    if (action?.intent === 'connector.run' || capabilities) {
      candidates.push({ intent: 'connector.run', source, score: base });
    }
    if (action?.intent === 'connector.list') {
      candidates.push({ intent: 'connector.list', source, score: base });
    }
    if (action?.intent === 'agent.remove' && source.kind === 'agent') {
      candidates.push({ intent: 'agent.remove', agent: source, score: base, destructive: true });
    }
    if (action?.intent === 'window.focus' && source.kind === 'window') {
      candidates.push({ intent: 'window.focus', target: source, score: base });
    }
    if (action?.intent === 'window.close') {
      candidates.push({
        intent: source.kind === 'agent' ? 'agent.remove' : 'window.close',
        target: source,
        agent: source,
        score: base,
        destructive: true
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((candidate) => ({ ...candidate, label: describe(candidate) }));
};

/*
 * Interpret one utterance.
 *
 * Returns:
 *   { ok: true, source: 'exact'|'normalized', intent }   act on it
 *   { ok: true, source: 'inferred', intent }             act, decisively ahead
 *   { ok: false, reason: 'choose', choices }             ask which
 *   { ok: false, reason: 'unrecognized' }                not a command here
 */
export const interpret = (utterance, context = {}) => {
  const exact = parseUtterance(utterance);
  if (exact.ok) return { ok: true, source: 'exact', intent: exact };

  const normalized = normalizeUtterance(utterance);
  if (normalized && normalized !== String(utterance ?? '').toLowerCase().trim()) {
    const retry = parseUtterance(normalized);
    if (retry.ok) return { ok: true, source: 'normalized', intent: retry, normalized };
  }

  const candidates = proposeCandidates(normalized || utterance, context);
  if (candidates.length === 0) return { ok: false, reason: 'unrecognized', text: normalized };

  /* A guess may focus a window. It may not close one. Destructive readings are
   * always offered rather than performed, however confident the match — the
   * cost of being wrong is not symmetric, and an inference the user cannot
   * preview is the wrong place to spend their trust. */
  if (!candidates[0].destructive
    && isDecisive(candidates.map((candidate) => ({ score: candidate.score })))) {
    return { ok: true, source: 'inferred', intent: { ok: true, ...candidates[0] } };
  }

  return {
    ok: false,
    reason: 'choose',
    choices: candidates.slice(0, 3),
    question: 'Did you mean one of these?'
  };
};

/*
 * Resolve a spoken answer to an offered list.
 *
 * "the first one", "number two", "the second", "no" — and failing that, the
 * closest label. A user answering a question should not have to answer it in a
 * particular format.
 */
const ORDINALS = [
  [/\b(?:first|one|1st|number one|number 1)\b/, 0],
  [/\b(?:second|two|2nd|number two|number 2)\b/, 1],
  [/\b(?:third|three|3rd|number three|number 3)\b/, 2]
];

export const resolveChoice = (utterance, choices = []) => {
  const text = normalizeUtterance(utterance);
  if (!text) return { ok: false, reason: 'empty' };
  if (/\b(?:no|none|neither|nothing|cancel|never mind|nevermind|forget it)\b/.test(text)) {
    return { ok: false, reason: 'cancelled' };
  }

  for (const [pattern, index] of ORDINALS) {
    if (pattern.test(text) && choices[index]) return { ok: true, choice: choices[index], by: 'ordinal' };
  }

  const ranked = rank(text, choices, { keyOf: (choice) => choice.label, threshold: 0.4 });
  if (ranked.length > 0 && isDecisive(ranked, { minimum: 0.45, margin: 0.08 })) {
    return { ok: true, choice: ranked[0].item, by: 'label' };
  }

  return { ok: false, reason: 'unclear' };
};
