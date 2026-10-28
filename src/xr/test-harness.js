/*
 * The XR test harness.
 *
 * The loop this closes: until now, every XR change had to be built, served to a
 * headset, worn, and judged by eye. That is minutes per iteration and the result
 * is an impression rather than a measurement — and `docs/WEBXR_HEADSET_FINDINGS.md`
 * records what that costs, where every indicator read healthy while the display
 * was black in all directions.
 *
 * This installs a driveable XR device in an ordinary browser so a session can be
 * entered, a controller posed, a trigger pulled, and the result asserted, all
 * from a script. It is the instrument the Phase 0 measurements need.
 *
 * It is built on IWER, which is already a dependency: @react-three/xr pulls it in
 * for its own emulator. Nothing new is installed to make this work.
 *
 * Opt in with ?xr-harness=1. Do not combine it with ?xr-emulate=1 — that flag asks
 * @react-three/xr to install its own IWER runtime, and two runtimes cannot both own
 * navigator.xr. The harness warns and stands down rather than fighting for it.
 *
 * On a real headset this stands down. It has to be explicit about that: the desktop
 * case needs forceInstall, because Chrome ships a navigator.xr that IWER politely
 * refuses to replace and which then fails with "No XR hardware found". Forcing it
 * blindly would replace a Quest's real runtime with a fake device — a harnessed
 * build opened on hardware would silently test the emulator instead of the headset,
 * which is the worst possible failure for an instrument whose whole job is to tell
 * you the truth. So the runtime is only forced where nothing real answers.
 */

const FLAG = 'xr-harness';

/* IWER names the Touch Plus components by their function rather than by index,
 * which is the whole point of using it: a test says "squeeze" and never "button 1".
 * The thumbstick sits at axes 2 and 3 because the absent touchpad holds 0 and 1 —
 * a fact worth stating here because reading axes[0] is the most common Quest bug
 * in the ecosystem and a test that reproduced it would be silently wrong. */
const BUTTONS = Object.freeze({
  trigger: 'trigger',
  squeeze: 'squeeze',
  thumbstick: 'thumbstick',
  a: 'a-button',
  b: 'b-button',
  x: 'x-button',
  y: 'y-button',
  thumbrest: 'thumbrest'
});

const harnessRequested = () => {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get(FLAG) === '1';
  } catch {
    return false;
  }
};

const emulatorAlsoRequested = () => {
  try {
    return new URLSearchParams(window.location.search).get('xr-emulate') === '1';
  } catch {
    return false;
  }
};

const finite = (value) => Number.isFinite(value);

/* A pose is reported with its validity rather than as bare numbers, because the
 * states the architecture distinguishes — valid, dead-reckoning, gone — are the
 * whole subject of the tests this harness exists to run. */
const describePose = (input) => {
  if (!input) return { status: 'ABSENT' };
  if (!input.connected) return { status: 'DISCONNECTED' };
  const p = input.position;
  const q = input.quaternion;
  const ok = p && q && finite(p.x) && finite(p.y) && finite(p.z) &&
    finite(q.x) && finite(q.y) && finite(q.z) && finite(q.w);
  return {
    status: ok ? 'VALID' : 'INVALID',
    position: p ? [p.x, p.y, p.z] : null,
    quaternion: q ? [q.x, q.y, q.z, q.w] : null
  };
};

