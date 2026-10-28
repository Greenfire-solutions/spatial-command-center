import { CONNECTION_MODES, normalizeCapabilities } from '../connectors/connector-schema.js';
import { resolveConnectorIntent } from './connector-commands.js';
import { interpret, resolveChoice } from './interpret.js';
import { resolveWindowIntent } from './window-commands.js';
import { executeWindowIntent } from './execute-window-intent.js';
import { resolveNode } from './resolve-node.js';

/*
 * Carrying out a spoken connector command.
 *
 * The important property here is what this module does *not* do: it never
 * mutates state itself. It calls the same store actions a mouse drag calls, so
 * "connect Research to Claude" and dragging a handle from Research to Claude
 * are the same operation with the same permission defaults — §1's requirement
 * that voice be an input layer rather than a parallel implementation.
 *
 * Everything is injected, so the whole path from utterance to outcome is
 * testable without a microphone, a store, or a browser.
 */

const REASONS = {
  empty: 'I did not catch that.',
  unrecognized: null, // not a connector command; the caller may try other handlers
  'not-found': (result) => `I could not find a window called "${result.phrase}".`,
  'no-focus': () => 'Nothing is focused, so I do not know what "this" means.',
  'same-node': () => 'That is already the same window.',
  'no-connector': () => 'I do not know which connection you mean. Draw one, or name both ends.',
  'not-an-agent': (result) => `"${result.phrase}" is a window, not an agent.`,
  'bad-url': (result) => `"${result.phrase}" does not look like a web address.`
};

/* Spoken names arrive lowercased with the rest of the utterance. */
const asName = (value) => String(value || '')
  .trim()
  .replace(/\b\w/g, (character) => character.toUpperCase());

const CAPABILITY_NAMES = {
  title: 'title', url: 'address', text: 'readable text', headings: 'headings',
  links: 'links', images: 'images', videos: 'videos', metadata: 'metadata',
  structuredData: 'structured data', selection: 'selection'
};

const listCapabilities = (capabilities) => (capabilities || [])
  .map((capability) => CAPABILITY_NAMES[capability] || capability)
  .join(', ');

/* Apply a spoken permission change to the list a connector already holds.
 * Narrowing, widening and removing are all expressed against what is there
 * rather than replacing it, because "also send the images" is meaningless
 * otherwise. */
const applyPermission = (existing, operation, requested) => {
  const current = existing || [];
  if (operation === 'only') return requested.slice();
  if (operation === 'add') {
    const next = current.slice();
    for (const capability of requested) if (!next.includes(capability)) next.push(capability);
    return next;
  }
  return current.filter((capability) => !requested.includes(capability));
};

/*
 * Run one utterance.
 *
 * Returns { handled, ok, message, connectorId } rather than throwing, because
 * a voice loop must keep listening after a command it could not carry out.
 * `handled: false` means this was not a connector command at all, which lets a
 * caller pass the utterance to other command families.
 */
export const executeConnectorUtterance = async (utterance, context, actions) => {
  /* Answering a question we asked takes precedence over starting a new
   * command, so "the second one" is not read as a fresh instruction. */
  if (context.pendingChoices && context.pendingChoices.length > 0) {
    const answer = resolveChoice(utterance, context.pendingChoices);
    if (answer.ok) {
      return executeResolved({ ok: true, ...answer.choice }, context, actions);
    }
    if (answer.reason === 'cancelled') {
      return { handled: true, ok: true, clearChoices: true, message: 'Cancelled.' };
    }
    /* Not an answer at all — fall through and treat it as a new command. */
  }

  const reading = interpret(utterance, context);

  if (!reading.ok) {
    if (reading.reason === 'choose') {
      return {
        handled: true,
        ok: false,
        needsAnswer: true,
        choices: reading.choices,
        message: `${reading.question} ${reading.choices.map((choice, index) => `${index + 1}. ${choice.label}`).join('  ')}`
      };
    }
    return { handled: false, ok: false, message: null };
  }

  /* An inferred reading already carries resolved nodes; a parsed one carries
   * phrases that still have to be matched against the workspace. */
  const isWindowFamily = reading.intent.family === 'window'
    || String(reading.intent.intent || '').startsWith('window.')
    || String(reading.intent.intent || '').startsWith('workspace.');

  const resolved = reading.source === 'inferred'
    ? { ok: true, ...reading.intent }
    : (isWindowFamily
        ? resolveWindowIntent(reading.intent, context, resolveNode)
        : resolveConnectorIntent(reading.intent, context));

  return executeResolved(resolved, context, actions, { inferred: reading.source === 'inferred' });
};

