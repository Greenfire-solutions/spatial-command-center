/*
 * Spatial UI design tokens.
 *
 * The visual direction is a dark, restrained, professional instrument panel.
 * The browser surfaces are the brightest thing in the workspace; chrome sits
 * quietly beneath them. Glow indicates state, never decoration, and motion is
 * short and eased rather than animated.
 *
 * Sizes are in world metres. A control is sized so that it subtends roughly
 * the same angle at typical working distance as its DOM counterpart does on a
 * monitor, which keeps desktop and headset muscle memory aligned.
 */

export const SPATIAL_THEME = Object.freeze({
  color: Object.freeze({
    panel: '#161a21',
    panelRaised: '#1c212a',
    border: '#2b323d',
    borderStrong: '#3d4756',

    text: '#d7dae0',
    textMuted: '#8b929e',
    textStrong: '#ffffff',

    accent: '#5b9df9',
    accentSoft: '#24406b',
    accentGlow: '#7fb4ff',

    danger: '#f4776a',
    dangerSoft: '#4a2320',
    success: '#4ec9a0',
    warning: '#e0b355',

    icon: '#aeb4bf',
    iconActive: '#ffffff',
    iconDisabled: '#5a616c'
  }),

  opacity: Object.freeze({
    panel: 0.94,
    panelIdle: 0.82,
    disabled: 0.32,
    hairline: 0.5
  }),

  size: Object.freeze({
    buttonSize: 0.085,
    buttonGap: 0.012,
    barPadding: 0.018,
    barRadius: 0.028,
    dividerWidth: 0.0015,
    dividerHeight: 0.05,

    browserBarHeight: 0.105,
    browserBarRadius: 0.018,
    addressHeight: 0.062,
    addressRadius: 0.012,

    iconInset: 0.2,
    labelSize: 0.032,
    captionSize: 0.024,

    /* How far chrome floats in front of a screen's face, so it never z-fights
     * with the browser texture behind it. */
    surfaceOffset: 0.012
  }),

  motion: Object.freeze({
    hoverSeconds: 0.12,
    pressSeconds: 0.07
  })
});

export default SPATIAL_THEME;
