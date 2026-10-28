import { XR_SESSION_MODES } from './xr-store.js';

/*
 * The XR interaction model, written down in one place.
 *
 * The mapping matters more than the code: it records which physical gesture
 * drives which existing action, so that adding a control later does not
 * invent a second, inconsistent vocabulary.
 *
 * Every entry below routes into an action that already exists and is already
 * ray-based (see interaction/screen-interaction.js). Nothing here is an
 * XR-only reimplementation of something the desktop already does.
 *
 *   trigger / pinch     select — a ray hit on a browser surface becomes a UV,
 *                       which becomes a Chromium input event. Identical path
 *                       to a desktop click; see chromium-texture-utils.js.
 *   grip                grab the screen  -> ScreenInteraction.beginGrab
 *   grip + move         move the screen  -> ScreenInteraction.updateGrab
 *   two-hand grip       resize           -> ScreenInteraction.beginPinchScale
 *   two-hand twist      rotate           -> ScreenInteraction.updateRotate
 *   thumbstick Y        scroll the page  -> provider.sendWheelEvent
 *   thumbstick X/Y      push/pull depth  -> updateGrab({ pushPull })
 *
 * The desktop equivalents are the same actions with a mouse ray:
 *
 *   left click          select
 *   drag in Arrange     grab and move
 *   R + drag            rotate
 *   corner handle drag  resize
 *   wheel               scroll, or depth in Arrange
 */

export const XR_INTERACTION_MAP = Object.freeze({
  select: Object.freeze({
    sources: ['controller:trigger', 'hand:pinch', 'mouse:primary'],
    action: 'browser-input',
    description: 'A ray hit becomes a UV, which becomes a Chromium input event.'
  }),
  grab: Object.freeze({
    sources: ['controller:squeeze', 'hand:grip', 'mouse:drag-in-arrange'],
    action: 'ScreenInteraction.beginGrab / updateGrab'
  }),
  resize: Object.freeze({
    sources: ['controller:two-hand-squeeze', 'hand:two-hand-pinch', 'mouse:corner-handle'],
    action: 'ScreenInteraction.beginPinchScale / updatePinchScale'
  }),
  rotate: Object.freeze({
    sources: ['controller:two-hand-twist', 'mouse:rotate-modifier-drag'],
    action: 'ScreenInteraction.beginRotate / updateRotate'
  }),
  scroll: Object.freeze({
    sources: ['controller:thumbstick-y', 'mouse:wheel'],
    action: 'provider.sendWheelEvent'
  }),
  depth: Object.freeze({
    sources: ['controller:thumbstick-y-in-arrange', 'mouse:shift-drag', 'mouse:wheel-in-arrange'],
    action: 'ScreenInteraction.updateGrab({ pushPull })'
  })
});

/*
 * Convert a thumbstick axis into the same normalized push/pull scalar the
 * mouse adapter produces, so the depth action cannot tell them apart.
 *
 * A deadzone keeps a resting stick from drifting a screen, and the response is
 * squared so small deflections are precise while large ones are quick.
 */
export const thumbstickToPushPull = (axisValue, { deadzone = 0.15, gain = 0.06 } = {}) => {
  const value = Number(axisValue) || 0;
  const magnitude = Math.abs(value);
  if (magnitude <= deadzone) return 0;
  const scaled = (magnitude - deadzone) / (1 - deadzone);
  return Math.sign(value) * scaled * scaled * gain;
};

/*
 * Convert a thumbstick axis into wheel deltas for page scrolling, matching the
 * sign convention the DOM wheel adapter already uses.
 */
export const thumbstickToWheelDelta = (axisValue, { deadzone = 0.15, gain = 40 } = {}) => {
  const value = Number(axisValue) || 0;
  if (Math.abs(value) <= deadzone) return 0;
  const scaled = (Math.abs(value) - deadzone) / (1 - deadzone);
  return Math.sign(value) * scaled * gain;
};

/* Session modes this workspace knows how to present in. */
export const SUPPORTED_SESSION_MODES = Object.freeze([
  XR_SESSION_MODES.IMMERSIVE_VR,
  XR_SESSION_MODES.IMMERSIVE_AR
]);