const executeResolved = async (resolved, context, actions, { inferred = false } = {}) => {
  /* The workspace family has its own executor; routing here keeps one entry
   * point for voice while letting each family own what its commands mean. */
  if (String(resolved.intent || '').startsWith('window.')
    || String(resolved.intent || '').startsWith('workspace.')) {
    if (!resolved.ok) {
      const describe = REASONS[resolved.reason];
      return {
        handled: true,
        ok: false,
        needsAnswer: resolved.reason === 'ambiguous',
        question: resolved.question,
        message: resolved.question
          || (typeof describe === 'function' ? describe(resolved) : 'I could not do that.')
      };
    }
    return executeWindowIntent(resolved, actions);
  }

  if (!resolved.ok) {
    if (resolved.reason === 'ambiguous') {
      return { handled: true, ok: false, message: resolved.question, needsAnswer: true };
    }
    const describe = REASONS[resolved.reason];
    return {
      handled: true,
      ok: false,
      message: typeof describe === 'function' ? describe(resolved) : 'I could not do that.'
    };
  }

  if (resolved.intent === 'connector.list') {
    const related = actions.connectorsForNode(resolved.source.id, resolved.source.kind);
    if (related.length === 0) {
      return { handled: true, ok: true, message: `${resolved.source.name} is not connected to anything.` };
    }
    const names = related.map((connector) => {
      const otherId = connector.sourceId === resolved.source.id ? connector.targetId : connector.sourceId;
      const mode = CONNECTION_MODES[connector.mode]?.label ?? connector.mode;
      return `${actions.nameFor(otherId)} (${mode})`;
    });
    return {
      handled: true,
      ok: true,
      message: `${resolved.source.name} is connected to ${names.join(', ')}.`
    };
  }

  if (resolved.intent === 'connector.remove') {
    const related = actions.connectorsForNode(resolved.source.id, resolved.source.kind);
    const match = related.find((connector) => (
      connector.sourceId === resolved.target.id || connector.targetId === resolved.target.id
    ));
    if (!match) {
      return {
        handled: true,
        ok: false,
        message: `${resolved.source.name} and ${resolved.target.name} are not connected.`
      };
    }
    actions.removeConnector(match.id);
    return {
      handled: true,
      ok: true,
      message: `Disconnected ${resolved.source.name} from ${resolved.target.name}.`
    };
  }

  if (resolved.intent === 'agent.create') {
    const name = asName(resolved.name);
    const agentId = actions.addAgent({ name });
    return {
      ok: Boolean(agentId),
      handled: true,
      agentId,
      message: agentId
        ? `Added ${name}. It has no model connected yet.`
        : 'I could not add that agent.'
    };
  }

  if (resolved.intent === 'agent.remove') {
    actions.removeAgent(resolved.agent.id);
    return { handled: true, ok: true, message: `Removed ${resolved.agent.name}.` };
  }

  /* Commands that act on a connector already in hand or named by its ends. */
  if (resolved.intent === 'connector.toggle'
    || resolved.intent === 'connector.configure'
    || resolved.intent === 'connector.permit'
    || (resolved.intent === 'connector.run' && (resolved.connectorId || resolved.target))) {

    const connector = resolved.connectorId
      ? actions.connectorById(resolved.connectorId)
      : actions.connectorBetween(resolved.source, resolved.target);

    if (!connector) {
      return { handled: true, ok: false, message: 'Those are not connected.' };
    }

    if (resolved.intent === 'connector.toggle') {
      actions.setConnectorEnabled(connector.id, resolved.enabled);
      return {
        handled: true,
        ok: true,
        message: resolved.enabled ? 'Connection turned on.' : 'Connection turned off.'
      };
    }

    if (resolved.intent === 'connector.configure') {
      actions.configureConnector(connector.id, { mode: resolved.mode });
      const definition = CONNECTION_MODES[resolved.mode];
      return {
        handled: true,
        ok: true,
        message: `Now ${definition.label}. Reads ${listCapabilities(definition.defaultCapabilities)}.`
      };
    }

    if (resolved.intent === 'connector.permit') {
      const next = applyPermission(connector.capabilities, resolved.operation, resolved.capabilities);
      /* Re-checked against the mode rather than trusted: a spoken widening
       * must not reach past what the connection's mode allows, and a forbidden
       * category must be refused here exactly as it is everywhere else. */
      const permitted = normalizeCapabilities(next, connector.mode);

      /* Asking for something the mode does not allow is a refusal, not a
       * silent no-op. Reporting "reads nothing" when the user asked for links
       * tells them the opposite of what happened, and hides the one thing that
       * would fix it. */
      if (permitted.outOfScope?.length > 0) {
        const mode = CONNECTION_MODES[connector.mode];
        const refused = listCapabilities(permitted.outOfScope);
        return {
          handled: true,
          ok: false,
          message: `${mode.label} cannot read ${refused}; it reads `
            + `${listCapabilities(mode.defaultCapabilities)}. `
            + `Say "make this connection an extract" first.`
        };
      }

      actions.configureConnector(connector.id, {
        mode: connector.mode,
        capabilities: permitted.granted
      });
      return {
        handled: true,
        ok: true,
        message: permitted.granted.length === 0
          ? 'That connection now reads nothing.'
          : `Now reads ${listCapabilities(permitted.granted)}.`
      };
    }

    /* connector.run with a named pair. */
    const outcome = await actions.runConnector(connector);
    return {
      handled: true,
      ok: Boolean(outcome?.ok),
      message: outcome?.ok
        ? `Sent from ${actions.nameFor(connector.sourceId)}.`
        : (outcome?.message || 'That connection could not run.')
    };
  }

  /* Running everything that leaves a node: "extract everything from this page". */
  if (resolved.intent === 'connector.run') {
    const outgoing = actions.connectorsForNode(resolved.source.id, resolved.source.kind)
      .filter((connector) => connector.sourceId === resolved.source.id
        && connector.enabled !== false
        && !connector.unconfigured
        && connector.mode !== 'reference');

    if (outgoing.length === 0) {
      return {
        handled: true,
        ok: false,
        message: `${resolved.source.name} is not connected to anything that would carry it.`
      };
    }

    const outcomes = await Promise.all(outgoing.map((connector) => actions.runConnector(connector)));
    const succeeded = outcomes.filter((outcome) => outcome?.ok).length;
    return {
      handled: true,
      ok: succeeded > 0,
      message: succeeded === outgoing.length
        ? `Sent ${resolved.source.name} to ${succeeded === 1 ? 'its connection' : `all ${succeeded} connections`}.`
        : `Sent ${succeeded} of ${outgoing.length}. ${outcomes.find((o) => !o?.ok)?.message || ''}`.trim()
    };
  }

  /* Creating. The same action a drag uses, including its duplicate check and
   * its default-least permission. */
  const connectorId = actions.connectWindows({
    sourceId: resolved.source.id,
    sourceKind: resolved.source.kind,
    targetId: resolved.target.id,
    targetKind: resolved.target.kind,
    mode: resolved.mode,
    capabilities: resolved.capabilities
  });

  if (!connectorId) {
    return { handled: true, ok: false, message: 'I could not make that connection.' };
  }

  /* A spoken command that named a mode has already answered the question the
   * panel would ask, so it is configured rather than left provisional. Saying
   * only "connect" leaves the panel to open, which is correct: the user did
   * not say what they wanted, and the default reads almost nothing. */
  const named = resolved.mode && resolved.mode !== 'reference';
  if (named || resolved.capabilities) {
    actions.configureConnector(connectorId, {
      mode: resolved.mode,
      capabilities: resolved.capabilities
    });
  }

  const modeLabel = CONNECTION_MODES[resolved.mode]?.label ?? resolved.mode;
  return {
    handled: true,
    ok: true,
    connectorId,
    message: named
      ? `Connected ${resolved.source.name} to ${resolved.target.name}: ${modeLabel}.`
      : `Connected ${resolved.source.name} to ${resolved.target.name}. How should they be connected?`
  };
};
