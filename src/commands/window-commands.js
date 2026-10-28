import { normalizeBrowserInput } from '../url-normalization.js';

/*
 * Speaking the workspace itself: windows, arrangement, mode.
 *
 * A second command family alongside connectors, written to the same shape — a
 * table of utterance patterns producing intents, never mutations. Both are
 * parsed by the registry in one pass, and both inherit the tolerant
 * interpretation layer for free: adding a rule here means every polite,
 * padded and mangled phrasing of it works, without writing any of them down.
 */

/* Layouts the workspace already knows how to arrange itself into. Spoken names
 * are separate from preset ids because nobody says "TripleMonitor". */
export const LAYOUT_ALIASES = {
  developer: 'Developer',
  coding: 'Developer',
  code: 'Developer',
  development: 'Developer',
  'command arc': 'CommandArc',
  command: 'CommandArc',
  arc: 'CommandArc',
  focus: 'Focus',
  focused: 'Focus',
  reading: 'Focus',
  'wide arc': 'WideArc',
  wide: 'WideArc',
  'triple monitor': 'TripleMonitor',
  triple: 'TripleMonitor',
  monitors: 'TripleMonitor',
  stack: 'Stack',
  stacked: 'Stack',
  surround: 'Surround',
  around: 'Surround',
  'around me': 'Surround'
};

const LAYOUT_PATTERN = Object.keys(LAYOUT_ALIASES)
  .sort((a, b) => b.length - a.length)
  .join('|');

/* Directions are resolved against the viewer, not the world, so "to my left"
 * means the same thing whichever way someone is facing. */
export const DIRECTIONS = {
  left: 'left', right: 'right',
  up: 'up', higher: 'up', down: 'down', lower: 'down',
  closer: 'closer', nearer: 'closer', forward: 'closer',
  away: 'farther', farther: 'farther', further: 'farther', back: 'farther'
};

const DIRECTION_PATTERN = Object.keys(DIRECTIONS).sort((a, b) => b.length - a.length).join('|');

const clean = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[.,!?]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/* A phrase that plausibly names a site or address rather than a window. */
const looksLikeDestination = (phrase) => {
  const text = clean(phrase);
  if (!text) return false;
  if (/\s/.test(text) && !/\.[a-z]{2,}/.test(text)) return false;
  return /\.[a-z]{2,}/.test(text) || /^[a-z0-9-]+$/.test(text);
};

