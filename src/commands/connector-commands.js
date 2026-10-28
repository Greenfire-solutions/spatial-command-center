import { CAPABILITIES, CONNECTION_MODES, DEFAULT_MODE } from '../connectors/connector-schema.js';
import { describeAmbiguity, resolveNode } from './resolve-node.js';

/*
 * Speaking the connector system.
 *
 * Parsing is deliberate and deterministic. "Connect Research to Claude" is not
 * an ambiguous request and should not cost a model round-trip, or fail because
 * one was unavailable — §12's deterministic layer. An AI planner sits above
 * this later and emits the same intents rather than touching state itself.
 *
 * The grammar is a table rather than a chain of branches. Each entry is one
 * utterance shape with its own test, which keeps a growing vocabulary from
 * becoming one regex nobody dares edit — and it is the shape §11's command
 * registry wants, reached by growing into it rather than declaring it up front.
 *
 * Every rule returns an *intent*. Nothing here mutates anything; execution is a
 * separate step that goes through the same store actions a mouse drag calls.
 */

/* Verbs that both connect and imply how. Saying "summarize Research into
 * Claude" states the relationship and the mode in one breath. */
const MODE_VERBS = {
  connect: DEFAULT_MODE,
  link: DEFAULT_MODE,
  attach: DEFAULT_MODE,
  send: 'send',
  push: 'send',
  extract: 'extract',
  summarize: 'summarize',
  summarise: 'summarize',
  analyze: 'analyze',
  analyse: 'analyze',
  compare: 'compare',
  monitor: 'monitor',
  watch: 'monitor',
  sync: 'synchronize',
  synchronize: 'synchronize',
  transform: 'transform'
};

/* Spoken names for a mode, for the forms that name one directly. */
const MODE_ALIASES = {
  'agent context': 'agent-context',
  context: 'agent-context',
  reference: 'reference',
  extract: 'extract',
  extraction: 'extract',
  send: 'send',
  synchronize: 'synchronize',
  sync: 'synchronize',
  summary: 'summarize',
  summarize: 'summarize',
  summarise: 'summarize',
  analysis: 'analyze',
  analyze: 'analyze',
  analyse: 'analyze',
  monitor: 'monitor',
  comparison: 'compare',
  compare: 'compare',
  transform: 'transform'
};

const CAPABILITY_WORDS = {
  'readable text': CAPABILITIES.TEXT,
  'selected text': CAPABILITIES.SELECTION,
  'structured data': CAPABILITIES.STRUCTURED_DATA,
  'meta data': CAPABILITIES.METADATA,
  metadata: CAPABILITIES.METADATA,
  text: CAPABILITIES.TEXT,
  links: CAPABILITIES.LINKS,
  urls: CAPABILITIES.LINKS,
  headings: CAPABILITIES.HEADINGS,
  headlines: CAPABILITIES.HEADINGS,
  images: CAPABILITIES.IMAGES,
  photos: CAPABILITIES.IMAGES,
  pictures: CAPABILITIES.IMAGES,
  videos: CAPABILITIES.VIDEOS,
  title: CAPABILITIES.TITLE,
  address: CAPABILITIES.URL,
  url: CAPABILITIES.URL,
  selection: CAPABILITIES.SELECTION,
  tables: CAPABILITIES.STRUCTURED_DATA
};

