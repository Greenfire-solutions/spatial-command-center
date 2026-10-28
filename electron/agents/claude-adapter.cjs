'use strict';

const Anthropic = require('@anthropic-ai/sdk');

/*
 * The Claude adapter, in the main process.
 *
 * The API key never enters the renderer. That is the whole reason this file is
 * on this side of the boundary: the renderer draws a workspace that hosts
 * remote web pages, and a credential reachable from there is a credential one
 * bug away from a page. The renderer sends a task; the main process holds the
 * key and makes the call.
 *
 * It is also the only file in the project that names a vendor. Everything else
 * — the connector graph, the agent nodes, the flow — goes through
 * AgentProvider, so a second adapter is a sibling of this file and not a
 * change anywhere else.
 */

const MODEL = 'claude-opus-5';

/* What each connection mode asks Claude to do. The connector already decided
 * the relationship; this turns it into an instruction. */
const MODE_INSTRUCTIONS = {
  summarize: 'Summarise the material below. Lead with what matters most. Be brief and concrete.',
  analyze: 'Analyse the material below. Identify what it claims, what supports those claims, and what is missing.',
  compare: 'Compare the materials below. Draw out where they agree, where they differ, and what the difference implies.',
  extract: 'Pull out the substantive content of the material below and organise it.',
  send: 'Read the material below and respond usefully to it.',
  transform: 'Restate the material below in a clearer, more useful form.',
  monitor: 'Describe the current state of the material below, noting anything that looks new or notable.',
  'agent-context': 'Use the material below as context. Say what it contains and what could usefully be done with it.'
};

/*
 * Render extracted page content as text for the model.
 *
 * Deliberately explicit about provenance and about what was *not* included:
 * a model reasoning over a page should know it is seeing a permitted subset,
 * not the whole document, so it does not confidently report an absence that is
 * really a permission boundary.
 */
const renderContent = (content) => {
  const parts = [];
  if (content.title) parts.push(`Title: ${content.title}`);
  if (content.url) parts.push(`URL: ${content.url}`);
  if (content.metadata?.description) parts.push(`Description: ${content.metadata.description}`);

  if (Array.isArray(content.headings) && content.headings.length > 0) {
    parts.push('\nHeadings:');
    for (const heading of content.headings.slice(0, 60)) {
      parts.push(`${'  '.repeat(Math.max(0, heading.level - 1))}- ${heading.text}`);
    }
  }
  if (content.text) parts.push(`\nText:\n${content.text}`);

  if (Array.isArray(content.links) && content.links.length > 0) {
    parts.push('\nLinks:');
    for (const link of content.links.slice(0, 80)) {
      parts.push(`- ${link.text || '(untitled)'} -> ${link.href}`);
    }
  }
  if (Array.isArray(content.images) && content.images.length > 0) {
    parts.push('\nImages:');
    for (const image of content.images.slice(0, 40)) {
      parts.push(`- ${image.alt || '(no alt text)'} -> ${image.src}`);
    }
  }
  if (Array.isArray(content.videos) && content.videos.length > 0) {
    parts.push('\nVideos:');
    for (const video of content.videos.slice(0, 20)) parts.push(`- ${video.kind}: ${video.src}`);
  }
  if (Array.isArray(content.tables) && content.tables.length > 0) {
    parts.push('\nTables:');
    for (const table of content.tables.slice(0, 5)) {
      if (table.headers?.length) parts.push(`| ${table.headers.join(' | ')} |`);
      for (const row of (table.rows || []).slice(0, 25)) parts.push(`| ${row.join(' | ')} |`);
    }
  }
  if (Array.isArray(content.structuredData) && content.structuredData.length > 0) {
    parts.push(`\nStructured data:\n${JSON.stringify(content.structuredData).slice(0, 4000)}`);
  }
  if (content.selection) parts.push(`\nThe user has selected:\n${content.selection}`);

  if (Array.isArray(content.granted)) {
    parts.push(
      `\n(This is a permitted subset of the page: ${content.granted.join(', ')}. `
      + 'Anything else was not read. Do not report an absence as a fact about the page.)'
    );
  }
  if (content.truncated) parts.push('(The content above was truncated to fit.)');

  return parts.join('\n');
};

class ClaudeAgentAdapter {
  /*
   * `apiKey` is resolved once at construction. An adapter with no key is
   * created anyway and reports itself unavailable — the workspace shows the
   * agent node as offline rather than failing when someone first draws a line
   * to it.
   */
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, model = MODEL, logger = console } = {}) {
    this.model = model;
    this.logger = logger;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  get id() { return 'claude'; }
  get name() { return 'Claude'; }
  get available() { return Boolean(this.client); }
  get capabilities() {
    return ['summarize', 'analyze', 'compare', 'extract', 'send', 'transform', 'monitor', 'agent-context'];
  }

  async run({ mode, instruction, inputs = [] } = {}) {
    if (!this.client) {
      return {
        ok: false,
        code: 'NO_API_KEY',
        message: 'No Anthropic API key is set. Put it in ~/Spatial Command Center Data/anthropic-api-key.txt (or set ANTHROPIC_API_KEY) and restart the app.'
      };
    }
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return { ok: false, code: 'NO_INPUT', message: 'Nothing was connected to work from.' };
    }

    const task = instruction || MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS['agent-context'];
    const rendered = inputs.map((content, index) => (
      inputs.length > 1
        ? `--- Source ${index + 1} ---\n${renderContent(content)}`
        : renderContent(content)
    )).join('\n\n');

    try {
      /* Streamed because extracted pages can be large and a non-streaming
       * request with a high max_tokens risks an HTTP timeout. */
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 64000,
        thinking: { type: 'adaptive' },
        system: 'You are an agent inside a spatial workspace. Someone has connected one or more '
          + 'browser windows to you. Answer from the material you are given. If the material does not '
          + 'support an answer, say so rather than filling the gap.',
        messages: [{ role: 'user', content: `${task}\n\n${rendered}` }]
      });

      const message = await stream.finalMessage();

      if (message.stop_reason === 'refusal') {
        return {
          ok: false,
          code: 'REFUSED',
          message: message.stop_details?.explanation || 'The model declined this request.'
        };
      }

      const output = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      return {
        ok: true,
        output,
        usage: {
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0
        }
      };
    } catch (error) {
      /* Typed SDK errors, most specific first, so a caller can tell a bad key
       * from a rate limit from a network failure. */
      if (error instanceof Anthropic.AuthenticationError) {
        return { ok: false, code: 'BAD_API_KEY', message: 'The Anthropic API key was rejected.' };
      }
      if (error instanceof Anthropic.RateLimitError) {
        return { ok: false, code: 'RATE_LIMITED', message: 'Rate limited. Try again shortly.' };
      }
      if (error instanceof Anthropic.APIError) {
        return { ok: false, code: `API_${error.status}`, message: error.message };
      }
      return { ok: false, code: 'AGENT_FAILED', message: error?.message || 'The agent failed.' };
    }
  }
}

module.exports = { ClaudeAgentAdapter, renderContent, MODE_INSTRUCTIONS, MODEL };
