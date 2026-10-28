import test from 'node:test';
import assert from 'node:assert/strict';

import { FRAMING, classifyLoadedFrame, framingMessage, knownFramingPolicy } from './embedding.js';

test('the sites a control centre actually holds are known to refuse framing', () => {
  /* Measured with live header checks and recorded in the architecture
     document. These are exactly the two that showed as white rectangles. */
  for (const url of [
    'https://github.com/', 'https://news.ycombinator.com/',
    'https://www.google.com', 'https://claude.ai/', 'https://chatgpt.com',
    'https://x.com/home', 'https://app.slack.com/client', 'https://www.notion.so/x'
  ]) {
    assert.equal(knownFramingPolicy(url), FRAMING.BLOCKED, url);
  }
});

test('subdomains inherit the policy of the site they belong to', () => {
  assert.equal(knownFramingPolicy('https://mail.google.com/mail/u/0'), FRAMING.BLOCKED);
  assert.equal(knownFramingPolicy('https://gist.github.com/x'), FRAMING.BLOCKED);
  /* And a lookalike domain does not, which a naive `includes` would get wrong. */
  assert.equal(knownFramingPolicy('https://github.com.evil.example/'), FRAMING.UNKNOWN);
  assert.equal(knownFramingPolicy('https://notgithub.com/'), FRAMING.UNKNOWN);
});

test('a dedicated embed endpoint beats its own domain', () => {
  assert.equal(knownFramingPolicy('https://www.youtube.com/watch?v=abc'), FRAMING.BLOCKED);
  assert.equal(knownFramingPolicy('https://www.youtube.com/embed/abc'), FRAMING.ALLOWED);
  assert.equal(knownFramingPolicy('https://open.spotify.com/embed/track/x'), FRAMING.ALLOWED);
});

test('our own machine is ours to frame', () => {
  assert.equal(knownFramingPolicy('http://localhost:4173/'), FRAMING.ALLOWED);
  assert.equal(knownFramingPolicy('http://127.0.0.1:8080/x'), FRAMING.ALLOWED);
  assert.equal(knownFramingPolicy('http://192.168.1.28:4174/'), FRAMING.ALLOWED);
});

test('anything unmeasured is unknown, not assumed', () => {
  assert.equal(knownFramingPolicy('https://en.wikipedia.org/wiki/XR'), FRAMING.UNKNOWN);
  assert.equal(knownFramingPolicy('not a url'), FRAMING.UNKNOWN);
  assert.equal(knownFramingPolicy(''), FRAMING.UNKNOWN);
});

test('a frame that refuses to be read is a frame that worked', () => {
  /* The backwards-feeling core of the probe: the browser throwing is the proof
     that real cross-origin content is in there. */
  const crossOrigin = () => { throw new DOMException('Blocked a frame', 'SecurityError'); };
  assert.equal(classifyLoadedFrame(crossOrigin), FRAMING.ALLOWED);
});

test('a frame that reads as about:blank was refused', () => {
  /* This is the case the old timeout could never catch, because a refused
     frame still fires load and the timeout was cleared by it. */
  assert.equal(classifyLoadedFrame(() => 'about:blank'), FRAMING.BLOCKED);
  assert.equal(classifyLoadedFrame(() => ''), FRAMING.BLOCKED);
  assert.equal(classifyLoadedFrame(() => null), FRAMING.BLOCKED);
});

test('genuinely same-origin content is allowed, not mistaken for a refusal', () => {
  assert.equal(classifyLoadedFrame(() => 'http://localhost:4173/embed-test.html'), FRAMING.ALLOWED);
});

test('the message names the site and blames nobody', () => {
  const message = framingMessage('https://github.com/anthropics');
  assert.match(message, /github\.com/);
  assert.doesNotMatch(message, /error|fail|blocked by us|sorry/i);
});
