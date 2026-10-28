/*
 * Speech input, behind an interface.
 *
 * Web Speech is what a browser gives us today, and it is what the Quest
 * browser gives us too. It is not what we will always use: Whisper, a local
 * transcriber, or a Quest-specific microphone path are all plausible, and §11
 * requires that swapping one for another not touch a single command.
 *
 * So nothing above this file mentions Web Speech. A recognizer is an object
 * with start(), stop(), and a callback that reports finished utterances; the
 * commands consume strings and know nothing about where they came from — the
 * same seam that lets BrowserSourceProvider be tested without Electron.
 */

export const RECOGNIZER_STATES = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  DENIED: 'denied',
  UNSUPPORTED: 'unsupported'
});

/*
 * A recognizer that reports transcripts.
 *
 * `factory` is injected so tests can supply a fake that emits utterances on
 * demand. In the browser it defaults to whichever Web Speech constructor
 * exists, and reports UNSUPPORTED rather than throwing when there is none —
 * an absent microphone must degrade to "voice is unavailable", never to a
 * broken workspace.
 */
export const createSpeechRecognizer = ({
  factory = null,
  lang = 'en-US',
  continuous = true,
  onTranscript = () => {},
  onStateChange = () => {}
} = {}) => {
  const Recognition = factory
    ?? (typeof window !== 'undefined'
      ? (window.SpeechRecognition || window.webkitSpeechRecognition)
      : null);

  if (!Recognition) {
    onStateChange(RECOGNIZER_STATES.UNSUPPORTED);
    return {
      supported: false,
      state: RECOGNIZER_STATES.UNSUPPORTED,
      start: () => false,
      stop: () => {},
      dispose: () => {}
    };
  }

  const recognition = new Recognition();
  recognition.lang = lang;
  recognition.continuous = continuous;
  recognition.interimResults = false;
  /* One alternative is enough: the command parser is deterministic, so a
   * second-best transcript is far more likely to be a wrong command than a
   * useful one. */
  recognition.maxAlternatives = 1;

  let state = RECOGNIZER_STATES.IDLE;
  let wanted = false;

  const setState = (next) => {
    if (state === next) return;
    state = next;
    onStateChange(next);
  };

  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (!result.isFinal) continue;
      const transcript = result[0]?.transcript?.trim();
      if (transcript) onTranscript(transcript);
    }
  };

  recognition.onerror = (event) => {
    if (event?.error === 'not-allowed' || event?.error === 'service-not-allowed') {
      wanted = false;
      setState(RECOGNIZER_STATES.DENIED);
    }
  };

  /* Continuous recognition ends by itself on silence in most implementations.
   * Restart while listening is still wanted, so a user is not silently dropped
   * mid-session — but never after a denial, which would loop on a permission
   * prompt. */
  recognition.onend = () => {
    if (wanted && state !== RECOGNIZER_STATES.DENIED) {
      try { recognition.start(); return; } catch { /* fall through to idle */ }
    }
    setState(RECOGNIZER_STATES.IDLE);
  };

  return {
    supported: true,
    get state() { return state; },
    start() {
      if (state === RECOGNIZER_STATES.DENIED) return false;
      wanted = true;
      try {
        recognition.start();
        setState(RECOGNIZER_STATES.LISTENING);
        return true;
      } catch {
        /* start() throws if already started, which is not an error worth
         * surfacing — it means we are already in the state being asked for. */
        return state === RECOGNIZER_STATES.LISTENING;
      }
    },
    stop() {
      wanted = false;
      try { recognition.stop(); } catch { /* already stopped */ }
      setState(RECOGNIZER_STATES.IDLE);
    },
    dispose() {
      wanted = false;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try { recognition.abort?.(); } catch { /* already gone */ }
    }
  };
};
