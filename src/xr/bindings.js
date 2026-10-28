/*
 * Controller bindings, as data.
 *
 * Which button means "enter" is muscle memory, and muscle memory is personal:
 * the defaults here are one opinion, not a fact. So bindings are a table that
 * the interface edits and the runtime reads, rather than constants compiled
 * into the components that use them.
 *
 * This is the same shape as the command registry. An action is named, the input
 * that reaches it is configuration, and nothing that performs an action knows
 * which button caused it.
 */

const STORAGE_KEY = 'scc.bindings.v1';

/*
 * What each input already does, per hand.
 *
 * Symmetry is not a given, and assuming it wastes inputs. Only the grips are
 * genuinely both-handed: pressed together they resize a screen from the
 * distance between the controllers, so neither can be reassigned without losing
 * that gesture. Everything else differs by hand:
 *
 *   - the thumbsticks already do different jobs (left flies, right turns and
 *     changes altitude), so they were never duplicated;
 *   - both triggers select, which is real duplication. You point with one hand.
 *     Freeing the other costs only the ability to click with it;
 *   - neither thumbstick click is used by anything, and neither is a thumbrest.
 *
 * `cost` is what you give up by rebinding it, so the menu can say so plainly
 * instead of hiding the option.
 */
export const RESERVED = {
  left: {
    'xr-standard-trigger': { cost: 'clicking pages with the left hand', severity: 'soft' },
    'xr-standard-squeeze': { cost: 'grabbing screens, and two-handed resize', severity: 'hard' },
    'xr-standard-thumbstick-axes': { cost: 'flying', severity: 'hard' }
  },
  right: {
    'xr-standard-trigger': { cost: 'clicking pages with the right hand', severity: 'hard' },
    'xr-standard-squeeze': { cost: 'grabbing screens, and two-handed resize', severity: 'hard' },
    'xr-standard-thumbstick-axes': { cost: 'turning and altitude', severity: 'hard' }
  }
};

/** What a given hand's input already costs, or null when it is free. */
export const reservedFor = (hand, input) => (RESERVED[hand] && RESERVED[hand][input]) || null;

export const INPUTS = [
  { id: null, label: '(none)', hands: ['left', 'right'] },
  { id: 'a-button', label: 'A', hands: ['right'] },
  { id: 'b-button', label: 'B', hands: ['right'] },
  { id: 'x-button', label: 'X', hands: ['left'] },
  { id: 'y-button', label: 'Y', hands: ['left'] },
  { id: 'xr-standard-thumbstick', label: 'Thumbstick click', hands: ['left', 'right'] },
  { id: 'thumbrest', label: 'Thumbrest', hands: ['left', 'right'] },
  { id: 'xr-standard-squeeze', label: 'Grip', hands: ['left', 'right'] },
  { id: 'xr-standard-trigger', label: 'Trigger', hands: ['left', 'right'] }
];

/*
 * The actions a controller can reach.
 *
 * `context` is what makes four buttons enough for a shell: text actions apply
 * only while a screen has keyboard focus, so the same buttons are free for
 * something else when you are flying around. The active context is shown in the
 * interface rather than remembered.
 */
export const ACTIONS = [
  {
    id: 'voice.pushToTalk',
    label: 'Push to talk',
    describe: 'Hold to dictate a command',
    context: 'always',
    default: { hand: 'right', input: 'b-button' }
  },
  {
    id: 'text.enter',
    label: 'Enter / send',
    describe: 'Send the line to the focused screen',
    context: 'text',
    default: { hand: 'right', input: 'a-button' }
  },
  {
    id: 'text.backspace',
    label: 'Delete character',
    describe: 'Backspace. Hold to repeat',
    context: 'text',
    default: { hand: 'left', input: 'x-button' }
  },
  {
    id: 'text.deleteLine',
    label: 'Delete line',
    describe: 'Clear the line, Ctrl+U in a shell',
    context: 'text',
    default: { hand: 'left', input: 'y-button' }
  },
  {
    id: 'text.tab',
    label: 'Tab',
    describe: 'Completion in a shell',
    context: 'text',
    default: { hand: 'right', input: 'xr-standard-thumbstick' }
  },
  {
    id: 'text.escape',
    label: 'Escape',
    describe: 'Cancel, or leave insert mode',
    context: 'text',
    default: { hand: 'right', input: null }
  },
  {
    id: 'keyboard.toggle',
    label: 'Show keyboard',
    describe: 'Bring up the spatial keyboard',
    context: 'always',
    default: { hand: 'left', input: 'xr-standard-thumbstick' }
  },
  {
    id: 'window.add',
    label: 'New window',
    describe: 'Open a browser window in front of you and type its address',
    context: 'always',
    /* Right thumbstick click is the only component free in the 'always'
     * context: locomotion reads the stick's axes, never its button. */
    default: { hand: 'right', input: 'xr-standard-thumbstick' }
  }
];

const defaults = () => Object.fromEntries(
  ACTIONS.map((action) => [action.id, { ...action.default }])
);

let current = defaults();
const listeners = new Set();

const load = () => {
  if (typeof window === 'undefined') return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!stored) return;
    /* Merge rather than replace, so a binding added in a later version gets its
     * default instead of being missing. */
    current = { ...defaults(), ...stored };
  } catch {
    current = defaults();
  }
};

const persist = () => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* Private browsing and full disks are not worth breaking input over. */
  }
};

const announce = () => {
  for (const listener of [...listeners]) {
    try {
      listener(current);
    } catch {
      /* An observer must not break input. */
    }
  }
};

load();

export const getBindings = () => current;
export const getBinding = (actionId) => current[actionId] || null;

export const setBinding = (actionId, binding) => {
  if (!ACTIONS.some((action) => action.id === actionId)) return;
  /* A null input means deliberately unbound, which is different from missing. */
  current = { ...current, [actionId]: { hand: binding.hand, input: binding.input || null } };
  persist();
  announce();
};

export const resetBindings = () => {
  current = defaults();
  persist();
  announce();
};

export const onBindingsChange = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Actions bound to the same hand and input, so the menu can warn rather than
 * silently letting one shadow the other. */
export const conflictsFor = (actionId) => {
  const binding = current[actionId];
  if (!binding || !binding.input) return [];
  return ACTIONS.filter((action) => action.id !== actionId)
    .filter((action) => {
      const other = current[action.id];
      return other && other.hand === binding.hand && other.input === binding.input;
    });
};

/** Is this component currently pressed? Thumbstick click and face buttons
 * report differently, so the test lives in one place. */
export const isPressed = (component) => Boolean(
  component && (component.state === 'pressed' || (component.button ?? 0) > 0.6)
);
