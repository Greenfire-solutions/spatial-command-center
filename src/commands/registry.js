import { CONNECTOR_RULES } from './connector-commands.js';
import { WINDOW_RULES } from './window-commands.js';

/*
 * One grammar, assembled from families.
 *
 * Each family owns its own rule table; the registry parses across all of them
 * in one pass so a new family — screens, agents, environment, whatever comes
 * next — becomes speakable by being added here, and inherits the tolerant
 * interpretation layer without writing a single alternative phrasing down.
 *
 * Order across families matters for the same reason it matters within one:
 * connector rules are narrower and are tried first, so "connect Research to
 * Claude" is never read as a window command that happens to contain "to".
 */
const FAMILIES = [
  { family: 'connector', rules: CONNECTOR_RULES },
  { family: 'window', rules: WINDOW_RULES }
];

const clean = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[.,!?]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/*
 * Parse an utterance against every family.
 *
 * Returns { ok: true, family, rule, ...intent } or { ok: false, reason }.
 * A rule that matches but cannot name what it needs is treated as a miss, so
 * a near-miss falls through to the next rule rather than producing a command
 * with a hole in it.
 */
export const parseUtterance = (utterance) => {
  const text = clean(utterance);
  if (!text) return { ok: false, reason: 'empty' };

  for (const { family, rules } of FAMILIES) {
    for (const rule of rules) {
      const match = text.match(rule.pattern);
      if (!match) continue;
      const built = rule.build(match);
      if (!built) continue;
      if (built.intent === 'connector.permit' && !built.capabilities) continue;
      if (built.intent === 'connector.configure' && !built.mode) continue;
      if (built.intent === 'workspace.layout' && !built.layout) continue;
      if (built.intent === 'window.move' && !built.direction) continue;
      return { ok: true, family, rule: rule.id, ...built };
    }
  }

  return { ok: false, reason: 'unrecognized', text };
};

/* Every rule id, for tests and for a help surface that should list what can
 * actually be said rather than a hand-written copy of it. */
export const ALL_RULES = FAMILIES.flatMap(({ family, rules }) => (
  rules.map((rule) => ({ family, id: rule.id }))
));
