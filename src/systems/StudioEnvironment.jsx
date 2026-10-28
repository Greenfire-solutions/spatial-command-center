import React from 'react';
import { Environment, Lightformer } from '@react-three/drei';

/*
 * A fully local image-based lighting environment.
 *
 * This replaces <Environment preset="city" />, which downloaded a 1K HDR from a
 * third-party CDN (raw.githack.com) on every start. That made a cold boot
 * depend on the network and on an asset host outside our control, inside the
 * trusted renderer.
 *
 * drei renders these Lightformers into an offscreen cube target once
 * (frames={1}) and converts it to a PMREM environment map, so the metallic
 * screen bezels keep real reflections and specular falloff with no asset
 * fetch, no bundled binary, and a deterministic result on every machine.
 *
 * The layout is a restrained three-point studio rig: a broad cool key above
 * the workspace, a dim warm fill from the front, and two narrow rim strips at
 * the sides that read as edge highlights along the screen bezels. It is
 * intentionally dark and low-contrast so the browser surfaces stay the
 * brightest thing in the scene.
 */
const StudioEnvironment = ({ resolution = 256 }) => (
  <Environment resolution={resolution} frames={1}>
    {/* Ambient shell: a very dark, slightly blue room rather than pure black,
        so reflective surfaces read as material instead of as holes. */}
    <mesh scale={100}>
      <sphereGeometry args={[1, 32, 16]} />
      <meshBasicMaterial color="#0a0d12" side={2} />
    </mesh>

    {/* Key: broad soft light above and slightly behind the viewer. */}
    <Lightformer
      intensity={1.6}
      color="#cfe0f5"
      form="rect"
      scale={[12, 6, 1]}
      position={[0, 7, 2]}
      rotation={[-Math.PI / 2, 0, 0]}
    />

    {/* Fill: low, warm, front-on. Keeps bezel shadows from going flat black. */}
    <Lightformer
      intensity={0.35}
      color="#f0e2d2"
      form="rect"
      scale={[10, 4, 1]}
      position={[0, 1.4, 7]}
    />

    {/* Rim strips: narrow verticals that produce the thin specular edge along
        each screen's bezel. This is what sells the hardware as physical. */}
    <Lightformer
      intensity={1.1}
      color="#93b6e6"
      form="rect"
      scale={[1, 8, 1]}
      position={[-8, 2.5, 1]}
      rotation={[0, Math.PI / 2, 0]}
    />
    <Lightformer
      intensity={0.85}
      color="#8fa8c8"
      form="rect"
      scale={[1, 8, 1]}
      position={[8, 2.5, 1]}
      rotation={[0, -Math.PI / 2, 0]}
    />

    {/* Floor bounce: a dim upward source that grounds the lower bezel edges. */}
    <Lightformer
      intensity={0.25}
      color="#5c6b80"
      form="rect"
      scale={[12, 6, 1]}
      position={[0, -3, 0]}
      rotation={[Math.PI / 2, 0, 0]}
    />
  </Environment>
);

export default StudioEnvironment;
