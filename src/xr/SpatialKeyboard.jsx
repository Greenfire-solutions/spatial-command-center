/*
 * The spatial keyboard.
 *
 * The one thing standing between a headset and actually using the workspace:
 * the in-scene address field has always been a read-only readout, so there was
 * no way to type a URL, fill a form, or drive a shell without taking the
 * headset off.
 *
 * Built from the same primitives as the rest of the in-scene chrome, so it is
 * ray-driven like everything else: point, pull the trigger, the key presses.
 * Nothing here is DOM, because DOM renders nothing inside an immersive session.
 *
 * It is placed once, where you were looking when it opened, rather than being
 * head-locked. A keyboard that follows your head is unusable, because looking
 * at the key you want to press moves it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { Quaternion, Vector3 } from 'three';

import { SPATIAL_THEME } from '../spatial-ui/theme.js';
import { roundedRectGeometry } from '../spatial-ui/geometry.js';
import { resolveBrowserProvider } from '../providers/index.js';
import { normalizeBrowserInput } from '../url-normalization.js';
import { useStore } from '../store/workspace-store.js';
import { sceneRuntime } from '../systems/scene-runtime.js';
import { closeKeyboard, onKeyboard, setBuffer, setShift } from './keyboard-state.js';
import { isSystemKeyboardSupported, openSystemKeyboard } from './system-keyboard.js';

const KEY = 0.092;
const GAP = 0.013;
const PITCH = KEY + GAP;

/* Rows are described, not drawn. A key is either a character or a named action,
 * and `span` widens it, which is the whole layout language. */
const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', { id: 'backspace', label: '⌫' }],
  [{ id: 'shift', label: '⇧' }, 'z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '/'],
  [
    { id: 'esc', label: 'esc' },
    { id: 'tab', label: 'tab' },
    { id: 'space', label: 'space', span: 4 },
    { id: 'dotcom', label: '.com', span: 1.5 },
    { id: 'enter', label: '↵', span: 1.5 },
    { id: 'close', label: '✕' }
  ]
];

const SHIFTED = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
  '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '.': ':', '/': '?'
};

const Key = ({ label, x, y, width, onPress, accent = false, held = false }) => {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const geometry = useMemo(
    () => roundedRectGeometry(width, KEY, KEY * 0.22),
    [width]
  );

  const colour = pressed || held
    ? SPATIAL_THEME.color.accentSoft
    : hovered
      ? SPATIAL_THEME.color.panelRaised
      : SPATIAL_THEME.color.panel;

  return (
    <group position={[x, y, 0.002]}>
      <mesh
        geometry={geometry}
        renderOrder={40}
        onPointerOver={(event) => { event.stopPropagation(); setHovered(true); }}
        onPointerOut={() => { setHovered(false); setPressed(false); }}
        onPointerDown={(event) => { event.stopPropagation(); setPressed(true); }}
        onPointerUp={(event) => {
          event.stopPropagation();
          if (pressed) onPress();
          setPressed(false);
        }}
      >
        <meshBasicMaterial
          color={colour}
          transparent
          opacity={0.96}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>
      <Text
        position={[0, 0, 0.003]}
        fontSize={label.length > 2 ? 0.019 : 0.028}
        color={accent ? SPATIAL_THEME.color.accentGlow : SPATIAL_THEME.color.text}
        anchorX="center"
        anchorY="middle"
        renderOrder={41}
      >
        {label}
      </Text>
    </group>
  );
};

