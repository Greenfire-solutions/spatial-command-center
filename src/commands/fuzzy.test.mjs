import test from 'node:test';
import assert from 'node:assert/strict';

import {
  editDistance,
  editSimilarity,
  isDecisive,
  phoneticKey,
  phoneticSimilarity,
  rank,
  similarity,
  tokenOverlap
} from './fuzzy.js';

test('edit distance measures the obvious cases', () => {
  assert.equal(editDistance('claude', 'claude'), 0);
  assert.equal(editDistance('claude', 'clau de'.replace(' ', '')), 0);
  assert.equal(editDistance('cat', 'cot'), 1);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editSimilarity('research', 'reserch'), 0.875);
});

test('sound-alikes share a phonetic key', () => {
  assert.equal(phoneticKey('claude'), phoneticKey('clawed'));
  assert.ok(phoneticSimilarity('claude', 'cloud') > 0.7, 'a recognizer hears these as the same word');
  assert.ok(phoneticSimilarity('research', 'reserch') > 0.8);
});

test('genuinely different names do not collapse together', () => {
  assert.ok(phoneticSimilarity('claude', 'finance') < 0.6);
  assert.ok(similarity('finance', 'research') < 0.5);
});

test('token overlap rewards naming the part you remembered', () => {
  assert.equal(tokenOverlap('research', 'research dashboard'), 1);
  assert.ok(tokenOverlap('solar research', 'research — solar power') >= 0.9);
  assert.equal(tokenOverlap('finance', 'research'), 0);
});

test('similarity survives what speech recognition actually does to a name', () => {
  assert.ok(similarity('cloud', 'claude') >= 0.6, 'heard "cloud", meant Claude');
  assert.ok(similarity('reserch', 'Research') >= 0.7);
  assert.ok(similarity('the research window', 'Research') >= 0.6);
  assert.equal(similarity('claude', 'claude'), 1);
});

test('a prefix is treated as a strong match, not a weak one', () => {
  assert.ok(similarity('summar', 'summarize') >= 0.9);
});

test('ranking returns the plausible candidates, best first', () => {
  const names = ['Research', 'Finance', 'Claude', 'Code'];
  const ranked = rank('reserch', names);
  assert.equal(ranked[0].value, 'Research');
  assert.ok(ranked[0].score > 0.7);
});

test('ranking can look at several names for the same thing', () => {
  const windows = [
    { id: 's1', name: 'Research', title: 'Solar power — Wikipedia' },
    { id: 's2', name: 'Finance', title: 'Dashboard' }
  ];
  const ranked = rank('solar power', windows, { keyOf: (w) => [w.name, w.title] });
  assert.equal(ranked[0].item.id, 's1', 'the page title is a legitimate way to refer to a window');
});

test('nothing plausible returns nothing rather than a bad guess', () => {
  assert.deepEqual(rank('chemistry', ['Research', 'Finance']), []);
});

/* ---- when to act and when to ask ---- */

test('a clear leader is decisive', () => {
  assert.equal(isDecisive([{ score: 0.95 }, { score: 0.4 }]), true);
});

test('two close candidates are not decisive, however confident', () => {
  assert.equal(
    isDecisive([{ score: 0.91 }, { score: 0.88 }]),
    false,
    'a confident leader can still be wrong when a rival is nearly as good'
  );
});

test('a lone but weak candidate is not decisive either', () => {
  assert.equal(
    isDecisive([{ score: 0.5 }]),
    false,
    'a clear leader can still be too weak to act on'
  );
});

test('a lone strong candidate is decisive', () => {
  assert.equal(isDecisive([{ score: 0.8 }]), true);
});

test('nothing is never decisive', () => {
  assert.equal(isDecisive([]), false);
  assert.equal(isDecisive(null), false);
});
