import React, { useEffect, useState } from 'react';
import { XR_SESSION_MODES, isSessionModeSupported, xrStore } from './xr-store.js';

/*
 * Entry into an immersive session.
 *
 * These live in the DOM overlay on purpose: they are only ever pressed while
 * the user is still looking at a monitor. Once a session starts the overlay
 * stops existing, and everything the user needs is in-scene.
 *
 * Nothing is offered that the runtime cannot actually do. Electron's Chromium
 * has no navigator.xr, so on the desktop build this renders nothing at all
 * rather than showing a button that would fail.
 */
export const XrEntryControls = () => {
  const [support, setSupport] = useState({ vr: false, ar: false, checked: false });
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([
      isSessionModeSupported(XR_SESSION_MODES.IMMERSIVE_VR),
      isSessionModeSupported(XR_SESSION_MODES.IMMERSIVE_AR)
    ]).then(([vr, ar]) => {
      if (active) setSupport({ vr, ar, checked: true });
    });
    return () => {
      active = false;
    };
  }, []);

  if (!support.checked || (!support.vr && !support.ar)) return null;

  const enter = (mode) => {
    setError('');
    const request = mode === XR_SESSION_MODES.IMMERSIVE_AR ? xrStore.enterAR() : xrStore.enterVR();
    Promise.resolve(request).catch((reason) => {
      setError(reason?.message || 'The headset declined the session request.');
    });
  };

  return (
    <div className="absolute bottom-5 right-5 pointer-events-auto" data-testid="xr-entry">
      <div className="glass-panel rounded-2xl p-1.5 flex items-center gap-1">
        {support.vr && (
          <button
            type="button"
            className="px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-semibold tracking-wide"
            data-testid="enter-vr"
            onClick={() => enter(XR_SESSION_MODES.IMMERSIVE_VR)}
          >
            ENTER VR
          </button>
        )}
        {support.ar && (
          <button
            type="button"
            className="px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-200 text-[10px] font-semibold tracking-wide"
            data-testid="enter-mr"
            title="Passthrough mixed reality, where the runtime supports it"
            onClick={() => enter(XR_SESSION_MODES.IMMERSIVE_AR)}
          >
            ENTER MR
          </button>
        )}
      </div>
      {error && (
        <div className="mt-2 max-w-[220px] text-[9px] text-amber-300 text-right leading-relaxed">
          {error}
        </div>
      )}
    </div>
  );
};

export default XrEntryControls;
