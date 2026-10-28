import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POSITION_DEADZONE,
  YAW_DEADZONE,
  alignToViewer,
  createFollowState,
  shortestAngle,
  stepFollow
} from './follow-behaviour.js';

const FRAME = 1 / 90;

/* Run n frames with the viewer held still at a given yaw/position. */
const settle = (state, { viewerYaw = 0, viewerPosition = [0, 1.6, 0], frames = 400, frozen = false } = {}) => {
  let current = state;
  for (let index = 0; index < frames; index += 1) {
    current = stepFollow(current, { viewerYaw, viewerPosition, delta: FRAME, frozen });
  }
  return current;
};

test('small head movement moves the workspace not at all', () => {
  /* The rule that makes reading possible. Not "a little" — nothing. */
  const state = createFollowState({ yaw: 0, position: [0, 1.6, 0] });
  let current = state;
  for (const yaw of [0.05, -0.08, 0.12, -0.15, 0.2, -0.1]) {
    current = stepFollow(current, { viewerYaw: yaw, viewerPosition: [0, 1.6, 0], delta: FRAME });
    assert.equal(current.yaw, 0, `yaw drifted at viewer yaw ${yaw}`);
    assert.equal(current.moved, false);
  }
});

test('turning past the deadzone brings the workspace round', () => {
  const state = createFollowState();
  const turned = settle(state, { viewerYaw: 1.4 });
  assert.ok(Math.abs(turned.yaw - 1.4) < 0.01, `ended at ${turned.yaw}`);
});

test('following eases rather than snapping', () => {
  const state = createFollowState();
  const one = stepFollow(state, { viewerYaw: 1.4, viewerPosition: [0, 1.6, 0], delta: FRAME });
  assert.ok(one.yaw > 0, 'it started moving');
  assert.ok(one.yaw < 1.4 * 0.25, `one frame covered ${one.yaw.toFixed(3)} of 1.4 — too abrupt`);
});

test('easing is framerate independent', () => {
  /* The same elapsed time must produce the same result at 72 and 90 Hz, or the
     workspace follows at a different speed on different hardware. */
  const at90 = settle(createFollowState(), { viewerYaw: 1.2, frames: 90 });
  let at72 = createFollowState();
  for (let index = 0; index < 72; index += 1) {
    at72 = stepFollow(at72, { viewerYaw: 1.2, viewerPosition: [0, 1.6, 0], delta: 1 / 72 });
  }
  assert.ok(Math.abs(at90.yaw - at72.yaw) < 0.02, `${at90.yaw} vs ${at72.yaw}`);
});

test('once it starts it finishes, instead of stalling at the deadzone edge', () => {
  /* Without hysteresis the root stops the moment it re-enters the deadzone,
     and every further head movement nudges it again — which is exactly the
     judder the deadzone exists to remove. */
  const settled = settle(createFollowState(), { viewerYaw: 1.0 });
  assert.ok(Math.abs(settled.yaw - 1.0) < 0.01, 'converged fully');
  assert.equal(settled.chasingYaw, false, 'and stopped chasing');
});

test('the workspace never pitches or rolls', () => {
  /* There is no pitch or roll in the state at all, which is the strongest form
     of this guarantee: it cannot be introduced by a tuning mistake. */
  const state = settle(createFollowState(), { viewerYaw: 2.0, viewerPosition: [0, 2.4, 0] });
  assert.deepEqual(Object.keys(state).sort(), ['chasingPosition', 'chasingYaw', 'frozen', 'moved', 'position', 'yaw']);
});

test('leaning is not walking', () => {
  const state = createFollowState({ position: [0, 1.6, 0] });
  const leaned = stepFollow(state, { viewerYaw: 0, viewerPosition: [0.3, 1.6, -0.2], delta: FRAME });
  assert.deepEqual(leaned.position, [0, 1.6, 0]);
  assert.equal(leaned.moved, false);
});

test('walking brings the workspace along', () => {
  const state = createFollowState({ position: [0, 1.6, 0] });
  const walked = settle(state, { viewerPosition: [2.5, 1.6, -1.5] });
  assert.ok(Math.abs(walked.position[0] - 2.5) < 0.05, `x ended at ${walked.position[0]}`);
  assert.ok(Math.abs(walked.position[2] - -1.5) < 0.05);
});