const clean = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[.,!?]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const parseCapabilities = (fragment) => {
  if (!fragment) return null;

  /* Matched longest-phrase-first so "selected text" is not consumed as "text",
   * but reported in the order the words were spoken — "the links and images"
   * should come back links-then-images, because that is what was said. */
  const words = Object.keys(CAPABILITY_WORDS).sort((a, b) => b.length - a.length);
  let remaining = ` ${fragment} `;
  const hits = [];

  for (const word of words) {
    const pattern = new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`);
    const match = remaining.match(pattern);
    if (!match) continue;
    remaining = remaining.replace(pattern, ' '.repeat(match[0].length));
    hits.push({ at: match.index, capability: CAPABILITY_WORDS[word] });
  }

  hits.sort((a, b) => a.at - b.at);
  const found = [];
  for (const hit of hits) if (!found.includes(hit.capability)) found.push(hit.capability);
  return found.length > 0 ? found : null;
};

const modeFromPhrase = (phrase) => MODE_ALIASES[clean(phrase)] || null;

const VERB_PATTERN = Object.keys(MODE_VERBS).join('|');
const MODE_PATTERN = Object.keys(MODE_ALIASES).sort((a, b) => b.length - a.length).join('|');

/* A phrase naming a connector rather than a node. */
const CONNECTION_REF = '(?:this|that|the)\\s+(?:connection|connector|link|line)';

/*
 * The grammar.
 *
 * Order matters: the first rule whose pattern matches wins, so narrower shapes
 * are listed before the broad "verb A to B" that would otherwise swallow them.
 */
const RULES = [
  {
    id: 'connector.remove',
    pattern: /^(?:disconnect|unlink|detach)\s+(.+?)\s+(?:from|and)\s+(.+)$/,
    build: ([, source, target]) => ({ intent: 'connector.remove', source, target })
  },

  {
    id: 'connector.list',
    /* Longest prefix first: with `show` ahead of `show what`, "show what X
     * connects to" matches `show` and captures "what X". */
    pattern: /^(?:show me what|show what|what|show)\s+(?:is\s+)?(.+?)(?:\s+is)?\s+connect(?:ed|s)\s+to$/,
    build: ([, source]) => ({ intent: 'connector.list', source })
  },

  /* ---- acting on a connector that already exists ---- */

  {
    id: 'connector.toggle.off',
    pattern: new RegExp(`^(?:turn off|disable|pause|stop)\\s+${CONNECTION_REF}$`),
    build: () => ({ intent: 'connector.toggle', enabled: false, connectorRef: 'focused' })
  },
  {
    id: 'connector.toggle.on',
    pattern: new RegExp(`^(?:turn on|enable|resume|start)\\s+${CONNECTION_REF}$`),
    build: () => ({ intent: 'connector.toggle', enabled: true, connectorRef: 'focused' })
  },
  {
    id: 'connector.toggle.pair',
    pattern: /^(?:turn (off|on)|(disable)|(enable))\s+(.+?)\s+(?:to|and|into)\s+(.+)$/,
    build: (match) => ({
      intent: 'connector.toggle',
      enabled: match[1] === 'on' || Boolean(match[3]),
      source: match[4],
      target: match[5]
    })
  },

  {
    id: 'connector.configure.focused',
    pattern: new RegExp(`^(?:make|change|set)\\s+${CONNECTION_REF}\\s+(?:to|into)?\\s*(?:an?\\s+)?(${MODE_PATTERN})$`),
    build: ([, mode]) => ({
      intent: 'connector.configure',
      connectorRef: 'focused',
      mode: modeFromPhrase(mode)
    })
  },
  {
    id: 'connector.configure.pair',
    pattern: new RegExp(`^(?:make|change|set)\\s+(.+?)\\s+(?:to|into)\\s+(.+?)\\s+(?:an?\\s+|into an?\\s+|to\\s+)(${MODE_PATTERN})$`),
    build: ([, source, target, mode]) => ({
      intent: 'connector.configure',
      source,
      target,
      mode: modeFromPhrase(mode)
    })
  },

  {
    id: 'connector.permit.only',
    pattern: /^(?:only|just)\s+(?:send|share|read|extract|pass)\s+(?:the\s+)?(.+)$/,
    build: ([, caps]) => ({
      intent: 'connector.permit',
      connectorRef: 'focused',
      operation: 'only',
      capabilities: parseCapabilities(caps)
    })
  },
  {
    id: 'connector.permit.also',
    pattern: /^(?:also|additionally)\s+(?:send|share|read|extract|pass)\s+(?:the\s+)?(.+)$/,
    build: ([, caps]) => ({
      intent: 'connector.permit',
      connectorRef: 'focused',
      operation: 'add',
      capabilities: parseCapabilities(caps)
    })
  },
  {
    id: 'connector.permit.stop',
    pattern: /^(?:stop|do not|don't|never)\s+(?:send|sending|share|sharing|read|reading|pass|passing)\s+(?:the\s+)?(.+)$/,
    build: ([, caps]) => ({
      intent: 'connector.permit',
      connectorRef: 'focused',
      operation: 'remove',
      capabilities: parseCapabilities(caps)
    })
  },

  {
    id: 'connector.run.focused',
    pattern: new RegExp(`^(?:run|refresh|update|resend)\\s+${CONNECTION_REF}(?:\\s+now)?$`),
    build: () => ({ intent: 'connector.run', connectorRef: 'focused' })
  },
  {
    id: 'connector.run.node',
    /* "extract everything from this page" — run whatever leaves that node. */
    pattern: /^(?:extract|read|pull|gather)\s+(?:everything|all of it|the content|it)\s+(?:from|out of|off)\s+(.+)$/,
    build: ([, source]) => ({ intent: 'connector.run', source })
  },

  /* ---- agents ---- */

  {
    id: 'agent.create.named',
    pattern: /^(?:create|add|make|new)\s+(?:an?\s+)?(?:new\s+)?agent\s+(?:called|named)\s+(.+)$/,
    build: ([, name]) => ({ intent: 'agent.create', name })
  },
  {
    id: 'agent.create.descriptive',
    /* "add a research agent" — the adjective becomes the name. */
    pattern: /^(?:create|add|make|new)\s+(?:an?\s+)?(.+?)\s+agent$/,
    build: ([, name]) => ({ intent: 'agent.create', name })
  },
  {
    id: 'agent.remove.suffixless',
    pattern: /^(?:remove|delete)\s+agent\s+(.+)$/,
    build: ([, name]) => ({ intent: 'agent.remove', name })
  },
  {
    id: 'agent.remove',
    pattern: /^(?:remove|delete|close|destroy)\s+(?:the\s+)?(.+?)\s+agent$/,
    build: ([, name]) => ({ intent: 'agent.remove', name })
  },

  /* ---- creating a connection: the broad shape, listed last ---- */

  {
    id: 'connector.create',
    pattern: new RegExp(`^(${VERB_PATTERN})\\s+(.+?)\\s+(?:to|into|with|and)\\s+(.+)$`),
    build: (match) => {
      const verb = match[1];
      const source = match[2];
      let targetPhrase = match[3];
      let mode = MODE_VERBS[verb] || DEFAULT_MODE;
      let capabilities = null;

      /* Trailing "as <mode>" overrides the verb's implied mode. */
      const asMode = targetPhrase.match(/^(.*?)\s+as\s+(?:an?\s+)?(.+)$/);
      if (asMode) {
        const alias = modeFromPhrase(asMode[2]);
        if (alias) { targetPhrase = asMode[1]; mode = alias; }
      }

      /* Trailing capability narrowing: ", only the links and images". */
      const only = targetPhrase.match(/^(.*?)[,\s]+(?:but\s+)?only\s+(?:the\s+)?(.+)$/);
      if (only) {
        const requested = parseCapabilities(only[2]);
        if (requested) { targetPhrase = only[1]; capabilities = requested; }
      }

      const target = clean(targetPhrase);
      if (!target) return null;
      return {
        intent: 'connector.create',
        source: clean(source),
        target,
        mode: CONNECTION_MODES[mode] ? mode : DEFAULT_MODE,
        capabilities
      };
    }
  }
];

/*
 * Parse an utterance into an intent.
 *
 * Returns { ok: true, ...intent } or { ok: false, reason }. `unrecognized`
 * means this was not a connector command at all, which lets a caller pass the
 * utterance to other command families rather than swallowing it.
 */
export const parseConnectorUtterance = (utterance) => {
  const text = clean(utterance);
  if (!text) return { ok: false, reason: 'empty' };

  for (const rule of RULES) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    const built = rule.build(match);
    if (!built) continue;
    /* A rule that matched but could not name what it needs is a miss, not a
     * command — "only send the sausages" must not clear every capability. */
    if (built.intent === 'connector.permit' && !built.capabilities) continue;
    if (built.intent === 'connector.configure' && !built.mode) continue;
    return { ok: true, rule: rule.id, ...built };
  }

  return { ok: false, reason: 'unrecognized', text };
};

/* The grammar, for tests and for a help surface that should list what can
 * actually be said rather than a hand-written copy of it. */
export const COMMAND_RULES = RULES.map((rule) => rule.id);

/* Exported so the registry can parse across families in one pass. */
export const CONNECTOR_RULES = RULES;

/*
 * Resolve a parsed intent against the live workspace.
 *
 * Kept separate from parsing so the grammar can be tested without a store, and
 * so ambiguity is reported as a question rather than resolved by guessing.
 */
export const resolveConnectorIntent = (intent, context = {}) => {
  if (!intent || !intent.ok) return { ok: false, reason: intent?.reason || 'unrecognized' };

  /* An agent being created does not exist yet, so it resolves differently from
   * commands that address something already in the workspace. */
  if (intent.intent === 'agent.create') {
    const name = String(intent.name || '').trim();
    if (!name) return { ok: false, reason: 'unrecognized' };
    return { ok: true, intent: 'agent.create', name };
  }
  if (intent.intent === 'agent.remove') {
    const resolved = resolveNode(intent.name, context);
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason,
        question: resolved.reason === 'ambiguous' ? describeAmbiguity(resolved) : null,
        phrase: intent.name
      };
    }
    if (resolved.node.kind !== 'agent') {
      return { ok: false, reason: 'not-an-agent', phrase: intent.name };
    }
    return { ok: true, intent: 'agent.remove', agent: resolved.node };
  }

  /* Commands addressing the connector currently in hand. */
  if (intent.connectorRef === 'focused') {
    if (!context.focusedConnectorId) return { ok: false, reason: 'no-connector' };
    return { ok: true, ...intent, connectorId: context.focusedConnectorId };
  }

  const source = resolveNode(intent.source, context);
  if (!source.ok) {
    return {
      ok: false,
      reason: source.reason,
      question: source.reason === 'ambiguous' ? describeAmbiguity(source) : null,
      phrase: intent.source
    };
  }

  /* Shapes that name only one end. */
  if (intent.intent === 'connector.list' || (intent.intent === 'connector.run' && !intent.target)) {
    return { ok: true, intent: intent.intent, source: source.node };
  }

  const target = resolveNode(intent.target, context);
  if (!target.ok) {
    return {
      ok: false,
      reason: target.reason,
      question: target.reason === 'ambiguous' ? describeAmbiguity(target) : null,
      phrase: intent.target
    };
  }

  if (source.node.id === target.node.id && source.node.kind === target.node.kind) {
    return { ok: false, reason: 'same-node' };
  }

  return {
    ok: true,
    intent: intent.intent,
    source: source.node,
    target: target.node,
    mode: intent.mode,
    capabilities: intent.capabilities,
    enabled: intent.enabled,
    operation: intent.operation
  };
};