export const WINDOW_RULES = [
  /* ---- creating ---- */
  {
    id: 'window.create.blank',
    pattern: /^(?:new|create|add|open)\s+(?:a\s+)?(?:new\s+)?(?:window|screen|browser|tab|monitor)$/,
    build: () => ({ intent: 'window.create', url: null })
  },
  {
    id: 'window.create.url',
    pattern: /^(?:new|create|add|open)\s+(?:a\s+)?(?:new\s+)?(?:window|screen|browser|tab)\s+(?:on|at|for|with|showing)\s+(.+)$/,
    build: ([, url]) => ({ intent: 'window.create', url: clean(url) })
  },
  /* ---- navigating an existing window ----
   * Listed before the bare "open X", which would otherwise swallow
   * "open example.com in Research" and treat the whole tail as an address. */
  {
    id: 'window.navigate',
    pattern: /^(?:open|load|show|go to|navigate to)\s+(.+?)\s+(?:in|on)\s+(.+)$/,
    build: ([, url, target]) => ({ intent: 'window.navigate', url: clean(url), target: clean(target) })
  },
  {
    id: 'window.open',
    /* "open youtube" versus "open Research" cannot be told apart by shape —
     * it depends on whether a window by that name exists, which the pattern
     * cannot know. Resolution decides. */
    pattern: /^(?:open|go to|browse to|visit|pull up)\s+(.+)$/,
    build: ([, phrase]) => ({ intent: 'window.open', phrase: clean(phrase) })
  },

  /* ---- lifecycle ---- */
  {
    id: 'window.close',
    pattern: /^(?:close|remove|delete|get rid of|dismiss)\s+(?:the\s+)?(.+?)(?:\s+(?:window|screen|tab))?$/,
    build: ([, target]) => ({ intent: 'window.close', target: clean(target) })
  },
  {
    id: 'window.duplicate',
    pattern: /^(?:duplicate|copy|clone)\s+(?:the\s+)?(.+?)(?:\s+(?:window|screen|tab))?$/,
    build: ([, target]) => ({ intent: 'window.duplicate', target: clean(target) })
  },
  {
    id: 'window.lock',
    pattern: /^(?:lock|pin|freeze)\s+(?:the\s+)?(.+?)(?:\s+(?:window|screen))?$/,
    build: ([, target]) => ({ intent: 'window.lock', target: clean(target), locked: true })
  },
  {
    id: 'window.unlock',
    pattern: /^(?:unlock|unpin|unfreeze)\s+(?:the\s+)?(.+?)(?:\s+(?:window|screen))?$/,
    build: ([, target]) => ({ intent: 'window.lock', target: clean(target), locked: false })
  },
  {
    id: 'window.rename.to',
    /* Greedy on the left so the LAST "to" is the separator: "rename the
     * Chromium POC to Research" must not read as target "chromium". */
    pattern: /^(?:rename|call|name)\s+(?:the\s+)?(.+)\s+to\s+["']?(.+?)["']?$/,
    build: ([, target, name]) => ({ intent: 'window.rename', target: clean(target), name: clean(name) })
  },
  {
    id: 'window.rename.bare',
    /* "call this Research" — no separator, so the name is the last word or two. */
    pattern: /^(?:rename|call|name)\s+(this|that|it|the\s+\S+(?:\s+\S+)?)\s+["']?([\w-]+(?:\s+[\w-]+)?)["']?$/,
    build: ([, target, name]) => ({ intent: 'window.rename', target: clean(target), name: clean(name) })
  },

  /* ---- the workspace as a whole ----
   * Before window.focus, whose "switch to" would otherwise capture
   * "switch to surround" as the name of a window. */
  {
    id: 'workspace.layout',
    pattern: new RegExp(`^(?:arrange|organize|organise|set up|switch to|put me in|lay out)\\s+(?:everything\\s+|the workspace\\s+|my workspace\\s+)?(?:for\\s+|in\\s+|to\\s+|into\\s+)?(?:a\\s+|the\\s+)?(${LAYOUT_PATTERN})(?:\\s+(?:mode|layout|workspace))?$`),
    build: ([, layout]) => ({ intent: 'workspace.layout', layout: LAYOUT_ALIASES[layout] })
  },
  {
    id: 'workspace.arrange',
    pattern: /^(?:arrange|tidy|organize|organise)\s+(?:everything|the workspace|my windows|these)$/,
    build: () => ({ intent: 'workspace.arrange' })
  },
  {
    id: 'workspace.save',
    pattern: /^(?:save|remember|keep)\s+(?:this|the current)\s+(?:layout|workspace|arrangement)$/,
    build: () => ({ intent: 'workspace.save' })
  },

  /* ---- attention ---- */
  {
    id: 'window.focus',
    pattern: /^(?:focus|select|show me|bring up|switch to|look at)\s+(?:the\s+)?(.+?)(?:\s+(?:window|screen))?$/,
    build: ([, target]) => ({ intent: 'window.focus', target: clean(target) })
  },

  /* ---- placement ---- */
  {
    id: 'window.move',
    pattern: new RegExp(`^(?:move|push|put|shift|bring|send)\\s+(?:the\\s+)?(.+?)\\s+(?:to\\s+(?:my|the)\\s+|to\\s+|)(${DIRECTION_PATTERN})$`),
    build: ([, target, direction]) => ({
      intent: 'window.move',
      target: clean(target),
      direction: DIRECTIONS[direction]
    })
  },
  {
    id: 'window.resize.bigger',
    pattern: /^(?:make|grow|scale)\s+(?:the\s+)?(.+?)\s+(?:bigger|larger|wider)$/,
    build: ([, target]) => ({ intent: 'window.resize', target: clean(target), factor: 1.2 })
  },
  {
    id: 'window.resize.smaller',
    pattern: /^(?:make|shrink|scale)\s+(?:the\s+)?(.+?)\s+(?:smaller|tinier|narrower)$/,
    build: ([, target]) => ({ intent: 'window.resize', target: clean(target), factor: 1 / 1.2 })
  },

  /* ---- the workspace as a whole ---- */
  {
    id: 'workspace.mode.arrange',
    pattern: /^(?:arrange mode|edit mode|move things|let me move things|start arranging)$/,
    build: () => ({ intent: 'workspace.mode', mode: 'arrange' })
  },
  {
    id: 'workspace.mode.browse',
    pattern: /^(?:browse mode|browsing mode|done arranging|stop arranging|let me browse)$/,
    build: () => ({ intent: 'workspace.mode', mode: 'browse' })
  },

  /* ---- searching what the windows contain ---- */
  {
    id: 'workspace.find',
    pattern: /^(?:find|search for|look for|where is|which window has|what window has|who has)\s+(?:the\s+)?(?:window\s+)?(?:about\s+|with\s+|containing\s+|showing\s+|for\s+)?(.+)$/,
    build: ([, query]) => ({ intent: 'workspace.find', query: clean(query) })
  }
];

/*
 * Resolve a window intent against the live workspace.
 *
 * Only the shapes that name an existing window need resolution; creating one,
 * arranging the workspace and searching do not.
 */
export const resolveWindowIntent = (intent, context, resolve) => {
  if (intent.intent === 'window.open') {
    const existing = resolve(intent.phrase, context);
    if (existing.ok) return { ok: true, intent: 'window.focus', target: existing.node };
    const destination = normalizeBrowserInput(intent.phrase);
    if (!destination.ok || !destination.url) {
      return { ok: false, reason: 'not-found', phrase: intent.phrase };
    }
    return { ok: true, intent: 'window.create', url: destination.url };
  }

  if (intent.intent === 'window.create') {
    const destination = intent.url ? normalizeBrowserInput(intent.url) : null;
    if (intent.url && !destination.ok) {
      return { ok: false, reason: 'bad-url', phrase: intent.url };
    }
    return { ok: true, intent: 'window.create', url: destination ? destination.url : '' };
  }

  if (intent.intent === 'workspace.layout'
    || intent.intent === 'workspace.arrange'
    || intent.intent === 'workspace.save'
    || intent.intent === 'workspace.mode'
    || intent.intent === 'workspace.find') {
    return { ok: true, ...intent };
  }

  const target = resolve(intent.target, context);
  if (!target.ok) return { ...target, phrase: intent.target };

  if (intent.intent === 'window.navigate') {
    const destination = normalizeBrowserInput(intent.url);
    if (!destination.ok) return { ok: false, reason: 'bad-url', phrase: intent.url };
    return { ok: true, intent: 'window.navigate', target: target.node, url: destination.url };
  }

  return { ok: true, ...intent, target: target.node };
};