test('a manipulation freezes the workspace where it is', () => {
  /* A workspace that slides while a window is being dragged moves the frame of
     reference mid-gesture: disorienting, and a genuine source of transform
     error. */
  const state = createFollowState();
  const frozen = stepFollow(state, { viewerYaw: 3.0, viewerPosition: [9, 1.6, 9], delta: FRAME, frozen: true });
  assert.equal(frozen.yaw, 0);
  assert.deepEqual(frozen.position, [0, 0, 0]);
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.moved, false);
});

test('following takes the short way round the back', () => {
  /* Crossing pi must not unwind the long way round, which would spin the whole
     workspace past the user to arrive somewhere it was already next to. */
  assert.ok(Math.abs(shortestAngle(3.0, -3.0) - 0.2832) < 0.01, 'a small step across pi is small');

  /* A turn large enough to leave the deadzone, still crossing pi. */
  const state = createFollowState({ yaw: 3.0 });
  const one = stepFollow(state, { viewerYaw: -2.0, viewerPosition: [0, 1.6, 0], delta: FRAME });
  assert.ok(one.yaw > 3.0, `went the short way over pi, not back through zero: ${one.yaw}`);

  const settled = settle(state, { viewerYaw: -2.0 });
  assert.ok(Math.abs(shortestAngle(settled.yaw, -2.0)) < 0.01, 'and arrived');
});

test('switching into follow snaps, because a flying workspace is unpleasant', () => {
  const aligned = alignToViewer({ viewerYaw: 1.1, viewerPosition: [3, 1.6, -2], followDistance: 0 });
  assert.equal(aligned.yaw, 1.1);
  assert.deepEqual(aligned.position, [3, 1.6, -2]);
});

test('a garbled pose leaves the workspace alone rather than throwing it somewhere', () => {
  const state = createFollowState({ yaw: 0.5, position: [1, 1.6, 1] });
  const bad = stepFollow(state, { viewerYaw: NaN, viewerPosition: [0, 0, 0], delta: FRAME });
  assert.equal(bad.yaw, 0.5);
  assert.deepEqual(bad.position, [1, 1.6, 1]);
});

test('the deadzones are the documented sizes', () => {
  assert.ok(YAW_DEADZONE > 0.3 && YAW_DEADZONE < 0.6, 'roughly 25 degrees');
  assert.ok(POSITION_DEADZONE > 0.3 && POSITION_DEADZONE < 0.8, 'roughly half a metre');
});

/* ---------------------------------------------------------------------------
 * Mode switching. The workspace is what the user built; the mode is only how it
 * is carried. Switching must not disturb the first thing.
 * ------------------------------------------------------------------------ */

test('switching modes changes the root and nothing else', async () => {
  const { useStore } = await import('../store/workspace-store.js');

  const before = useStore.getState().screens.map((screen) => ({
    id: screen.id,
    url: screen.url,
    sourceId: screen.source.sourceId,
    position: [...screen.position],
    rotation: [...screen.rotation],
    scale: [...screen.scale],
    size: [...screen.size]
  }));
  assert.ok(before.length > 0, 'there is a workspace to preserve');

  useStore.getState().setWorkspaceMode('follow');
  assert.equal(useStore.getState().workspaceMode, 'follow');

  useStore.getState().setWorkspaceMode('world');
  assert.equal(useStore.getState().workspaceMode, 'world');

  const after = useStore.getState().screens.map((screen) => ({
    id: screen.id,
    url: screen.url,
    sourceId: screen.source.sourceId,
    position: [...screen.position],
    rotation: [...screen.rotation],
    scale: [...screen.scale],
    size: [...screen.size]
  }));

  /* No window moved, no URL changed, no source was recreated — so nothing
     reloads and no page state is lost when the mode changes. */
  assert.deepEqual(after, before);
});

test('choosing a mode records that the question was answered', () => {
  return import('../store/workspace-store.js').then(({ useStore }) => {
    useStore.getState().setWorkspaceModeChosen(false);
    assert.equal(useStore.getState().workspaceModeChosen, false);
    useStore.getState().setWorkspaceMode('follow');
    assert.equal(useStore.getState().workspaceModeChosen, true, 'the chooser does not ask twice');
  });
});

test('an unknown mode is treated as world rather than accepted', () => {
  return import('../store/workspace-store.js').then(({ useStore }) => {
    useStore.getState().setWorkspaceMode('orbit');
    assert.equal(useStore.getState().workspaceMode, 'world', 'there are only two modes');
    useStore.getState().setWorkspaceMode('world');
  });
});