export const SpatialKeyboard = () => {
  const { gl, camera } = useThree();
  const group = useRef(null);
  const placed = useRef(false);
  const anchorPosition = useRef(new Vector3());
  const anchorQuaternion = useRef(new Quaternion());
  const offset = useRef(new Vector3());
  const forwardVector = useRef(new Vector3());
  const [state, setState] = useState(() => ({ open: false, mode: 'page', screenId: null, buffer: '', shift: false }));
  /* While the headset's own keyboard is up, drawing ours as well would offer two
   * keyboards for one caret. */
  const [systemKeyboardActive, setSystemKeyboardActive] = useState(false);

  useEffect(() => onKeyboard(setState), []);

  useEffect(() => {
    if (!state.open) placed.current = false;
  }, [state.open]);

  /*
   * The keyboard belongs to the screen you are typing into.
   *
   * The first version placed it with camera maths and got the yaw 180 degrees
   * wrong, so every key faced away from the user. A plane's normal is +Z, and a
   * raycast that reaches a back face is rejected outright, which is why it
   * presented as standing behind an unclickable keyboard. Both symptoms, one
   * sign error.
   *
   * Deriving the transform from the target screen removes the class of bug
   * rather than the instance: the screen already faces the user, because the
   * user put it there. The keyboard hangs beneath it in the screen's own frame,
   * so it is always reachable, always the right way round, and it follows the
   * screen it belongs to.
   */
  useFrame(() => {
    if (!state.open || !group.current) return;

    const store = useStore.getState();
    const screenId = state.screenId || store.selectedScreen;
    const screen = store.screens.find((entry) => entry.id === screenId);
    const object = screenId ? sceneRuntime.screenObjects.get(screenId) : null;

    if (object) {
      const screenHeight = (screen?.size?.[1] ?? 1.4) * (screen?.scale?.[1] ?? 1);
      object.updateWorldMatrix(true, false);
      object.getWorldPosition(anchorPosition.current);
      object.getWorldQuaternion(anchorQuaternion.current);

      /* Down and slightly toward the viewer in the screen's own frame, so the
       * board sits under the screen and tilts up to meet the face. */
      offset.current.set(0, -(screenHeight / 2 + 0.30), 0.14)
        .applyQuaternion(anchorQuaternion.current);
      group.current.position.copy(anchorPosition.current).add(offset.current);
      group.current.quaternion.copy(anchorQuaternion.current);
      group.current.rotateX(-0.62);
      return;
    }

    /* Nothing to hang from: fall back to the viewer, using the camera's own
     * orientation rather than a reconstructed yaw. Copying the quaternion is
     * what the diagnostics panel does, and it has never faced the wrong way. */
    if (placed.current) return;
    const active = (gl.xr && gl.xr.isPresenting && gl.xr.getCamera()) || camera;
    active.getWorldPosition(anchorPosition.current);
    active.getWorldDirection(forwardVector.current);
    group.current.position
      .copy(anchorPosition.current)
      .addScaledVector(forwardVector.current, 0.6);
    group.current.position.y -= 0.32;
    group.current.quaternion.copy(active.quaternion);
    group.current.rotateX(-0.55);
    placed.current = true;
  });

  const targetScreen = useCallback(() => {
    const store = useStore.getState();
    const id = state.screenId || store.selectedScreen;
    return store.screens.find((screen) => screen.id === id) || null;
  }, [state.screenId]);

  const sendToPage = useCallback((event) => {
    const screen = targetScreen();
    const sourceId = screen && screen.source && screen.source.sourceId;
    if (!sourceId) return;
    const provider = resolveBrowserProvider();
    if (!provider.available) return;
    /*
     * Claim focus before typing, every time.
     *
     * The host accepts keystrokes only for the source it considers focused and
     * throws SOURCE_NOT_FOCUSED otherwise — a rule worth keeping, since typing
     * into an unfocused window is never what was meant. But the focused source
     * is host state that anything touching DOM focus can invalidate, and in a
     * headset the rejection is silent: the wearer presses keys and the page
     * does not change. Asserting focus here costs one idempotent message and
     * removes a whole class of "the keyboard does nothing".
     */
    provider.focus(sourceId);
    if (event.text !== undefined) provider.insertText(sourceId, event.text);
    else {
      provider.sendKeyboardEvent(sourceId, { type: 'keyDown', keyCode: event.keyCode, modifiers: [] });
      provider.sendKeyboardEvent(sourceId, { type: 'keyUp', keyCode: event.keyCode, modifiers: [] });
    }
  }, [targetScreen]);

  const commitAddress = useCallback((text) => {
    const screen = targetScreen();
    const normalized = normalizeBrowserInput(text === undefined ? state.buffer : text);
    if (!screen || !normalized.url) return;
    const store = useStore.getState();
    if (screen.source && screen.source.type !== 'chromium') {
      store.switchScreenSource(screen.id, 'chromium');
    }
    const current = useStore.getState().screens.find((entry) => entry.id === screen.id) || screen;
    const sourceId = current.source && current.source.sourceId;
    store.updateScreenUrl?.(screen.id, normalized.url);
    const provider = resolveBrowserProvider();
    if (sourceId && provider.available) {
      setTimeout(() => provider.navigate(sourceId, normalized.url), 250);
    }
    closeKeyboard();
  }, [state.buffer, targetScreen]);

  /*
   * Hand over to the headset's own keyboard when the runtime has one.
   *
   * Preferred over the drawn keys for every reason that matters in a headset:
   * it is the layout the wearer already knows, it brings swipe, punctuation and
   * dictation, and it costs no scene space or controller aim. The in-scene
   * board stays as the fallback, so text entry never depends on a capability
   * the runtime might not have.
   */
  useEffect(() => {
    if (!state.open) return undefined;
    const session = gl.xr && gl.xr.getSession && gl.xr.getSession();
    if (!isSystemKeyboardSupported(session)) return undefined;

    const isAddress = state.mode === 'address';
    /* The platform reports the field value whole, never a keystroke. Within one
     * editing session those values are still incremental, so the difference
     * between successive reads is a real edit and can be replayed into the page
     * as one. Across sessions it cannot: opening the keyboard overwrites the
     * value by design. */
    let previous = isAddress ? state.buffer : '';

    const handle = openSystemKeyboard({
      session,
      initial: previous,
      onChange: (value) => {
        if (isAddress) {
          setBuffer(value);
          return;
        }
        let shared = 0;
        while (shared < previous.length && shared < value.length && previous[shared] === value[shared]) shared += 1;
        for (let index = previous.length; index > shared; index -= 1) sendToPage({ keyCode: 'Backspace' });
        if (value.length > shared) sendToPage({ text: value.slice(shared) });
        previous = value;
      },
      onCommit: (value) => {
        if (isAddress) commitAddress(value);
        else sendToPage({ keyCode: 'Return' });
      },
      onClose: () => closeKeyboard()
    });

    setSystemKeyboardActive(Boolean(handle));
    return () => {
      setSystemKeyboardActive(false);
      handle?.close();
    };
    /* Deliberately keyed on the editing session only. Re-running on every
     * keystroke would tear down the keyboard mid-word, and `state.buffer` is
     * read once as the initial value on purpose. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.mode, state.screenId, gl]);

  const press = useCallback((key) => {
    const isAddress = state.mode === 'address';

    if (typeof key === 'string') {
      const character = state.shift ? (SHIFTED[key] || key.toUpperCase()) : key;
      if (isAddress) setBuffer(state.buffer + character);
      else sendToPage({ text: character });
      if (state.shift) setShift(false);
      return;
    }

    switch (key.id) {
      case 'shift': return setShift(!state.shift);
      case 'space':
        if (isAddress) return setBuffer(`${state.buffer} `);
        return sendToPage({ text: ' ' });
      case 'dotcom':
        if (isAddress) return setBuffer(`${state.buffer}.com`);
        return sendToPage({ text: '.com' });
      case 'backspace':
        if (isAddress) return setBuffer(state.buffer.slice(0, -1));
        return sendToPage({ keyCode: 'Backspace' });
      case 'enter':
        if (isAddress) return commitAddress();
        return sendToPage({ keyCode: 'Return' });
      case 'tab': return sendToPage({ keyCode: 'Tab' });
      case 'esc':
        if (isAddress) return closeKeyboard();
        return sendToPage({ keyCode: 'Escape' });
      case 'close': return closeKeyboard();
      default: return undefined;
    }
  }, [commitAddress, sendToPage, state.buffer, state.mode, state.shift]);

  if (!state.open || systemKeyboardActive) return null;

  const widest = Math.max(...ROWS.map((row) => row.reduce(
    (total, key) => total + (typeof key === 'object' && key.span ? key.span : 1), 0
  )));
  const boardWidth = widest * PITCH + GAP;
  const boardHeight = ROWS.length * PITCH + GAP + 0.07;

  return (
    <group ref={group} name="spatial-keyboard">
      <mesh renderOrder={38}>
        <planeGeometry args={[boardWidth + 0.03, boardHeight + 0.03]} />
        <meshBasicMaterial color="#0a0d13" transparent opacity={0.93} depthWrite={false} depthTest={false} />
      </mesh>

      {/* What you are typing, and where it is going. Without this the address
        * mode is invisible: keys would vanish into a buffer with no feedback. */}
      <Text
        position={[-boardWidth / 2 + 0.02, boardHeight / 2 - 0.03, 0.003]}
        fontSize={0.026}
        color={state.mode === 'address' ? SPATIAL_THEME.color.accentGlow : SPATIAL_THEME.color.textMuted}
        anchorX="left"
        anchorY="middle"
        maxWidth={boardWidth - 0.04}
        renderOrder={42}
      >
        {state.mode === 'address'
          ? `${state.buffer || 'type an address'}`
          : 'typing into the page'}
      </Text>

      {ROWS.map((row, rowIndex) => {
        let cursor = 0;
        return row.map((key, keyIndex) => {
          const span = typeof key === 'object' && key.span ? key.span : 1;
          const width = span * PITCH - GAP;
          const x = -boardWidth / 2 + GAP / 2 + cursor * PITCH + width / 2;
          cursor += span;
          const label = typeof key === 'string'
            ? (state.shift ? (SHIFTED[key] || key.toUpperCase()) : key)
            : key.label;
          const y = boardHeight / 2 - 0.075 - rowIndex * PITCH - KEY / 2;
          return (
            <Key
              key={`${rowIndex}-${keyIndex}`}
              label={label}
              x={x}
              y={y}
              width={width}
              accent={typeof key === 'object' && (key.id === 'enter' || key.id === 'dotcom')}
              held={typeof key === 'object' && key.id === 'shift' && state.shift}
              onPress={() => press(key)}
            />
          );
        });
      })}
    </group>
  );
};

export default SpatialKeyboard;
