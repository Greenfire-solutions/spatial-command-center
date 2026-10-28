/*
 * Headset telemetry.
 *
 * A Quest has no console you can read while wearing it, and drei's <Html>
 * renders nothing inside an immersive session, so a failure in a headset is
 * normally invisible: you see black and learn nothing. This module collects
 * what is worth knowing and posts it back to the dev server, which appends it
 * to a log the developer can tail.
 *
 * Development instrumentation only. It is installed by the headset entry point
 * and gated on the dev server actually exposing the endpoint, so it can never
 * ship inside the desktop application.
 */

const ENDPOINT = '/__diag';
const FLUSH_INTERVAL_MS = 2000;
const MAX_QUEUE = 200;

const state = {
  installed: false,
  queue: [],
  seq: 0,
  sessionId: Math.random().toString(36).slice(2, 8),
  frames: 0,
  lastFrameAt: 0,
  facts: {},
  errors: []
};

const push = (kind, payload) => {
  if (state.queue.length >= MAX_QUEUE) state.queue.shift();
  state.seq += 1;
  state.queue.push({
    seq: state.seq,
    at: new Date().toISOString(),
    kind,
    ...payload
  });
};

/* Errors are kept separately as well as queued, so the in-scene HUD can show
 * the most recent one without waiting for a round trip. */
export const recordError = (source, error) => {
  const entry = {
    source,
    message: error && (error.message || String(error)),
    stack: error && error.stack ? String(error.stack).split('\n').slice(0, 4).join(' | ') : null
  };
  state.errors.push(entry);
  if (state.errors.length > 10) state.errors.shift();
  push('error', entry);
};

export const recordFact = (key, value) => {
  state.facts[key] = value;
  push('fact', { key, value });
};

export const recordEvent = (name, detail) => push('event', { name, detail: detail ?? null });

export const noteFrame = () => {
  state.frames += 1;
  state.lastFrameAt = Date.now();
};

export const diagnosticsSnapshot = () => ({
  frames: state.frames,
  lastError: state.errors.length ? state.errors[state.errors.length - 1] : null,
  facts: state.facts,
  sessionId: state.sessionId
});

const flush = async () => {
  if (!state.queue.length) return;
  const batch = state.queue.splice(0, state.queue.length);
  /* Only a served page has a sink. The desktop app loads from file://, where
   * this request can only fail and printed an error on every start. */
  if (typeof window !== 'undefined' && !/^https?:$/.test(window.location.protocol)) return;
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      /* keepalive lets a final batch survive the page being torn down, which is
       * exactly when the most interesting failure tends to happen. */
      keepalive: true,
      body: JSON.stringify({
        sessionId: state.sessionId,
        userAgent: navigator.userAgent,
        frames: state.frames,
        entries: batch
      })
    });
  } catch {
    /* The endpoint is optional. Losing telemetry must never break the page. */
  }
};

/*
 * WebGL and XR capability facts, gathered once.
 *
 * These are the questions that cannot be answered from the desktop: which GL
 * driver the headset browser actually gave us, whether the context survived,
 * and which session modes the runtime admits to supporting.
 */
const captureStaticFacts = async () => {
  /* Which build is actually running. First fact recorded, so it is the first
   * line of every session in the log. */
  recordFact('build', typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'unstamped');
  recordFact('userAgent', navigator.userAgent);
  recordFact('devicePixelRatio', window.devicePixelRatio);
  recordFact('screen', `${window.innerWidth}x${window.innerHeight}`);
  recordFact('secureContext', window.isSecureContext);
  /* Which document is actually running.
   *
   * Without this, a report of "it did not work" cannot be told apart from "it was
   * served over http, where navigator.xr does not exist at all" — and those need
   * opposite fixes. One line removes an entire category of guesswork. */
  recordFact('page.origin', window.location.origin);
  recordFact('page.path', window.location.pathname + window.location.search);
  recordFact('page.xrAvailable', Boolean(navigator.xr));
  recordFact('xrPresent', Boolean(navigator.xr));

  /*
   * Input capabilities, because both are asserted in this codebase and neither
   * has been observed on the device.
   *
   * speech-recognition.js states that Web Speech "is what the Quest browser
   * gives us too", and createSpeechRecognizer degrades to UNSUPPORTED without
   * saying so anywhere a wearer can see. If that assertion is wrong, voice is
   * silently dead in a headset and looks like a bug in the commands. Measure it
   * rather than argue about it.
   */
  recordFact('speechRecognition', Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
  recordFact('speechSynthesis', Boolean(window.speechSynthesis));
  recordFact('getUserMedia', Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));

  if (navigator.xr) {
    for (const mode of ['immersive-vr', 'immersive-ar']) {
      try {
        recordFact(`supports:${mode}`, await navigator.xr.isSessionSupported(mode));
      } catch (error) {
        recordFact(`supports:${mode}`, `threw: ${error && error.message}`);
      }
    }
  }
};

