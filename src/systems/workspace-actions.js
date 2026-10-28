import * as THREE from 'three';
import { ROTATION_ORDER, DEG, Y_AXIS, defaultUrlForType } from '../constants.js';
import { makeId } from '../utils/math.js';
import { sceneRuntime } from './scene-runtime.js';
import {
  viewpointForwardHorizontal,
  viewpointPosition,
  yawTowardViewpoint
} from './viewpoint.js';
import { useStore } from '../store/workspace-store.js';
import { openKeyboard } from '../xr/keyboard-state.js';

/*
 * Open a new window in front of the viewer, ready to be pointed somewhere.
 *
 * Two things here were desktop assumptions that do not survive a headset.
 *
 * The source was an `iframe`, which renders in an <Html> overlay — and an
 * <Html> overlay draws nothing inside an immersive session. A window added
 * while wearing the headset was therefore invisible from the moment it was
 * created, which reads as "the button does nothing".
 *
 * The URL was empty, on the reasoning that the wearer would type one. On a
 * desktop that is a focused address bar a keystroke away. In a headset an empty
 * window is indistinguishable from a broken one, so it opens on a real page and
 * the wearer replaces it — the address bar is offered, not required.
 *
 * `distance` is shorter in a session than the desktop's 3.2 m: the workspace is
 * authored for a camera set back from an arc, and standing inside it a screen
 * placed that far away reads as small and distant.
 */
const createScreenInFront = ({ distance = null, url = null, focusAddress = true } = {}) => {
  const viewer = viewpointPosition(new THREE.Vector3());
  const forward = viewpointForwardHorizontal(new THREE.Vector3());
  const presenting = Boolean(sceneRuntime.renderer?.xr?.isPresenting);
  const reach = distance ?? (presenting ? 1.9 : 3.2);
  const position = sceneRuntime.camera
    ? viewer.clone().addScaledVector(forward, reach)
    : new THREE.Vector3(0, 1.55, -2);
  const id = makeId('screen');
  const address = url || defaultUrlForType('browser');
  const screen = useStore.getState().addScreen({
    id,
    title: 'New Browser',
    type: 'browser',
    position: position.toArray(),
    rotation: [0, yawTowardViewpoint(position), 0, ROTATION_ORDER],
    scale: [1, 1, 1],
    size: [2.2, 1.35],
    locked: false,
    url: address,
    source: {
      id: 'source-' + id,
      sourceId: 'browser-' + id,
      type: 'chromium',
      title: 'New Browser',
      url: address,
      browserWidth: 1280,
      browserHeight: 800
    }
  });

  /* Adding a window and addressing it is one intention, so the keyboard opens
   * on the new screen rather than making the wearer find its address bar. On a
   * runtime with a system keyboard this is the headset's own; otherwise it is
   * the in-scene board. Both edit the same buffer. */
  if (focusAddress && presenting) {
    useStore.getState().setSelectedScreen(id);
    openKeyboard({ mode: 'address', screenId: id, buffer: address });
  }
  return screen;
};

const applyArcArrangement = () => {
  const state = useStore.getState();
  if (!sceneRuntime.camera || !state.screens.length) return;
  const movable = state.screens.filter((screen) => !screen.locked);
  if (!movable.length) {
    state.showToast('Unlock a screen before arranging the arc');
    return;
  }
  const settings = state.arcSettings;
  const viewer = viewpointPosition(new THREE.Vector3());
  const forward = viewpointForwardHorizontal(new THREE.Vector3());
  const maxArc = settings.arcAngle * DEG;
  const naturalStep = settings.spacing / settings.radius;
  const step = movable.length > 1 ? Math.min(naturalStep, maxArc / (movable.length - 1)) : 0;
  const centerIndex = (movable.length - 1) / 2;
  const targetById = new Map();
  movable.forEach((screen, index) => {
    const angle = (index - centerIndex) * step;
    const direction = forward.clone().applyAxisAngle(Y_AXIS, -angle);
    const position = viewer.clone().addScaledVector(direction, settings.radius);
    position.y = settings.height;
    targetById.set(screen.id, {
      position: position.toArray(),
      rotation: [0, yawTowardViewpoint(position), 0, ROTATION_ORDER]
    });
  });
  const screens = state.screens.map((screen) => {
    const target = targetById.get(screen.id);
    return target ? { ...screen, ...target } : screen;
  });
  state.animateScreens(screens, 'Screens snapped to arc');
};

export { applyArcArrangement, createScreenInFront };
