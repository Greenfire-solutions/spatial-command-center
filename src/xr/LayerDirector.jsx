import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useXR } from '@react-three/xr';

import { evaluateQuality } from '../systems/browser-quality.js';
import { sceneRuntime } from '../systems/scene-runtime.js';
import { viewpointPosition } from '../systems/viewpoint.js';
import { useStore } from '../store/workspace-store.js';
import { DEFAULT_LAYER_BUDGET, planLayers, reduceBudget } from './layer-policy.js';

/*
 * Decides, four times a second, which screens are composition layers.
 *
 * Mirrors BrowserQualityDirector deliberately — same cadence, same source of
 * truth for attention. Layers and frame budget are two ways of spending on the
 * screens the user is actually looking at, and they should never disagree
 * about which those are.
 *
 * Everything it decides comes from layer-policy.js, which is pure and tested.
 * This component only supplies the live inputs — session, viewer pose,
 * attention tiers — and writes the result to the store.
 */

const THREE_VECTOR = { current: null };

export const LayerDirector = () => {
  const screens = useStore((state) => state.screens);
  const selectedScreen = useStore((state) => state.selectedScreen);
  const enabled = useStore((state) => state.browserLayersEnabled);
  const setLayerScreenIds = useStore((state) => state.setLayerScreenIds);

  const session = useXR((state) => state.session);
  const { gl } = useThree();

  const elapsedRef = useRef(0);
  const budgetRef = useRef(DEFAULT_LAYER_BUDGET);
  const positionRef = useRef(null);

  /* A session that ends must not leave screens believing they are layers. */
  useEffect(() => {
    if (!session) setLayerScreenIds([]);
  }, [session, setLayerScreenIds]);

  useFrame((state, delta) => {
    elapsedRef.current += delta;
    if (elapsedRef.current < 0.25) return;
    elapsedRef.current = 0;

    const presenting = Boolean(session);
    if (!presenting) {
      setLayerScreenIds([]);
      return;
    }

    /* The runtime advertises layer support through the session's enabled
     * features. Asking rather than assuming means an older browser degrades to
     * meshes instead of throwing on the first submission. */
    const layersSupported = Boolean(
      session.enabledFeatures?.includes?.('layers')
      ?? (typeof XRWebGLBinding !== 'undefined')
    );

    if (!positionRef.current) positionRef.current = viewpointPosition();
    const viewer = viewpointPosition(positionRef.current);

    const tiers = evaluateQuality({
      screens,
      screenObjects: sceneRuntime.screenObjects,
      focusedScreenId: selectedScreen
    });

    const plan = planLayers({
      screens,
      tiers,
      viewerPosition: [viewer.x, viewer.y, viewer.z],
      presenting,
      layersSupported,
      enabled,
      budget: budgetRef.current,
      /* Read the live object, so a screen being moved is ordered by where it
       * is rather than where it was committed. */
      positionOf: (screen) => {
        const object = sceneRuntime.screenObjects.get(screen.id);
        return object
          ? [object.position.x, object.position.y, object.position.z]
          : screen.position;
      }
    });

    setLayerScreenIds(plan.order);
  });

  /*
   * Learn the ceiling by being refused.
   *
   * updateRenderState() throws when a session is given more layers than it
   * supports, and publishes no limit to read beforehand. Catching that and
   * backing off by one turns an unrecoverable frame into a soft one, and the
   * lowered budget persists for the session.
   */
  useEffect(() => {
    if (!session || !gl?.xr) return undefined;
    const onError = (event) => {
      const message = String(event?.message || event?.reason?.message || '');
      if (!/layer/i.test(message)) return;
      budgetRef.current = reduceBudget(budgetRef.current);
      useStore.getState().showToast(
        budgetRef.current === 0
          ? 'This headset would not accept layered browser surfaces.'
          : `Reduced to ${budgetRef.current} sharp surfaces.`
      );
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onError);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onError);
    };
  }, [session, gl]);

  return null;
};

export default LayerDirector;
