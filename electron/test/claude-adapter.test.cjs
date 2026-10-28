'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ClaudeAgentAdapter, renderContent, MODE_INSTRUCTIONS, MODEL } = require('../agents/claude-adapter.cjs');

const content = () => ({
  title: 'Solar power',
  url: 'https://example.com/solar',
  text: 'Photovoltaic cells convert light into electricity.',
  headings: [{ level: 1, text: 'Solar power' }, { level: 2, text: 'History' }],
  links: [{ href: 'https://example.com/wind', text: 'Wind' }],
  images: [{ src: 'https://example.com/p.jpg', alt: 'A panel' }],
  granted: ['title', 'url', 'text', 'headings', 'links', 'images']
});

test('the adapter targets Claude Opus 5', () => {
  assert.equal(MODEL, 'claude-opus-5');
});

test('extracted content renders with its provenance', () => {
  const rendered = renderContent(content());
  assert.match(rendered, /Title: Solar power/);
  assert.match(rendered, /URL: https:\/\/example\.com\/solar/);
  assert.match(rendered, /Photovoltaic cells/);
  assert.match(rendered, /- Wind -> https:\/\/example\.com\/wind/);
});

test('the model is told it is seeing a permitted subset', () => {
  const rendered = renderContent(content());
  assert.match(rendered, /permitted subset of the page/);
  assert.match(rendered, /Do not report an absence as a fact about the page/);
});

test('a narrow grant says so, so a gap is not mistaken for the page being empty', () => {
  const rendered = renderContent({ title: 'Solar power', granted: ['title'] });
  assert.match(rendered, /permitted subset of the page: title/);
  assert.ok(!rendered.includes('Text:'), 'content that was not granted is simply not there');
});

test('truncation is disclosed', () => {
  assert.match(renderContent({ ...content(), truncated: true }), /truncated to fit/);
});

test('every mode has an instruction', () => {
  for (const mode of ['summarize', 'analyze', 'compare', 'extract', 'send', 'transform', 'monitor', 'agent-context']) {
    assert.equal(typeof MODE_INSTRUCTIONS[mode], 'string', `${mode} needs an instruction`);
    assert.ok(MODE_INSTRUCTIONS[mode].length > 10);
  }
});

test('an adapter with no key is created anyway and reports itself offline', async () => {
  const adapter = new ClaudeAgentAdapter({ apiKey: '' });
  assert.equal(adapter.available, false, 'offline is a state, not a construction failure');
  assert.equal(adapter.id, 'claude');

  const result = await adapter.run({ mode: 'summarize', inputs: [content()] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_API_KEY');
  assert.match(result.message, /ANTHROPIC_API_KEY/);
});

test('an adapter with a key reports itself available', () => {
  const adapter = new ClaudeAgentAdapter({ apiKey: 'sk-ant-test' });
  assert.equal(adapter.available, true);
  assert.ok(adapter.capabilities.includes('summarize'));
});

test('running with nothing connected is refused before any network call', async () => {
  const adapter = new ClaudeAgentAdapter({ apiKey: 'sk-ant-test' });
  const result = await adapter.run({ mode: 'summarize', inputs: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_INPUT');
});

test('several connected sources are labelled so they can be told apart', () => {
  const first = renderContent({ title: 'One', granted: ['title'] });
  const second = renderContent({ title: 'Two', granted: ['title'] });
  assert.notEqual(first, second);
  assert.match(first, /One/);
  assert.match(second, /Two/);
});
