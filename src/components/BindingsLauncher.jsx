/*
 * A way to reach the controller bindings without a command bar.
 *
 * The menu itself is the interesting part; this is only its door. It sits with
 * the other overlay chrome rather than inside any one panel, because bindings
 * are a property of the workspace and not of a screen.
 */

import React, { useState } from 'react';

import BindingsMenu from './BindingsMenu.jsx';

export const BindingsLauncher = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="open-bindings"
        title="Controller bindings"
        className="absolute bottom-5 left-5 z-30 pointer-events-auto glass-panel rounded-xl px-3 py-2 text-gray-300 hover:text-white text-sm"
      >
        🎮
      </button>
      <BindingsMenu open={open} onClose={() => setOpen(false)} />
    </>
  );
};

export default BindingsLauncher;