export const installXrTestHarness = () => {
  if (!harnessRequested()) return null;
  if (typeof window === 'undefined') return null;
  if (window.__SCC_XR__) return window.__SCC_XR__;

  if (emulatorAlsoRequested()) {
    console.warn(
      '[xr-harness] ?xr-emulate=1 is also set. Both install an IWER runtime and only ' +
      'one can own navigator.xr. The harness is standing down; drop one flag.'
    );
    return null;
  }

  /* Resolved once the device is installed. Callers await this rather than racing
   * the dynamic import, so a driver script never has to sleep and hope. */
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  const state = { device: null, error: null };

  const controller = (handedness) => state.device?.controllers?.[handedness] ?? null;

  /* The store and the scene registry are read lazily. This module is imported
   * before app.jsx so that navigator.xr exists before anything looks for it, which
   * means neither is loaded yet at install time. Importing them on demand gets the
   * same module instances the application uses — an ESM singleton, not a copy. */
  const workspace = async () => (await import('../store/workspace-store.js')).useStore.getState();
  const runtime = async () => (await import('../systems/scene-runtime.js')).sceneRuntime;

  const harness = {
    ready,
    BUTTONS,

    available: () => Boolean(state.device),
    error: () => state.error,

    /* Everything a failing assertion needs in order to explain itself. The
     * interaction fields are the ones that matter for the grab-leak defect: a
     * window can look correct on screen while the store still believes it is held. */
    snapshot: async () => {
      const device = state.device;
      const store = await workspace().catch(() => null);
      const scene = await runtime().catch(() => null);

      const screens = (store?.screens || []).map((screen) => {
        const object = scene?.screenObjects?.get(screen.id) || null;
        return {
          id: screen.id,
          name: screen.name || screen.title || null,
          locked: Boolean(screen.locked),
          storeTransform: {
            position: screen.position,
            rotation: screen.rotation,
            scale: screen.scale
          },
          liveTransform: object
            ? {
                position: object.position.toArray(),
                quaternion: object.quaternion.toArray(),
                scale: object.scale.toArray()
              }
            : null,
          finite: Array.isArray(screen.position) && screen.position.every(finite)
        };
      });

      return {
        harness: { installed: Boolean(device), error: state.error },
        xr: {
          hasNavigatorXr: typeof navigator !== 'undefined' && Boolean(navigator.xr),
          sessionActive: Boolean(device?.activeSession),
          visibilityState: device?.visibilityState ?? null,
          primaryInputMode: device?.primaryInputMode ?? null,
          inputSourceCount: device?.inputSources?.length ?? 0
        },
        headset: device ? describePose({ connected: true, position: device.position, quaternion: device.quaternion }) : { status: 'ABSENT' },
        controllers: {
          left: describePose(controller('left')),
          right: describePose(controller('right'))
        },
        interaction: {
          mode: store?.interactionMode ?? null,
          selectedScreen: store?.selectedScreen ?? null,
          isManipulatingScreen: Boolean(store?.isManipulatingScreen),
          manipulationKind: store?.manipulationKind ?? null
        },
        screens
      };
    },

    /* Session control goes through the application's own store rather than through
     * IWER, so a test enters a session by the same path a user does and any bug in
     * that path is in scope rather than bypassed. */
    enter: async (mode = 'immersive-vr') => {
      const { xrStore } = await import('./xr-store.js');
      if (mode === 'immersive-ar') await xrStore.enterAR();
      else await xrStore.enterVR();
      return harness.snapshot();
    },

    exit: async () => {
      const device = state.device;
      if (device?.activeSession) await device.activeSession.end().catch(() => {});
      return harness.snapshot();
    },

    setHeadset: ({ position, quaternion } = {}) => {
      const device = state.device;
      if (!device) return false;
      if (position) device.position.set(position[0], position[1], position[2]);
      if (quaternion) device.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
      return true;
    },

    /* Point a controller at a world position.
     *
     * Without this a test can only pose a controller at coordinates it guessed, and
     * a squeeze that hits nothing silently proves nothing — which is exactly how the
     * first run of the grab-leak test passed while never exercising the defect.
     *
     * The rotation is the shortest arc from the controller's forward axis (-Z, as
     * the WebXR target ray is defined) to the direction of the target. */
    aimAt: (handedness, target) => {
      const input = controller(handedness);
      if (!input || !Array.isArray(target)) return false;
      const o = input.position;
      let dx = target[0] - o.x, dy = target[1] - o.y, dz = target[2] - o.z;
      const length = Math.hypot(dx, dy, dz);
      if (!length || !finite(length)) return false;
      dx /= length; dy /= length; dz /= length;

      /* forward = (0, 0, -1); axis = forward x direction = (dy, -dx, 0);
       * w = 1 + forward . direction = 1 - dz. Getting this cross product backwards
       * yields the conjugate, which aims at the mirror image of the target and is
       * almost right for anything straight ahead — the worst kind of wrong. */
      let ax = dy, ay = -dx, az = 0;
      let w = 1 - dz;
      if (w < 1e-6) {
        /* Exactly behind: any perpendicular axis gives the half turn. */
        ax = 0; ay = 1; az = 0; w = 0;
      }
      const n = Math.hypot(ax, ay, az, w) || 1;
      input.quaternion.set(ax / n, ay / n, az / n, w / n);
      return true;
    },

    /* Wait for one XR animation frame. */
    nextFrame: () => new Promise((resolve) => {
      const session = state.device?.activeSession;
      if (!session) return resolve(false);
      session.requestAnimationFrame(() => resolve(true));
    }),

    /* Point a controller at a WORLD position, by measurement rather than by model.
     *
     * There is a chain of transforms between the pose we write and the ray the
     * application casts: the rig that XrNavigation moved on session entry, and the
     * grip offset the Touch Plus profile applies. Modelling that chain means
     * duplicating assumptions that can drift out of sync with the app.
     *
     * So this measures it instead. Given the controller quaternion C we set, the
     * ray we asked for is u = C·(0,0,-1) and the ray we observe is `actual`; the
     * rotation between them is everything in between. Invert it, apply it to the
     * direction we actually want, and solve for a new C. That is exact up to a twist
     * about the ray itself, which does not affect aim, and one more pass removes the
     * residual. Each pass costs a frame because the scene must render to be read. */
    aimAtWorld: async (handedness, worldTarget, { passes = 4, toleranceRad = 0.01 } = {}) => {
      const THREE = await import('three');
      const { xrStore } = await import('./xr-store.js');
      const input = controller(handedness);
      if (!input || !Array.isArray(worldTarget)) return false;

      const FORWARD = new THREE.Vector3(0, 0, -1);
      const target = new THREE.Vector3(worldTarget[0], worldTarget[1], worldTarget[2]);

      for (let pass = 0; pass < passes; pass += 1) {
        const entry = (xrStore.getState().inputSourceStates || [])
          .find((candidate) => candidate?.inputSource?.handedness === handedness);
        const object = entry?.object;
        if (!object) return false;

        object.updateMatrixWorld();
        const from = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
        const worldQuaternion = new THREE.Quaternion().setFromRotationMatrix(object.matrixWorld);
        const actual = FORWARD.clone().applyQuaternion(worldQuaternion).normalize();

        const desired = target.clone().sub(from);
        if (desired.lengthSq() < 1e-8) return false;
        desired.normalize();

        if (actual.angleTo(desired) < toleranceRad) return true;

        /* u is the direction we asked the device for; `between` is everything the
         * runtime applied on top of it. */
        const current = new THREE.Quaternion(
          input.quaternion.x, input.quaternion.y, input.quaternion.z, input.quaternion.w
        );
        const u = FORWARD.clone().applyQuaternion(current).normalize();
        const between = new THREE.Quaternion().setFromUnitVectors(u, actual);
        const wanted = desired.clone().applyQuaternion(between.clone().invert()).normalize();
        const next = new THREE.Quaternion().setFromUnitVectors(FORWARD, wanted);

        input.quaternion.set(next.x, next.y, next.z, next.w);
        await harness.nextFrame();
      }

      /* Report whether the last pass actually landed, rather than assuming it did. */
      const entry = (xrStore.getState().inputSourceStates || [])
        .find((candidate) => candidate?.inputSource?.handedness === handedness);
      const object = entry?.object;
      if (!object) return false;
      object.updateMatrixWorld();
      const from = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
      const actual = FORWARD.clone()
        .applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(object.matrixWorld))
        .normalize();
      /* A panel is roughly a metre wide at a couple of metres, so "aimed" means
       * within a few degrees, not within a rounding error. The strict per-pass
       * tolerance above drives refinement; this one reports usefulness. */
      return actual.angleTo(target.clone().sub(from).normalize()) < 0.15;
    },

    setController: (handedness, { position, quaternion } = {}) => {
      const input = controller(handedness);
      if (!input) return false;
      if (position) input.position.set(position[0], position[1], position[2]);
      if (quaternion) input.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
      return true;
    },

    /* Button values are set immediately rather than animated, because a test that
     * has to wait for a press to ramp is a test that intermittently fails. The
     * gradual path exists in IWER as updateButtonValue if a future test wants to
     * measure the Heisenberg drift described in the prior-art notes. */
    press: (handedness, button, value = 1) => {
      const input = controller(handedness);
      const id = BUTTONS[button] || button;
      if (!input || typeof input.setButtonValueImmediate !== 'function') return false;
      input.setButtonValueImmediate(id, value);
      return true;
    },

    release: (handedness, button) => harness.press(handedness, button, 0),

    axes: (handedness, x = 0, y = 0) => {
      const input = controller(handedness);
      if (!input || typeof input.updateAxes !== 'function') return false;
      input.updateAxes(BUTTONS.thumbstick, x, y);
      return true;
    },

    /* The grab-leak test lives here. Disconnecting mid-gesture is what a controller
     * sleeping, a hand swap, or the session-start regression all look like to the
     * application, and the specified behaviour is that the window commits where it
     * was and nothing stays held. */
    disconnect: (handedness) => {
      const input = controller(handedness);
      if (!input) return false;
      input.connected = false;
      return true;
    },

    connect: (handedness) => {
      const input = controller(handedness);
      if (!input) return false;
      input.connected = true;
      return true;
    },

    /* Switching the primary input mode is how a hand/controller hot-swap reaches
     * the application: IWER replaces the input sources, which the runtime reports
     * as a simultaneous removal and addition, exactly as a real device does. */
    setInputMode: (mode) => {
      const device = state.device;
      if (!device) return false;
      device.primaryInputMode = mode;
      return true;
    },

    /* Drives the reference-space reset path. Whether Quest Browser itself fires
     * `reset` on a Meta-button recenter is still an open question for on-device
     * measurement; this at least lets the handler be exercised. */
    recenter: () => {
      const device = state.device;
      if (!device || typeof device.recenter !== 'function') return false;
      device.recenter();
      return true;
    },

    /* Cast the same ray XrControllerInput casts, and report what it hits.
     *
     * The input path can be perfectly healthy while the ray points at nothing, and
     * those two failures are indistinguishable from the outside: no grab, no error.
     * This separates them. */
    probeRay: async (handedness = 'right') => {
      const THREE = await import('three');
      const scene = await runtime().catch(() => null);
      const { xrStore } = await import('./xr-store.js');
      const entry = (xrStore.getState().inputSourceStates || [])
        .find((candidate) => candidate?.inputSource?.handedness === handedness);
      const object = entry?.object || null;
      if (!object) return { error: `no rendered object for ${handedness} controller` };

      object.updateMatrixWorld();
      const origin = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
      const direction = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(object.matrixWorld))
        .normalize();

      const raycaster = new THREE.Raycaster();
      raycaster.set(origin, direction);
      raycaster.far = 14;
      const hits = [];
      for (const [screenId, target] of (scene?.screenObjects || new Map())) {
        const found = raycaster.intersectObject(target, true);
        if (found.length) hits.push({ screenId, distance: Number(found[0].distance.toFixed(3)) });
      }
      hits.sort((a, b) => a.distance - b.distance);
      return {
        origin: origin.toArray().map((v) => Number(v.toFixed(3))),
        direction: direction.toArray().map((v) => Number(v.toFixed(3))),
        candidates: scene?.screenObjects?.size ?? 0,
        hits
      };
    },

    /* What the application's XR store sees, next to what the device is presenting.
     *
     * These two can disagree, and when they do every symptom is silent: the device
     * has controllers, the session is live, and nothing responds. This reports both
     * sides so the disagreement is visible rather than inferred. */
    inputDebug: async () => {
      const device = state.device;
      let storeView = { error: 'xr-store not loaded' };
      try {
        const { xrStore } = await import('./xr-store.js');
        const xs = xrStore.getState();
        storeView = {
          mode: xs.mode ?? null,
          hasSession: Boolean(xs.session),
          inputSourceStateCount: xs.inputSourceStates?.length ?? 0,
          inputSourceStates: (xs.inputSourceStates || []).map((entry) => ({
            type: entry?.type ?? null,
            handedness: entry?.inputSource?.handedness ?? null,
            targetRayMode: entry?.inputSource?.targetRayMode ?? null,
            profiles: entry?.inputSource?.profiles ?? null,
            gamepadKeys: entry?.gamepad ? Object.keys(entry.gamepad) : null,
            squeezeState: entry?.gamepad?.['xr-standard-squeeze']?.state ?? null,
            triggerState: entry?.gamepad?.['xr-standard-trigger']?.state ?? null
          }))
        };
      } catch (error) {
        storeView = { error: String(error && error.message ? error.message : error) };
      }

      const session = device?.activeSession;
      return {
        store: storeView,
        session: session
          ? {
              inputSources: Array.from(session.inputSources || []).map((source) => ({
                handedness: source.handedness,
                targetRayMode: source.targetRayMode,
                profiles: source.profiles,
                hasGrip: Boolean(source.gripSpace),
                buttons: source.gamepad
                  ? source.gamepad.buttons.map((b, i) => `${i}:${b.pressed ? 'P' : '.'}${b.value.toFixed(2)}`)
                  : null,
                axes: source.gamepad ? Array.from(source.gamepad.axes) : null
              }))
            }
          : { inputSources: [] },
        deviceControllers: device
          ? Object.entries(device.controllers || {}).map(([handedness, c]) => ({
              handedness,
              connected: c?.connected,
              squeezeValue: typeof c?.getButtonValue === 'function' ? c.getButtonValue('squeeze') : null
            }))
          : []
      };
    },

    /* Count XR animation frames over a window of wall-clock time.
     *
     * "Is the session actually producing frames?" is the first question any XR
     * failure should ask and the hardest one to answer by eye — the ContactShadows
     * incident in docs/WEBXR_HEADSET_FINDINGS.md reported 10,926 frames while the
     * display was black. A test that asserts behaviour without asserting that the
     * frame loop is running cannot tell "broken" apart from "never ran". */
    countFrames: async (durationMs = 1000) => {
      const session = state.device?.activeSession;
      if (!session) return { frames: 0, session: false };
      let frames = 0;
      let stop = false;
      const tick = () => {
        frames += 1;
        if (!stop) session.requestAnimationFrame(tick);
      };
      session.requestAnimationFrame(tick);
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      stop = true;
      return { frames, session: true, durationMs };
    },

    /* Reported rather than assumed. IWER exposes visibilityState for reading but
     * not, in this version, for writing, so the `visible-blurred` failure mode
     * cannot be driven from here yet and a test must not pretend otherwise. */
    canDriveVisibility: () => false
  };

  window.__SCC_XR__ = harness;

  /* Does something real already answer for immersive sessions? A native navigator.xr
   * that cannot actually present — desktop Chrome — is not a real runtime, and is
   * exactly the case forceInstall exists for. */
  const realRuntimePresent = async () => {
    if (typeof navigator === 'undefined' || !navigator.xr) return false;
    try {
      return Boolean(await navigator.xr.isSessionSupported('immersive-vr'));
    } catch {
      return false;
    }
  };

  realRuntimePresent()
    .then(async (real) => {
      if (real) {
        state.error = 'a real XR runtime is present; the harness will not replace it';
        console.warn(
          '[xr-harness] this device has a working WebXR runtime. Standing down rather ' +
          'than replacing it with an emulator; drop ?xr-harness=1 to use the real one.'
        );
        resolveReady(harness);
        return;
      }
      const { XRDevice, metaQuest3 } = await import('iwer');
      const device = new XRDevice(metaQuest3);
      device.installRuntime({ forceInstall: true });
      state.device = device;
      console.info('[xr-harness] IWER device installed. window.__SCC_XR__ is ready.');
      resolveReady(harness);
    })
    .catch((error) => {
      state.error = String(error && error.message ? error.message : error);
      console.error('[xr-harness] failed to install the emulated device', error);
      resolveReady(harness);
    });

  return harness;
};

export default installXrTestHarness;
