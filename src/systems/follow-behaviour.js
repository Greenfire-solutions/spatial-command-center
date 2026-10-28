/*
 * How a workspace travels with a person without making them ill.
 *
 * There are only two workspace modes in this application and they differ in
 * exactly one thing: whether the root the windows hang from is stationary.
 *
 *   WORLD  — the root never moves. You walk around your screens.
 *   FOLLOW — the root follows you. Your screens come with you.
 *
 * The naive implementation of FOLLOW is to parent the workspace to the camera,
 * or to rewrite the root's transform from the head pose every frame. Both feel
 * awful, and the reason is worth stating because it is not obvious: a head is
 * never still. Even someone concentrating on reading moves several degrees a
 * second, and a workspace that answers every one of those movements shakes. It
 * also removes the parallax that makes a panel feel like it is somewhere,
 * leaving it feeling stuck to the eyes, which is the specific complaint every
 * bad HUD in XR produces.
 *
 * So FOLLOW here is lazy, not immediate. Three rules do the work:
 *
 * 1. A DEADZONE. Below a threshold of angular difference, the workspace does
 *    not move at all. Not a little — not at all. This is what lets someone read
 *    without the text swimming, and it is the single most important of the
 *    three. It is the same mechanism HoloLens calls a tag-along and Horizon OS
 *    calls lazy follow.
 *
 * 2. EXPONENTIAL DAMPING, framerate-independent. Once the deadzone is broken
 *    the root eases toward the target rather than snapping. The smoothing is
 *    1 - exp(-dt/tau) rather than a fixed per-frame fraction, because a fixed
 *    fraction changes its meaning between 72 Hz and 90 Hz and would feel
 *    different on different hardware.
 *
 * 3. YAW ONLY. The root never pitches and never rolls. Looking down at your
 *    hands should not tip the workspace, and a rolled horizon in a headset is
 *    a reliable way to make somebody sick.
 *
 * Position follows on its own, larger deadzone: leaning forward to read is not
 * a request to move the room, but walking to the next desk is.
 *
 * Pure maths. No three.js, no React, no store — so every rule above is checked
 * by a test instead of by someone's stomach in a headset.
 */

/* Angular slack before the workspace reorients, in radians. Roughly 25 degrees
 * each way, which comfortably contains reading and glancing but not turning to
 * look at something. */
export const YAW_DEADZONE = 0.44;

/* How far the viewer may move before the workspace comes along, in metres.
 * Leaning is not walking. */
export const POSITION_DEADZONE = 0.55;

/* Time constants for the easing, in seconds. Orientation is slower than
 * position because a rotating world is what provokes discomfort. */
export const YAW_TAU = 0.55;
export const POSITION_TAU = 0.42;

/* Once following has begun it continues until the workspace is very nearly
 * aligned, rather than stopping the instant it re-enters the deadzone. Without
 * this the root stalls at the deadzone edge and every further head movement
 * nudges it again — the judder the deadzone was supposed to remove. */
export const YAW_SETTLE = 0.02;
export const POSITION_SETTLE = 0.02;

/** Shortest signed angle from a to b, so following never takes the long way. */
export const shortestAngle = (from, to) => {
  const delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) return delta - Math.PI * 2;
  if (delta < -Math.PI) return delta + Math.PI * 2;
  return delta;
};

/* Framerate-independent easing. At dt = tau this moves ~63% of the way, and
 * the result is identical at 72 and 90 Hz for the same elapsed time. */
const ease = (dt, tau) => 1 - Math.exp(-Math.max(0, dt) / Math.max(1e-4, tau));

export const createFollowState = ({ yaw = 0, position = [0, 0, 0] } = {}) => ({
  yaw,
  position: [...position],
  /* Whether a correction is currently in progress. Separate from the deadzone
   * test, so a movement that has started continues to completion. */
  chasingYaw: false,
  chasingPosition: false
});

