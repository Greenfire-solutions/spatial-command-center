/*
 * Turns controller buttons into actions, according to the binding table.
 *
 * One component reads every bound input, so there is a single place where a
 * button press becomes something happening. Push-to-talk, text editing and the
 * keyboard toggle all arrive here, and none of them knows which button caused
 * it: that is configuration, and the user owns it.
 *
 * Text actions apply only while a screen has keyboard focus. That is what makes
 * a handful of buttons enough: the same buttons mean nothing while you are
 * flying, so binding "enter" to A does not cost you A everywhere else.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useXRInputSourceState } from '@react-three/xr';

import { setPushToTalk, startVoiceChannel, stopVoiceChannel } from '../commands/voice-channel.js';
import { resolveBrowserProvider } from '../providers/index.js';
import { useStore } from '../store/workspace-store.js';
import { createScreenInFront } from '../systems/workspace-actions.js';
import { getBinding, isPressed, onBindingsChange } from './bindings.js';
import { toggleKeyboard } from './keyboard-state.js';

/* Held keys repeat, because deleting a mistyped path one press at a time is the
 * fastest way to make someone take the headset off. */
const REPEAT_DELAY_MS = 420;
const REPEAT_RATE_MS = 45;

const keyEvent = (type, keyCode, modifiers = []) => ({ type, keyCode, modifiers });

export const XrControllerBindings = ({ onToggleKeyboard = () => {} }) => {
  const left = useXRInputSourceState('controller', 'left');
  const right = useXRInputSourceState('controller', 'right');
  const held = useRef({});
  const repeat = useRef({});
  const version = useRef(0);

  useEffect(() => onBindingsChange(() => { version.current += 1; }), []);

  useEffect(() => {
    startVoiceChannel();
    return () => {
      setPushToTalk(false);
      stopVoiceChannel();
    };
  }, []);

  const focusedSource = useCallback(() => {
    const state = useStore.getState();
    const screen = state.screens.find((entry) => entry.id === state.selectedScreen);
    const sourceId = screen && screen.source && screen.source.sourceId;
    if (!sourceId) return null;
    const provider = resolveBrowserProvider();
    return provider.available ? { provider, sourceId, screen } : null;
  }, []);

  const sendKey = useCallback((keyCode, modifiers = []) => {
    const target = focusedSource();
    if (!target) return false;
    target.provider.sendKeyboardEvent(target.sourceId, keyEvent('keyDown', keyCode, modifiers));
    target.provider.sendKeyboardEvent(target.sourceId, keyEvent('keyUp', keyCode, modifiers));
    return true;
  }, [focusedSource]);

  const perform = useCallback((actionId) => {
    switch (actionId) {
      case 'text.enter':
        return sendKey('Return');
      case 'text.backspace':
        return sendKey('Backspace');
      case 'text.tab':
        return sendKey('Tab');
      case 'text.escape':
        return sendKey('Escape');
      case 'text.deleteLine':
        /* Ctrl+U clears the line in a shell and in most readline-style inputs,
         * which is the behaviour asked for rather than a literal "delete". */
        return sendKey('u', ['control']);
      case 'keyboard.toggle':
        toggleKeyboard({ mode: 'page', screenId: useStore.getState().selectedScreen });
        onToggleKeyboard();
        return true;
      /* Adding a window is the one workspace action that has to exist on a
       * controller: the DOM button that adds one renders nothing inside a
       * session, so without this a wearer cannot open a window at all. It
       * places the screen, selects it, and opens its address field in one
       * press. */
      case 'window.add':
        createScreenInFront();
        return true;
      default:
        return false;
    }
  }, [onToggleKeyboard, sendKey]);

  useFrame(() => {
    const now = performance.now();
    const controllers = { left, right };

    const read = (actionId) => {
      const binding = getBinding(actionId);
      if (!binding || !binding.input) return false;
      const controller = controllers[binding.hand];
      return isPressed(controller?.gamepad?.[binding.input]);
    };

    /* Push-to-talk is a hold, and the only action that runs regardless of what
     * is focused. A latch left open is how a room conversation becomes a
     * command. */
    const talking = read('voice.pushToTalk');
    if (talking !== held.current['voice.pushToTalk']) {
      held.current['voice.pushToTalk'] = talking;
      setPushToTalk(talking);
    }

    for (const actionId of ['text.enter', 'text.backspace', 'text.deleteLine', 'text.tab', 'text.escape', 'keyboard.toggle', 'window.add']) {
      const down = read(actionId);
      const was = held.current[actionId];
      if (down === was) {
        /* Repeat only for the destructive-but-granular one. Repeating "enter"
         * would run a command per frame. */
        if (down && actionId === 'text.backspace') {
          const state = repeat.current[actionId];
          if (state && now - state.since > REPEAT_DELAY_MS && now - state.last > REPEAT_RATE_MS) {
            state.last = now;
            perform(actionId);
          }
        }
        continue;
      }
      held.current[actionId] = down;
      if (down) {
        repeat.current[actionId] = { since: now, last: now };
        perform(actionId);
      } else {
        delete repeat.current[actionId];
      }
    }
  });

  return null;
};

export default XrControllerBindings;
