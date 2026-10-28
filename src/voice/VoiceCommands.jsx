import { useEffect, useRef, useState } from 'react';

import { runUtterance } from '../commands/run-utterance.js';
import { createWorkspaceActions } from '../commands/window-actions.js';
import { onVoiceChannel } from '../commands/voice-channel.js';
import { RECOGNIZER_STATES, createSpeechRecognizer } from './speech-recognition.js';

/*
 * Voice as an input layer.
 *
 * This component owns the microphones and nothing else. There are two, because
 * the useful microphone is in a different place depending on where the page is:
 *
 *   Web Speech, in the page — the desktop. Push-to-talk on a held key.
 *   The bridge (commands/voice-channel.js) — a headset, whose page cannot
 *   reach the microphone on the desk, and whose push-to-talk is a controller
 *   button rather than a key.
 *
 * Both hand finished transcripts to the same runUtterance, so they are two
 * transports for one act rather than two behaviours. That includes the pending
 * question: a clarification asked after a spoken command must be answerable by
 * the next utterance whichever microphone carried it, which is why the runner
 * owns that state and this component does not.
 *
 * It renders no geometry and no DOM, so it works identically on the desktop and
 * inside an immersive session — the DOM is where voice would have gone wrong.
 */

export const useVoiceCommands = ({ recognizerFactory = null, holdKey = 'v' } = {}) => {
  const [state, setState] = useState(RECOGNIZER_STATES.IDLE);
  const [heard, setHeard] = useState('');
  const [bridged, setBridged] = useState(false);
  const recognizerRef = useRef(null);
  const workspaceActionsRef = useRef(null);
  if (!workspaceActionsRef.current) workspaceActionsRef.current = createWorkspaceActions();

  /* One handler for both sources. */
  const handleRef = useRef(null);
  handleRef.current = async (transcript) => {
    setHeard(transcript);
    await runUtterance(transcript, { workspaceActions: workspaceActionsRef.current });
  };

  /* --- the local microphone --- */
  useEffect(() => {
    const recognizer = createSpeechRecognizer({
      factory: recognizerFactory,
      onTranscript: (transcript) => handleRef.current(transcript),
      onStateChange: setState
    });
    recognizerRef.current = recognizer;
    return () => recognizer.dispose();
  }, [recognizerFactory]);

  /* --- the bridged microphone ---
   *
   * The channel is started and stopped by the controller bindings, which own
   * push-to-talk in a session. This only listens for what came back, so a
   * transcript from the desk reaches exactly the same pipeline as one spoken
   * into the page. Interim results are ignored: acting on a partial transcript
   * would run half a command. */
  useEffect(() => onVoiceChannel((event) => {
    if (event.type === 'connected') setBridged(Boolean(event.value));
    else if (event.type === 'transcript' && event.final !== false && event.text) {
      handleRef.current(event.text);
    }
  }), []);

  /* --- push to talk, on the desktop ---
   *
   * Ignored while typing, so dictating into an address bar cannot start
   * listening for commands. */
  useEffect(() => {
    const isTyping = () => {
      const active = document.activeElement;
      if (!active) return false;
      const tag = active.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable;
    };

    const down = (event) => {
      if (event.key?.toLowerCase() !== holdKey || event.repeat) return;
      if (isTyping() || event.metaKey || event.ctrlKey || event.altKey) return;
      recognizerRef.current?.start();
    };
    const up = (event) => {
      if (event.key?.toLowerCase() !== holdKey) return;
      recognizerRef.current?.stop();
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [holdKey]);

  return {
    state,
    heard,
    bridged,
    supported: recognizerRef.current?.supported ?? false,
    start: () => recognizerRef.current?.start(),
    stop: () => recognizerRef.current?.stop()
  };
};

/* Mounted for its effects. Voice must not depend on anything being rendered,
 * because inside a session there is no DOM to render into. */
export const VoiceCommands = (props) => {
  useVoiceCommands(props);
  return null;
};

export default VoiceCommands;
