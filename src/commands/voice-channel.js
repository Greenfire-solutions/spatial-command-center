/*
 * The page's half of the voice bridge.
 *
 * A thin, reconnecting WebSocket that carries two things: when push-to-talk is
 * held, and what the machine heard. Everything it receives goes to the same
 * runCommand as typed text, so a spoken command and a typed one are literally
 * the same code path.
 *
 * Same origin by design, so it rides whatever already serves the build and
 * needs no second exposure or certificate.
 */

import { recordEvent } from '../xr/diagnostics.js';

const RECONNECT_MS = 2000;

const state = {
  socket: null,
  wanted: false,
  connected: false,
  dictating: false,
  timer: null
};

const listeners = new Set();

const emit = (event) => {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      /* An observer must never break the channel. */
    }
  }
};

/** Subscribe to channel events: connected, dictating, transcript. */
export const onVoiceChannel = (listener) => {
  listeners.add(listener);
  listener({ type: 'connected', value: state.connected });
  return () => listeners.delete(listener);
};

const endpoint = () => {
  if (typeof window === 'undefined') return null;
  /* The desktop app loads from file://, where there is no server to carry a
   * bridge. Without this the page retried "ws://voice/" every two seconds
   * forever and filled the log with name-resolution errors on every start. */
  if (!/^https?:$/.test(window.location.protocol) || !window.location.host) return null;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/voice`;
};

const connect = () => {
  if (!state.wanted || state.socket) return;
  const url = endpoint();
  if (!url) return;

  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    schedule();
    return;
  }
  state.socket = socket;

  socket.onopen = () => {
    state.connected = true;
    emit({ type: 'connected', value: true });
    recordEvent('voice:connected');
  };

  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'transcript') {
      emit({ type: 'transcript', text: message.text, final: message.final !== false });
    } else if (message.type === 'dictating') {
      state.dictating = Boolean(message.value);
      emit({ type: 'dictating', value: state.dictating });
    }
  };

  const drop = () => {
    state.socket = null;
    if (state.connected) {
      state.connected = false;
      emit({ type: 'connected', value: false });
    }
    schedule();
  };
  socket.onclose = drop;
  socket.onerror = drop;
};

/* Reconnect quietly and forever. The bridge is a developer's laptop process; it
 * will be restarted often, and a headset should not need reloading each time. */
const schedule = () => {
  if (!state.wanted || state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    connect();
  }, RECONNECT_MS);
};

export const startVoiceChannel = () => {
  state.wanted = true;
  connect();
};

export const stopVoiceChannel = () => {
  state.wanted = false;
  if (state.socket) state.socket.close();
  state.socket = null;
};

/**
 * Signal push-to-talk.
 *
 * Idempotent, because a controller button is polled every frame and will report
 * "still held" sixty times a second. Only the transitions cross the wire.
 */
export const setPushToTalk = (down) => {
  if (state.dictating === Boolean(down)) return;
  state.dictating = Boolean(down);
  emit({ type: 'dictating', value: state.dictating });
  if (state.socket && state.socket.readyState === 1) {
    state.socket.send(JSON.stringify({ type: 'ptt', state: down ? 'down' : 'up' }));
  }
  recordEvent(down ? 'voice:ptt-down' : 'voice:ptt-up');
};

export const voiceChannelConnected = () => state.connected;