export const installDiagnostics = () => {
  if (state.installed || typeof window === 'undefined') return null;
  state.installed = true;

  window.addEventListener('error', (event) => {
    recordError('window.error', event.error || new Error(event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordError('unhandledrejection', event.reason);
  });

  /* Console errors matter as much as thrown ones: three.js and React report
   * most real problems through console.error without throwing. */
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    try {
      push('console.error', { text: args.map((a) => (a && a.message) || String(a)).join(' ').slice(0, 500) });
    } catch { /* never let logging break logging */ }
    originalConsoleError(...args);
  };

  /*
   * Wrap requestSession itself.
   *
   * The last run proved the session never started, yet nothing was recorded:
   * the caller catches the rejection to show a message in the DOM, which is
   * invisible from inside a headset, and a caught rejection never reaches the
   * unhandledrejection handler. Wrapping the API captures the reason wherever
   * it is called from, including from library code.
   */
  if (navigator.xr && typeof navigator.xr.requestSession === 'function') {
    const originalRequestSession = navigator.xr.requestSession.bind(navigator.xr);
    navigator.xr.requestSession = (mode, options) => {
      recordEvent('requestSession:call', { mode, options: options ? Object.keys(options) : null });
      const started = Date.now();
      return originalRequestSession(mode, options).then(
        (session) => {
          recordEvent('requestSession:granted', { mode, ms: Date.now() - started });
          /* Only answerable once a session exists, and it decides whether text
           * entry uses the headset's own keyboard or our drawn one. */
          recordFact('isSystemKeyboardSupported', Boolean(session.isSystemKeyboardSupported));
          recordFact('enabledFeatures', (session.enabledFeatures || []).join(',') || 'none');
          session.addEventListener('end', () => recordEvent('xr-session:end', { mode }));
          return session;
        },
        (reason) => {
          recordError('requestSession', reason instanceof Error ? reason : new Error(String(reason)));
          recordEvent('requestSession:rejected', {
            mode,
            ms: Date.now() - started,
            name: reason && reason.name,
            message: reason && reason.message
          });
          throw reason;
        }
      );
    };
  }

  captureStaticFacts();
  setInterval(flush, FLUSH_INTERVAL_MS);
  window.addEventListener('pagehide', flush);
  recordEvent('diagnostics-installed');
  return { flush, snapshot: diagnosticsSnapshot };
};

/*
 * Renderer facts, once the WebGL context exists.
 *
 * Called from inside the scene because the renderer is not reachable before
 * R3F creates it.
 */
export const recordRendererFacts = (gl) => {
  if (!gl) return;
  try {
    const context = gl.getContext();
    recordFact('gl.version', context.getParameter(context.VERSION));
    recordFact('gl.vendor', context.getParameter(context.VENDOR));
    recordFact('gl.renderer', context.getParameter(context.RENDERER));
    recordFact('gl.contextLost', context.isContextLost());
    recordFact('gl.xrEnabled', Boolean(gl.xr && gl.xr.enabled));
    recordFact('gl.maxTextureSize', context.getParameter(context.MAX_TEXTURE_SIZE));
  } catch (error) {
    recordError('recordRendererFacts', error);
  }
};
