/*
 * Tolerant matching, so a command that is close enough still works.
 *
 * Speech recognition mangles proper nouns constantly — "Claude" comes back as
 * "cloud", "clod", "clawed"; "Research" as "reserch", "research the". A system
 * that only accepts exact strings makes the user repeat themselves, and
 * repeating yourself to a computer is the specific failure that makes people
 * stop using voice.
 *
 * Three measures, combined, because each fails differently:
 *
 *   edit distance   catches typos and dropped syllables, but rates short words
 *                   harshly — "on" to "in" is a 50% error.
 *   token overlap   catches reordering and extra words, but ignores spelling.
 *   phonetic key    catches sound-alikes that share no letters in the right
 *                   places, which is exactly what a recognizer produces.
 *
 * Everything here is pure and cheap. It runs per utterance, not per frame.
 */

/* Levenshtein with a single rolling row. The full matrix is unnecessary and
 * the strings here are short — names and phrases, not documents. */
export const editDistance = (a, b) => {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = new Array(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) previous[index] = index;

  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[right.length];
};

export const editSimilarity = (a, b) => {
  const longest = Math.max(String(a ?? '').length, String(b ?? '').length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
};

/*
 * A rough phonetic key.
 *
 * Not Soundex — Soundex keeps the first letter, and a recognizer often gets
 * that wrong too ("Claude"/"glowed"). This folds the consonants that sound
 * alike, drops vowels after the first position, and collapses runs, which is
 * enough to make "claude" and "clawed" and "cloud" share a key without
 * collapsing genuinely different names together.
 */
const PHONETIC_FOLD = [
  /* w folds with the vowels: "clawed" and "claude" differ only there, and a
   * recognizer treats them as the same sound. */
  [/[aeiouyw]+/g, 'a'],
  [/[bp]+/g, 'b'],
  [/[cgjkq]+/g, 'k'],
  [/[dt]+/g, 'd'],
  [/[sxz]+/g, 's'],
  [/[fv]+/g, 'f'],
  [/[mn]+/g, 'n'],
  [/[lr]+/g, 'l'],
  [/h+/g, '']
];

export const phoneticKey = (value) => {
  let key = String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!key) return '';
  const first = key[0];
  for (const [pattern, replacement] of PHONETIC_FOLD) key = key.replace(pattern, replacement);
  /* Collapse the vowel placeholder except where it separates consonants, so
   * length differences from dropped vowels do not dominate. */
  key = key.replace(/a{2,}/g, 'a').replace(/(.)\1+/g, '$1');
  /* A trailing vowel is usually silent or unstressed — the "e" in "claude"
   * against the "d" ending "cloud". Keeping it would separate two words a
   * recognizer hears identically. */
  key = key.replace(/a$/, '');
  return first + key.slice(1);
};

export const phoneticSimilarity = (a, b) => editSimilarity(phoneticKey(a), phoneticKey(b));

const tokens = (value) => String(value ?? '')
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(Boolean);

/* Proportion of the query's words that appear in the candidate, allowing a
 * near spelling. Asymmetric on purpose: "research" should match "research
 * dashboard" strongly, because the user named the part they remembered. */
export const tokenOverlap = (query, candidate) => {
  const queryTokens = tokens(query);
  const candidateTokens = tokens(candidate);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  const matches = (word, others) => others.some((other) => (
    other === word
    || (word.length > 3 && other.startsWith(word))
    || editSimilarity(word, other) >= 0.8
    /* A word the recognizer spelled wrong but heard right still counts. */
    || phoneticSimilarity(word, other) >= 0.9
  ));

  let queryCovered = 0;
  for (const word of queryTokens) if (matches(word, candidateTokens)) queryCovered += 1;

  let candidateCovered = 0;
  for (const word of candidateTokens) if (matches(word, queryTokens)) candidateCovered += 1;

  /* The better of the two directions. "research" against "Research dashboard"
   * and "the research window" against "Research" are both people naming the
   * same thing — one abbreviated, one padded — and neither should be punished
   * for the words the other happens to carry. */
  return Math.max(queryCovered / queryTokens.length, candidateCovered / candidateTokens.length);
};

/*
 * How well a spoken phrase matches a candidate string, 0..1.
 *
 * Weighted toward token overlap because utterances carry extra words, with
 * spelling and sound as the tie-breakers that rescue a mangled single word.
 */
export const similarity = (query, candidate) => {
  const a = String(query ?? '').toLowerCase().trim();
  const b = String(candidate ?? '').toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 1;
  /* A prefix is a strong signal only when the two are comparable in length.
   * Without the ratio check, any sentence beginning with a name scores as
   * highly as the bare name — so "research summarize claude" would match
   * "Research" perfectly and swallow every other name in the sentence. */
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if ((b.startsWith(a) || a.startsWith(b)) && ratio >= 0.6) return 0.92;

  const overlap = tokenOverlap(a, b);
  const edit = editSimilarity(a, b);
  const phonetic = phoneticSimilarity(a, b);

  return Math.min(1, (overlap * 0.55) + (edit * 0.25) + (phonetic * 0.2));
};

/*
 * Rank candidates against a phrase.
 *
 * Returns every candidate scoring at or above `threshold`, best first, each as
 * { value, score, item }. The caller decides whether the top score is decisive
 * or whether two are close enough to be worth asking about — that judgement
 * belongs with the command, not here.
 */
export const rank = (query, candidates, {
  threshold = 0.45,
  limit = 5,
  keyOf = (candidate) => candidate
} = {}) => {
  const scored = [];
  for (const item of candidates || []) {
    const keys = [].concat(keyOf(item)).filter(Boolean);
    let best = 0;
    for (const key of keys) best = Math.max(best, similarity(query, key));
    if (best >= threshold) scored.push({ item, value: keys[0], score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
};

/*
 * Is the leader decisive, or should the user be asked?
 *
 * Two conditions, both necessary. A confident leader can still be wrong if a
 * rival is nearly as good, and a clear leader can still be too weak to act on.
 * Guessing when either fails is what produces confident wrong actions.
 */
export const isDecisive = (ranked, { minimum = 0.62, margin = 0.12 } = {}) => {
  if (!ranked || ranked.length === 0) return false;
  if (ranked[0].score < minimum) return false;
  if (ranked.length === 1) return true;
  return ranked[0].score - ranked[1].score >= margin;
};