/**
 * Advance a follow root by one frame.
 *
 * Pure: previous state and this frame's observation in, next state out.
 *
 * @param {object} previous   from createFollowState()
 * @param {object} input
 * @param {number} input.viewerYaw       the head's yaw, radians
 * @param {number[]} input.viewerPosition world position of the head
 * @param {number} input.delta           seconds since the last frame
 * @param {boolean} [input.frozen]       true while a window is being manipulated
 * @param {number} [input.followDistance] how far ahead the workspace sits
 * @returns {object} next state, with `moved` when anything changed
 */
export const stepFollow = (previous, {
  viewerYaw,
  viewerPosition,
  delta,
  frozen = false,
  followDistance = 0,
  yawDeadzone = YAW_DEADZONE,
  positionDeadzone = POSITION_DEADZONE
}) => {
  const next = {
    yaw: previous.yaw,
    position: [...previous.position],
    chasingYaw: previous.chasingYaw,
    chasingPosition: previous.chasingPosition
  };

  /*
   * A workspace that slides while a window is being dragged would move the
   * window's frame of reference mid-gesture, which is both disorienting and a
   * source of real transform error. Manipulation wins; following waits.
   */
  if (frozen || !Number.isFinite(viewerYaw) || !Array.isArray(viewerPosition)) {
    return Object.freeze({ ...next, moved: false, frozen: true });
  }

  /* --- orientation ---------------------------------------------------- */
  const yawError = shortestAngle(next.yaw, viewerYaw);
  if (!next.chasingYaw && Math.abs(yawError) > yawDeadzone) next.chasingYaw = true;
  if (next.chasingYaw) {
    next.yaw += yawError * ease(delta, YAW_TAU);
    if (Math.abs(shortestAngle(next.yaw, viewerYaw)) < YAW_SETTLE) {
      next.yaw = viewerYaw;
      next.chasingYaw = false;
    }
  }

  /*
   * The workspace sits `followDistance` ahead of the viewer along the yaw the
   * workspace itself is using — not along the viewer's instantaneous gaze.
   * Using the gaze would reintroduce the jitter the deadzone removes, by the
   * back door.
   */
  const anchor = [
    viewerPosition[0] - Math.sin(next.yaw) * followDistance,
    viewerPosition[1],
    viewerPosition[2] - Math.cos(next.yaw) * followDistance
  ];

  /* --- position -------------------------------------------------------- */
  const dx = anchor[0] - next.position[0];
  const dy = anchor[1] - next.position[1];
  const dz = anchor[2] - next.position[2];
  const distance = Math.hypot(dx, dy, dz);
  if (!next.chasingPosition && distance > positionDeadzone) next.chasingPosition = true;
  if (next.chasingPosition) {
    const alpha = ease(delta, POSITION_TAU);
    next.position[0] += dx * alpha;
    next.position[1] += dy * alpha;
    next.position[2] += dz * alpha;
    const remaining = Math.hypot(
      anchor[0] - next.position[0],
      anchor[1] - next.position[1],
      anchor[2] - next.position[2]
    );
    if (remaining < POSITION_SETTLE) {
      next.position = [...anchor];
      next.chasingPosition = false;
    }
  }

  const moved = next.yaw !== previous.yaw
    || next.position[0] !== previous.position[0]
    || next.position[1] !== previous.position[1]
    || next.position[2] !== previous.position[2];

  return Object.freeze({ ...next, moved, frozen: false });
};

/*
 * Where the workspace root should be the instant FOLLOW is switched on.
 *
 * Snapped, not eased. Easing in from wherever the root happened to be would
 * fly the entire workspace across the room in front of someone, which is the
 * one motion in XR guaranteed to be unpleasant. Switching modes is a discrete
 * act and should look like one.
 */
export const alignToViewer = ({ viewerYaw, viewerPosition, followDistance = 0 }) => createFollowState({
  yaw: viewerYaw,
  position: [
    viewerPosition[0] - Math.sin(viewerYaw) * followDistance,
    viewerPosition[1],
    viewerPosition[2] - Math.cos(viewerYaw) * followDistance
  ]
});
