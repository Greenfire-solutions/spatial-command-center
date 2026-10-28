/*
 * Carrying out a spoken workspace command.
 *
 * Same contract as the connector executor and for the same reason: it never
 * mutates state itself, it calls the actions a button or a drag would call, and
 * everything is injected so the whole path is testable without a store, a
 * scene, or a browser.
 */

/* The utterance is lowercased before matching, so a spoken name loses its
 * casing before it is ever captured. Title-casing it back is imperfect — an
 * intentional "iPhone Notes" becomes "Iphone Notes" — but it is much closer to
 * what someone meant than storing "research". */
const asName = (value) => String(value || '')
  .trim()
  .replace(/\b\w/g, (character) => character.toUpperCase());

const DIRECTION_LABEL = {
  left: 'left', right: 'right', up: 'up', down: 'down',
  closer: 'closer', farther: 'further away'
};

/* Why a placement refused. "Locked" and "not in the scene" are different
 * failures and reporting the wrong one sends someone hunting for a padlock
 * that is not there. */
const refusal = (name, outcome) => (outcome === 'locked'
  ? `${name} is locked.`
  : `${name} is not on screen right now.`);

export const executeWindowIntent = async (resolved, actions) => {
  switch (resolved.intent) {
    case 'window.create': {
      const id = actions.addScreen(resolved.url ? { url: resolved.url } : undefined);
      return {
        handled: true,
        ok: Boolean(id),
        screenId: id,
        message: resolved.url ? `Opened ${resolved.url}.` : 'New window.'
      };
    }

    case 'window.navigate': {
      actions.updateScreenUrl(resolved.target.id, resolved.url);
      return { handled: true, ok: true, message: `${resolved.target.name} → ${resolved.url}` };
    }

    case 'window.close': {
      actions.removeScreen(resolved.target.id);
      return { handled: true, ok: true, message: `Closed ${resolved.target.name}.` };
    }

    case 'window.duplicate': {
      const id = actions.duplicateScreen(resolved.target.id);
      return { handled: true, ok: Boolean(id), message: `Duplicated ${resolved.target.name}.` };
    }

    case 'window.lock': {
      /* toggleScreenLock is a toggle, so a spoken absolute — "lock Research" —
       * must not turn a locked window loose. */
      const current = actions.isLocked(resolved.target.id);
      if (current === resolved.locked) {
        return {
          handled: true,
          ok: true,
          message: `${resolved.target.name} is already ${resolved.locked ? 'locked' : 'unlocked'}.`
        };
      }
      actions.toggleScreenLock(resolved.target.id);
      return {
        handled: true,
        ok: true,
        message: `${resolved.locked ? 'Locked' : 'Unlocked'} ${resolved.target.name}.`
      };
    }

    case 'window.rename': {
      const name = asName(resolved.name);
      actions.renameScreen(resolved.target.id, name);
      return { handled: true, ok: true, message: `Now called ${name}.` };
    }

    case 'window.focus': {
      actions.setSelectedScreen(resolved.target.id);
      actions.focusCameraOnScreen?.(resolved.target.id);
      return { handled: true, ok: true, message: `Focused ${resolved.target.name}.` };
    }

    case 'window.move': {
      const moved = actions.moveScreen(resolved.target.id, resolved.direction);
      return {
        handled: true,
        ok: moved === true,
        message: moved === true
          ? `Moved ${resolved.target.name} ${DIRECTION_LABEL[resolved.direction]}.`
          : refusal(resolved.target.name, moved)
      };
    }

    case 'window.resize': {
      const resized = actions.resizeScreen(resolved.target.id, resolved.factor);
      return {
        handled: true,
        ok: resized === true,
        message: resized === true
          ? `${resolved.target.name} ${resolved.factor > 1 ? 'bigger' : 'smaller'}.`
          : refusal(resolved.target.name, resized)
      };
    }

    case 'workspace.layout': {
      actions.applyPreset(resolved.layout);
      return { handled: true, ok: true, message: `Arranged: ${resolved.layout}.` };
    }

    case 'workspace.arrange': {
      actions.arrangeWorkspace();
      return { handled: true, ok: true, message: 'Arranged.' };
    }

    case 'workspace.save': {
      actions.saveCurrent();
      return { handled: true, ok: true, message: 'Layout saved.' };
    }

    case 'workspace.mode': {
      actions.setInteractionMode(resolved.mode);
      return { handled: true, ok: true, message: `${resolved.mode === 'arrange' ? 'Arrange' : 'Browse'} mode.` };
    }

    case 'workspace.find': {
      const results = await actions.searchWorkspace(resolved.query);
      if (results.length === 0) {
        return { handled: true, ok: false, message: `Nothing about "${resolved.query}".` };
      }

      const [best, runnerUp] = results;
      /* One clear result is acted on; a close second is offered, for the same
       * reason an ambiguous name is: focusing the wrong window is cheap to
       * undo but it teaches the user not to trust the answer. */
      if (!runnerUp || best.score - runnerUp.score >= 0.12) {
        actions.setSelectedScreen(best.screen.id);
        actions.focusCameraOnScreen?.(best.screen.id);
        const name = best.screen.name || best.screen.title;
        return {
          handled: true,
          ok: true,
          message: `${name}: matched in ${best.where}.`
        };
      }

      return {
        handled: true,
        ok: false,
        needsAnswer: true,
        choices: results.slice(0, 3).map((result) => ({
          intent: 'window.focus',
          target: {
            id: result.screen.id,
            kind: 'window',
            name: result.screen.name || result.screen.title
          },
          label: `${result.screen.name || result.screen.title}: ${result.where}`
        })),
        message: `Which one? ${results.slice(0, 3)
          .map((result, index) => `${index + 1}. ${result.screen.name || result.screen.title}`)
          .join('  ')}`
      };
    }

    default:
      return { handled: false, ok: false, message: null };
  }
};
