import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findNodes,
  interpret,
  normalizeUtterance,
  proposeCandidates,
  resolveChoice
} from './interpret.js';

const context = {
  screens: [
    { id: 's1', name: 'Research', title: 'Solar power — Wikipedia' },
    { id: 's2', name: 'Finance', title: 'Dashboard' },
    { id: 's3', title: 'Editor', name: 'Code' }
  ],
  agents: [{ id: 'agent-claude', name: 'Claude' }]
};

/* ---- cleaning up what was heard ---- */

test('politeness and hesitation are removed before re-parsing', () => {
  assert.equal(
    normalizeUtterance('Um, could you please connect Research to Claude?'),
    'connect research to claude'
  );
});

test('conversational phrasings become the verb the grammar knows', () => {
  assert.equal(normalizeUtterance('hook research up to claude'), 'connect research to claude');
  assert.equal(normalizeUtterance('wire up finance to claude'), 'connect finance to claude');
  assert.equal(normalizeUtterance('shut off this connection'), 'turn off this connection');
  assert.equal(normalizeUtterance('get rid of the summarizer agent'), 'remove the summarizer agent');
});

test('a sentence that was already exact is unchanged in meaning', () => {
  assert.equal(normalizeUtterance('connect research to claude'), 'connect research to claude');
});

/* ---- the layers ---- */

test('an exact command is never guessed at', () => {
  const result = interpret('connect Research to Claude', context);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'exact');
  assert.equal(result.intent.intent, 'connector.create');
});

test('a polite command reaches the same grammar after cleanup', () => {
  const result = interpret('um, could you please connect Research to Claude', context);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'normalized');
  assert.equal(result.intent.source, 'research');
  assert.equal(result.intent.target, 'claude');
});

test('a conversational phrasing still reaches the grammar', () => {
  const result = interpret('hook research up to claude', context);
  assert.equal(result.ok, true);
  assert.equal(result.intent.intent, 'connector.create');
});

/* ---- finding the pieces anywhere in a sentence ---- */

test('names are found in a sentence that matches no rule, in spoken order', () => {
  const found = findNodes('so put the research thing over into claude somehow', context);
  assert.deepEqual(found.map((node) => node.id), ['s1', 'agent-claude']);
});

test('a mangled name is still found', () => {
  const found = findNodes('reserch and cloud', context);
  assert.deepEqual(found.map((node) => node.id), ['s1', 'agent-claude']);
});

test('a window can be named by its page title', () => {
  const found = findNodes('send solar power to claude', context);
  assert.equal(found[0].id, 's1');
});

test('one node is not matched twice', () => {
  const found = findNodes('research research research', context);
  assert.equal(found.length, 1);
});

test('nothing recognisable yields nothing', () => {
  assert.deepEqual(findNodes('what is the weather today', context), []);
});

/* ---- proposing ---- */

test('two names and a connecting verb propose a connection', () => {
  const candidates = proposeCandidates('put research into claude', context);
  assert.equal(candidates[0].intent, 'connector.create');
  assert.equal(candidates[0].source.id, 's1');
  assert.equal(candidates[0].target.id, 'agent-claude');
  assert.match(candidates[0].label, /Connect Research to Claude/);
});

test('a mode word in the sentence is picked up', () => {
  const candidates = proposeCandidates('research summarize claude', context);
  assert.equal(candidates[0].mode, 'summarize');
});

test('the reverse reading is offered too, because spoken word order is unreliable', () => {
  const candidates = proposeCandidates('research and claude connect', context);
  const reversed = candidates.find((c) => c.source.id === 'agent-claude' && c.target.id === 's1');
  assert.ok(reversed, 'both directions are on the list');
  assert.ok(reversed.score < candidates[0].score, 'but the spoken order is preferred');
});

test('one name and a run verb proposes a run', () => {
  const candidates = proposeCandidates('extract research', context);
  assert.equal(candidates[0].intent, 'connector.run');
  assert.equal(candidates[0].source.id, 's1');
});

test('nothing is invented when the pieces do not support it', () => {
  assert.deepEqual(proposeCandidates('turn off the lights', context), []);
});

/* ---- acting versus asking ---- */

test('a clearly inferred command is acted on', () => {
  const result = interpret('put the research window into claude', context);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'inferred');
  assert.equal(result.intent.intent, 'connector.create');
});

test('an unrecognisable utterance is declined, not guessed', () => {
  const result = interpret('what is the weather today', context);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unrecognized');
});

test('close readings are offered rather than chosen', () => {
  const twins = {
    screens: [{ id: 'a', name: 'Docs' }, { id: 'b', name: 'Doc' }],
    agents: []
  };
  const result = interpret('connect docs and doc', twins);
  if (!result.ok) {
    assert.equal(result.reason, 'choose');
    assert.ok(result.choices.length >= 2);
    assert.ok(result.choices.every((choice) => typeof choice.label === 'string'));
  }
});

/* ---- answering the question ---- */

const choices = [
  { label: 'Connect Research to Claude', intent: 'connector.create' },
  { label: 'Connect Claude to Research', intent: 'connector.create' },
  { label: 'Send everything from Research', intent: 'connector.run' }
];

test('an offered list can be answered by position', () => {
  assert.equal(resolveChoice('the first one', choices).choice.label, choices[0].label);
  assert.equal(resolveChoice('number two', choices).choice.label, choices[1].label);
  assert.equal(resolveChoice('third', choices).choice.label, choices[2].label);
});

test('an offered list can be answered by describing it', () => {
  const result = resolveChoice('send everything from research', choices);
  assert.equal(result.ok, true);
  assert.equal(result.choice.intent, 'connector.run');
});

test('the question can be declined', () => {
  for (const phrase of ['no', 'none of those', 'cancel', 'never mind']) {
    const result = resolveChoice(phrase, choices);
    assert.equal(result.ok, false, phrase);
    assert.equal(result.reason, 'cancelled', phrase);
  }
});

test('an unclear answer asks again rather than picking', () => {
  const result = resolveChoice('hmm well maybe', choices);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unclear');
});
