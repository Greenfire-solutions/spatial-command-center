/*
 * Where the spatial keyboard is pointed.
 *
 * Kept outside React because three different things open it: tapping the
 * in-scene address field, a controller binding, and eventually a voice command.
 * A module-level store lets all three agree without threading callbacks through
 * the scene graph.
 *
 * Two modes, because text has two destinations and they are not the same:
 *
 *   'address'  the workspace's own address field. Typing edits a local buffer
 *              and Enter navigates. The page never sees these keystrokes.
 *   'page'     the Chromium source itself, through insertText and key events.
 *              This is how you type into a form, or into a shell.
 */

const state = {
  open: false,
  mode: 'page',
  screenId: null,
  buffer: '',
  shift: false
};

const listeners = new Set();

const announce = () => {
  const snapshot = { ...state };
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch {
      /* An observer must never break input. */
    }
  }
};

export const keyboardState = () => ({ ...state });

export const onKeyboard = (listener) => {
  listeners.add(listener);
  listener({ ...state });
  return () => listeners.delete(listener);
};

export const openKeyboard = ({ mode = 'page', screenId = null, buffer = '' } = {}) => {
  state.open = true;
  state.mode = mode;
  state.screenId = screenId;
  state.buffer = buffer;
  state.shift = false;
  announce();
};

export const closeKeyboard = () => {
  if (!state.open) return;
  state.open = false;
  state.buffer = '';
  announce();
};

export const toggleKeyboard = (options) => (state.open ? closeKeyboard() : openKeyboard(options));

export const setBuffer = (value) => {
  state.buffer = value;
  announce();
};

export const setShift = (value) => {
  state.shift = Boolean(value);
  announce();
};
