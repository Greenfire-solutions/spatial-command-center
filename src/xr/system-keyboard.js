/*
 * The headset's own keyboard.
 *
 * `SpatialKeyboard` draws keys in the scene because DOM renders nothing inside
 * an immersive session. That is true of *rendering*, and it is the reason the
 * in-scene keyboard exists — but it is not the whole story for *input*. Meta's
 * browser will raise the system keyboard over a running session when a real DOM
 * text field takes focus, and hand the typed value back through ordinary input
 * events. The DOM element is never seen; it is a text sink, not a control.
 *
 * That is worth reaching for, because a system keyboard beats anything we can
 * draw: it is the layout the wearer already knows, it has swipe, punctuation,
 * autocomplete and dictation, and it does not consume scene real estate or
 * controller aim. The in-scene keyboard remains the fallback for runtimes that
 * do not offer one, so text entry never depends on a capability we cannot
 * detect.
 *
 * Three documented behaviours shape this module, and each one would be a bug if
 * it were met unprepared:
 *
 *   1. Opening the keyboard begins a new editing session that overwrites the
 *      entire field value. There is no way to place a caret into existing text,
 *      so the honest model is "type a value", not "edit a value" — the caller
 *      is told the value wholesale and never a delta.
 *   2. There are no interceptable key events. The value must be read from the
 *      element; watching for keystrokes would observe nothing.
 *   3. While the keyboard is up the session's visibility state becomes
 *      'visible-blurred'. That is not the session ending, and anything that
 *      tears down on visibility change must not fire here.
 *
 * The browser also scrolls the page to reveal a focused field, which would
 * shift the viewport underneath a session, so the sink is positioned inside the
 * viewport and the scroll offset is restored on release.
 */

const SINK_ID = 'scc-system-keyboard-sink';

let sink = null;
let activeSession = null;

/*
 * Whether this runtime will raise a keyboard for a focused field.
 *
 * Feature-detected on the session rather than sniffed from the user agent: the
 * flag is exactly the question we mean to ask, and a runtime that gains the
 * capability later starts working without a version check to update.
 */
export const isSystemKeyboardSupported = (session) =>
  Boolean(session && session.isSystemKeyboardSupported);

/*
 * The text sink.
 *
 * A real, focusable input in the live DOM — an off-screen or `display:none`
 * element cannot take focus, and a focused element outside the viewport makes
 * the page scroll to find it. So it sits at the origin, one pixel, fully
 * transparent, and inert to pointers. Nothing renders it in a session anyway;
 * the constraint being satisfied here is focusability, not invisibility.
 */
const ensureSink = () => {
  if (sink && sink.isConnected) return sink;
  sink = document.getElementById(SINK_ID);
  if (!sink) {
    sink = document.createElement('input');
    sink.id = SINK_ID;
    sink.type = 'text';
    sink.autocomplete = 'off';
    sink.autocapitalize = 'off';
    sink.spellcheck = false;
    sink.setAttribute('aria-hidden', 'true');
    /* Marks this element as ours for ChromiumKeyboardRouter, which blurs the
     * focused browser source whenever focus moves anywhere else in the
     * document. Raising the system keyboard necessarily moves focus here, so
     * without this the act of opening a keyboard revokes the very focus the
     * host requires before it will accept a keystroke. */
    sink.setAttribute('data-scc-keyboard-sink', 'true');
    sink.setAttribute('tabindex', '-1');
    sink.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:1px',
      'height:1px',
      'opacity:0',
      'padding:0',
      'border:0',
      'outline:none',
      'background:transparent',
      'color:transparent',
      'pointer-events:none',
      'z-index:-1'
    ].join(';');
    document.body.appendChild(sink);
  }
  return sink;
};

/*
 * Raise the system keyboard and report what is typed.
 *
 * Returns a handle whose close() releases focus, which is also what dismisses
 * the keyboard. Callers get `onChange` for every edit and `onCommit` when the
 * wearer accepts with Enter; `onClose` fires exactly once however the session
 * ends, so a caller can restore its own state without tracking which path was
 * taken.
 */
export const openSystemKeyboard = ({
  session = null,
  initial = '',
  onChange = () => {},
  onCommit = () => {},
  onClose = () => {}
} = {}) => {
  if (typeof document === 'undefined') return null;

  const field = ensureSink();
  activeSession = session;

  /* Restored on release: focusing a field lets the browser scroll the document,
   * and a shifted page under a running session is a viewport change nobody
   * asked for. */
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  let closed = false;
  let committed = false;

  const detach = () => {
    field.removeEventListener('input', handleInput);
    field.removeEventListener('keydown', handleKeyDown);
    field.removeEventListener('blur', handleBlur);
  };

  const close = ({ commit = false } = {}) => {
    if (closed) return;
    closed = true;
    detach();
    const value = field.value;
    try {
      field.blur();
    } catch {
      /* Releasing focus must never throw into the caller. */
    }
    field.value = '';
    window.scrollTo(scrollX, scrollY);
    activeSession = null;
    if (commit && !committed) {
      committed = true;
      onCommit(value);
    }
    onClose(value);
  };

  /* The value is authoritative and is reported whole. Per the platform there is
   * no keystroke to observe and no caret to track, so a diff would be invented
   * rather than measured. */
  function handleInput() {
    onChange(field.value);
  }

  /* Enter is the one key that does arrive, because the keyboard's accept action
   * dispatches it. Everything else is read from `value`. */
  function handleKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      close({ commit: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  /* Blur is the dismiss path: the keyboard's own close button, the Meta button,
   * or looking away all land here. */
  function handleBlur() {
    close();
  }

  field.value = initial || '';
  field.addEventListener('input', handleInput);
  field.addEventListener('keydown', handleKeyDown);
  field.addEventListener('blur', handleBlur);

  /* focus() is the entire trigger; there is no show() to call. */
  try {
    field.focus({ preventScroll: true });
    /* Selecting the existing text makes the documented overwrite behave the way
     * a wearer expects: the old address is replaced by what they type, visibly,
     * rather than vanishing at the first keypress for no stated reason. */
    field.select();
  } catch {
    close();
    return null;
  }

  return {
    close,
    get value() {
      return field.value;
    }
  };
};

/*
 * Whether a visibility change is the keyboard rather than the session leaving.
 *
 * 'visible-blurred' is what the runtime reports while the system keyboard is
 * over the session. Anything that tears down on visibility must consult this,
 * or raising the keyboard would close the thing it is typing into.
 */
export const isKeyboardVisibilityState = (state) => state === 'visible-blurred';

/*
 * Is this the text sink the system keyboard types into?
 *
 * Focus moving into it is not the wearer leaving the browser surface — it is
 * the mechanism by which they type into it. Anything that treats a focus change
 * as "the browser lost focus" has to make this exception, or typing switches
 * itself off at the moment it begins.
 */
export const isSystemKeyboardSink = (element) => Boolean(
  element
  && typeof element.getAttribute === 'function'
  && element.getAttribute('data-scc-keyboard-sink') === 'true'
);

export const hasActiveSystemKeyboard = () => Boolean(activeSession);
