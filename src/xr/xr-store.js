import { createXRStore } from '@react-three/xr';

/*
 * The XR session store.
 *
 * Created once at module scope rather than inside a component, so that the
 * Enter VR / Enter MR buttons in the DOM overlay and the scene-side XR
 * provider share one session without prop drilling, and so a re-render can
 * never recreate a live session.
 *
 * Controllers and hands use the library's default implementations for now: the
 * workspace's own interaction lives in the scene, driven by pointer events
 * that @react-three/xr already synthesizes from controller rays and hand
 * pinches. That is the whole point of Phase 4 — the same ray-based actions
 * serve a mouse, a controller, and a hand without three separate code paths.
 */
/*
 * The device emulator is opt-in, not on by default.
 *
 * @react-three/xr emulates a Meta Quest 3 whenever WebXR is unavailable and
 * the page is on localhost. That is exactly the desktop Electron development
 * setup, so the default would inject navigator.xr into the desktop app: the
 * Enter VR control would appear on a machine with no headset, and several
 * megabytes of emulator room assets would be fetched. Both are surprising.
 *
 * Enable it deliberately with ?xr-emulate=1 when developing XR without a
 * headset.
 */
const emulatorRequested = () => {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('xr-emulate') === '1';
  } catch {
    return false;
  }
};

export const xrStore = createXRStore({
  // Hand tracking is opt-in on most runtimes; requesting it is harmless where
  // it is unavailable and necessary where it is not.
  hand: true,
  controller: true,
  emulate: emulatorRequested() ? 'metaQuest3' : false,
  // Session offers are surfaced through the workspace's own entry controls
  // rather than the browser's, so the two cannot disagree about availability.
  offerSession: false
});

export const XR_SESSION_MODES = Object.freeze({
  IMMERSIVE_VR: 'immersive-vr',
  IMMERSIVE_AR: 'immersive-ar'
});

/*
 * Whether this browser can host a given session mode.
 *
 * Electron's Chromium does not expose navigator.xr, so on the desktop build
 * this simply reports false and the entry controls stay hidden rather than
 * offering something that cannot work.
 */
export const isSessionModeSupported = async (mode) => {
  if (typeof navigator === 'undefined' || !navigator.xr) return false;
  try {
    return Boolean(await navigator.xr.isSessionSupported(mode));
  } catch {
    return false;
  }
};

export const xrAvailable = () => typeof navigator !== 'undefined' && Boolean(navigator.xr);
