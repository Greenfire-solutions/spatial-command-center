/*
 * The mesh versus quad layer comparison.
 *
 * This is the instrument for the second Phase 0 question. Both panels carry the
 * identical canvas at the identical world size, side by side at the same
 * distance, so the only variable is how the pixels reach the eye:
 *
 *   Left  — a textured mesh. Sampled into the eye buffer, then resampled by the
 *           display pipeline. This is what every screen in the app uses today.
 *   Right — a WebXR quad layer. Sampled once by the compositor at source
 *           resolution, with `quality="text-optimized"`.
 *
 * Read the smallest legible row on each. The difference between those two
 * numbers is the entire argument for or against building the streaming provider
 * around layers, and it costs one session in the headset to obtain.
 *
 * Outside an immersive session the layer falls back to an ordinary mesh, so on
 * desktop both panels look the same. That is expected: the comparison only
 * exists inside a headset.
 */

import React, { useEffect, useMemo } from 'react';
import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import { Text } from '@react-three/drei';
import { XRLayer } from '@react-three/xr';
import { drawSyntheticPage } from './synthetic-page.js';

const PAGE_WIDTH = 1280;
const PAGE_HEIGHT = 800;

/* Matches DEFAULT_SCREEN_SIZE proportions so the reading transfers to real
 * screens rather than to a panel sized only for this test. */
const PANEL_WIDTH = 2.2;
const PANEL_HEIGHT = (PANEL_WIDTH * PAGE_HEIGHT) / PAGE_WIDTH;
const GAP = 0.28;

const Caption = ({ position, children, color = '#dbeafe' }) => (
  <Text
    position={position}
    fontSize={0.075}
    color={color}
    anchorX="center"
    anchorY="bottom"
    outlineWidth={0.004}
    outlineColor="#04070f"
  >
    {children}
  </Text>
);

export const LegibilityProbe = ({ position = [0, 1.55, -2.4] }) => {
  const canvas = useMemo(
    () => drawSyntheticPage({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      kind: 'legibility',
      title: 'Legibility reference',
      url: 'https://probe.local/legibility'
    }),
    []
  );

  const texture = useMemo(() => {
    const created = new CanvasTexture(canvas);
    created.colorSpace = SRGBColorSpace;
    /* Linear rather than mipmapped: mipmaps would hide the minification this
     * probe exists to reveal, flattering the mesh and inverting the result. */
    created.minFilter = LinearFilter;
    created.magFilter = LinearFilter;
    created.generateMipmaps = false;
    created.needsUpdate = true;
    return created;
  }, [canvas]);

  useEffect(() => () => texture.dispose(), [texture]);

  const halfSpan = PANEL_WIDTH / 2 + GAP / 2;

  return (
    <group position={position} name="legibility-probe">
      <Caption position={[-halfSpan, PANEL_HEIGHT / 2 + 0.06, 0]}>
        Textured mesh
      </Caption>
      <mesh position={[-halfSpan, 0, 0]} name="legibility-mesh">
        <planeGeometry args={[PANEL_WIDTH, PANEL_HEIGHT]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>

      <Caption position={[halfSpan, PANEL_HEIGHT / 2 + 0.06, 0]} color="#bbf7d0">
        Quad layer, text-optimized
      </Caption>
      <XRLayer
        name="legibility-layer"
        position={[halfSpan, 0, 0]}
        scale={[PANEL_WIDTH, PANEL_HEIGHT, 1]}
        shape="quad"
        quality="text-optimized"
        pixelWidth={PAGE_WIDTH}
        pixelHeight={PAGE_HEIGHT}
        src={canvas}
      />

      <Caption position={[0, -PANEL_HEIGHT / 2 - 0.14, 0]} color="#94a3b8">
        Read the smallest legible row on each panel
      </Caption>
    </group>
  );
};

export default LegibilityProbe;
