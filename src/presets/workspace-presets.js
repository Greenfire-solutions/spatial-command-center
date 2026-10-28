import { normalizeScreen, serializeScreen } from '../store/workspace-schema.js';
import { normalizeConnector } from '../connectors/connector-schema.js';
import { defaultUrlForType } from '../constants.js';

/*
 * Built-in workspace layouts. Presets are data: they describe screen
 * transforms and their sources, and are cloned through the normal schema
 * normalizer so a preset can never introduce a shape the loader would reject.
 */
/*
 * Every preset screen is a real Chromium surface.
 *
 * It used to be opt-in through a trailing `sourceType` argument, and exactly
 * one screen across all seven presets ever passed it. On a desktop that was
 * merely disappointing: the other thirty fell back to placeholder content
 * drawn in an <Html> overlay, which looks like a populated workspace. In an
 * immersive session <Html> renders nothing at all, so those thirty screens
 * were empty frames — the workspace appeared to be broken when it was in fact
 * faithfully drawing thirty things that had no content to draw.
 *
 * A source is therefore no longer optional. `sourceType` remains an argument
 * so a preset can still ask for something else, but it defaults to the type
 * that actually shows a web page.
 */
const presetScreen = (id, title, type, position, rotation, size, url, sourceType = 'chromium') => {
  const address = url || defaultUrlForType(type);
  return normalizeScreen({
    id,
    title,
    type,
    position,
    rotation,
    scale: [1, 1, 1],
    size,
    url: address,
    source: sourceType ? {
      id: 'source-' + id,
      sourceId: 'browser-' + id,
      type: sourceType,
      title,
      url: address,
      browserWidth: 1280,
      browserHeight: 800
    } : undefined,
    locked: false
  });
};

const PRESETS = {
  /*
   * What a new person meets on first start. Two plain, general web pages and
   * nothing that needs an account, so the first thing they see is the idea
   * (real pages floating in space) rather than someone else's tools. The
   * welcome card in the overlay explains how to add a screen.
   */
  Welcome: {
    screens: [
      presetScreen('w1', 'Wikipedia', 'browser', [-1.25, 1.55, -2.4], [0, 0.22, 0], [2.2, 1.35],
        'https://www.wikipedia.org', 'chromium'),
      presetScreen('w2', 'Map', 'browser', [1.25, 1.55, -2.4], [0, -0.22, 0], [2.2, 1.35],
        'https://www.openstreetmap.org', 'chromium')
    ],
    connections: []
  },

  /*
   * One desktop, sized to be read.
   *
   * The arithmetic rather than a guess: a Quest resolves roughly 25 pixels per
   * degree, so a 1600px capture is fully resolved when it subtends about 64
   * degrees. At 2.0m that is a screen 2.5m wide. Smaller wastes nothing but
   * makes it harder to read; larger sends pixels the display cannot show.
   *
   * Deliberately alone. The Developer arc is five screens of placeholder
   * content, which is the wrong first thing to meet when you have come to look
   * at one desktop.
   */
  Desktop: {
    screens: [
      presetScreen('d1', 'Mac desktop', 'browser', [0, 1.5, -2.0], [0, 0, 0], [2.5, 1.62],
        'macos://display/0', 'chromium')
    ],
    connections: []
  },

  /*
   * Five desktops on an arc.
   *
   * Sizing follows the same arithmetic as the single Desktop preset and then
   * runs into its consequence: at ~25 pixels per degree a readable 1600px
   * desktop subtends about 60 degrees, and five of those cannot share a 100
   * degree field. Shrinking them to fit is the tempting move and the wrong one,
   * because a desktop you cannot read is not a desktop.
   *
   * So they are placed to be turned to rather than taken in at once — centre,
   * then a pair at 55 degrees, then a pair at 110. Roughly what five physical
   * monitors on a curved desk occupy, and the flight controls already make
   * turning cheap.
   *
   * The outer pair carries a 180-degree correction. Deriving the yaw as
   * atan2 toward the origin gives +110 degrees, and that is what the first
   * version used; in the headset both end panels faced outward and could only
   * be read from behind. Measured beats derived, so they are placed at -70
   * degrees: the same plane, turned to face the viewer.
   *
   * The outer pair sits at 88 degrees rather than 110, and the reason is not
   * aesthetic. At 110 degrees their z is positive — behind the viewer — so from
   * the seat you meet their backs, and rotating them 180 degrees only changes
   * which side of the back you meet. Yaw cannot fix a panel placed behind you.
   *
   * At 88 degrees they sit just forward of your shoulders, reachable with a
   * head turn and never behind. The yaw is then simply the angle toward the
   * origin, the same rule the 55-degree pair uses and which reads correctly.
   *
   * One radius, one angular step, and a width derived from both.
   *
   * Flat panels arranged on a circle meet edge to edge when
   * width = 2 * R * tan(step / 2) — the panel's half-width has to reach exactly
   * the bisector between it and its neighbour. Choosing the radius and the step
   * and then picking a width by eye is what left the earlier arc overlapping.
   *
   * With the ends at +/-88 degrees, five panels give a 44 degree step, so each
   * subtends 44 degrees. That is below the ~64 degrees a 1600px capture would
   * need to be pixel-perfect at 25 pixels per degree: the trade is deliberate,
   * because five continuous surfaces beat four sharper ones with gaps.
   * in depth instead of intersecting where their edges overlap. The overlap is
   * deliberate: a few degrees of it reads as one continuous curved wall, where
   * a visible seam between every pair reads as five separate things.
   *
   * Display 0 is the physical Mac. Displays 1-4 are virtual screens that exist
   * only here — create them with `bin/scc-displays up` before loading this, or
   * the four outer panels have nothing to capture.
   */
  Desktops: {
    screens: [
      presetScreen('m0', 'Mac desktop', 'browser', [-0.0, 1.5, -2.45], [0, 0.0, 0], [1.98, 1.238],
        'macos://display/0', 'chromium'),
      presetScreen('m1', 'Desktop 1', 'browser', [-1.702, 1.5, -1.762], [0, 0.7679, 0], [1.98, 1.238],
        'macos://display/1', 'chromium'),
      presetScreen('m2', 'Desktop 2', 'browser', [1.702, 1.5, -1.762], [0, -0.7679, 0], [1.98, 1.238],
        'macos://display/2', 'chromium'),
      presetScreen('m3', 'Desktop 3', 'browser', [-2.449, 1.5, -0.086], [0, 1.5359, 0], [1.98, 1.238],
        'macos://display/3', 'chromium'),
      presetScreen('m4', 'Desktop 4', 'browser', [2.449, 1.5, -0.086], [0, -1.5359, 0], [1.98, 1.238],
        'macos://display/4', 'chromium')
    ],
    connections: []
  },

  /*
   * Every desktop, all the way around.
   *
   * A closed ring rather than an arc, so there is no front and no ends. The two
   * end panels were the entire source of trouble in the arc: a panel at the edge
   * has to face somewhere, and every choice looks wrong from some angle. A ring
   * has no edge, so the question stops existing.
   *
   * Displays 3 and 5 sit in each other's seat, and that is deliberate.
   *
   * Generated in index order every panel had yaw == bearing, which is the rule
   * that closes the ring, and yet those two alone would not line up in the
   * headset. Their live yaws turned out to carry each other's bearing exactly:
   * r3 at bearing 135 wanted 225, r5 at bearing 225 wanted 135. Swapping the
   * two seats restores yaw == bearing for all eight rather than special-casing
   * either one, so the ring stays uniform and the rule stays true everywhere.
   *
   * The panel is sized from its CONTENT, not the other way round.
   *
   * computeWindowRegions insets the page by a bezel on each side and a header
   * strip along the top, so a panel whose OUTER width closes the circle leaves
   * its content 2 * 0.055m short of its neighbour's. The frames touched and the
   * desktops did not, which from inside the ring is the only version anyone
   * cares about. Solving for the content and adding the chrome back fixes it;
   * the frames now overlap slightly at the seams, which is the correct thing to
   * trade away.
   *
   * Same edge-to-edge rule: flat panels on a circle meet when
   * width = 2 * R * tan(step / 2). Eight panels close the circle at 45 degrees,
   * which is also what each one subtends.
   *
   * Eight needs eight displays. `bin/scc-displays up 7` creates the seven
   * virtual ones; without them the missing panels point at capture devices that
   * do not exist. ScreenCaptureKit was measured at eight streams delivering
   * simultaneously before this was widened from five.
   *
   * Meant to be used with ?locked=1, which pins the viewer at the centre and
   * turns the sticks into a turntable.
   */
  Ring: {
    screens: [
      presetScreen('r0', 'Mac desktop', 'browser', [-0.0, 1.5, -2.6], [0, 0.0, 0], [2.264, 1.506],
        'macos://display/0', 'chromium'),
      presetScreen('r1', 'Desktop 1', 'browser', [-1.838, 1.5, -1.838], [0, 0.7854, 0], [2.264, 1.506],
        'macos://display/1', 'chromium'),
      presetScreen('r2', 'Desktop 2', 'browser', [-2.6, 1.5, -0.0], [0, 1.5708, 0], [2.264, 1.506],
        'macos://display/2', 'chromium'),
      presetScreen('r3', 'Desktop 3', 'browser', [1.838, 1.5, 1.838], [0, 3.927, 0], [2.264, 1.506],
        'macos://display/3', 'chromium'),
      presetScreen('r4', 'Desktop 4', 'browser', [-0.0, 1.5, 2.6], [0, 3.1416, 0], [2.264, 1.506],
        'macos://display/4', 'chromium'),
      presetScreen('r5', 'Desktop 5', 'browser', [-1.838, 1.5, 1.838], [0, 2.3562, 0], [2.264, 1.506],
        'macos://display/5', 'chromium'),
      presetScreen('r6', 'Desktop 6', 'browser', [2.6, 1.5, 0.0], [0, 4.7124, 0], [2.264, 1.506],
        'macos://display/6', 'chromium'),
      presetScreen('r7', 'Desktop 7', 'browser', [1.838, 1.5, -1.838], [0, 5.4978, 0], [2.264, 1.506],
        'macos://display/7', 'chromium')
    ],
    connections: []
  },

  Developer: {
    screens: [
      presetScreen('s1', 'VS Code: Codebase', 'code', [0, 1.55, -2.15], [0, 0, 0], [2.5, 1.55]),
      presetScreen('s2', 'Terminal: Build', 'terminal', [0, 0.42, -1.92], [-0.12, 0, 0], [2.35, 0.62]),
      presetScreen('s3', 'Reference', 'docs', [0, 2.82, -2.18], [0, 0, 0], [1.55, 0.82]),
      presetScreen('s4', 'AI Assistant', 'chat', [-2.28, 1.55, -1.48], [0, 0.38, 0], [1.45, 1.55]),
      presetScreen('s5', 'Chromium POC', 'browser', [2.38, 1.55, -1.42], [0, -0.38, 0], [1.9, 1.3], 'https://example.com', 'chromium')
    ],
    connections: [
      { id: 'c1', sourceId: 's3', targetId: 's1', agent: 'Context Extractor' },
      { id: 'c2', sourceId: 's5', targetId: 's1', agent: 'Code Reviewer' },
      { id: 'c3', sourceId: 's4', targetId: 's1', agent: 'Pair Programmer' }
    ]
  },
  CommandArc: {
    screens: [
      presetScreen('s1', 'Primary Dashboard', 'browser', [0, 1.58, -2.5], [0, 0, 0], [2.25, 1.4], 'https://example.com'),
      presetScreen('s2', 'Analytics', 'docs', [-2.25, 1.58, -2.0], [0, 0.45, 0], [1.75, 1.35]),
      presetScreen('s3', 'Communications', 'chat', [2.25, 1.58, -2.0], [0, -0.45, 0], [1.75, 1.35]),
      presetScreen('s4', 'System Logs', 'terminal', [-3.9, 1.58, -0.75], [0, 0.82, 0], [1.35, 1.25]),
      presetScreen('s5', 'AI Overseer', 'chat', [3.9, 1.58, -0.75], [0, -0.82, 0], [1.35, 1.25])
    ],
    connections: [
      { id: 'c4', sourceId: 's2', targetId: 's1', agent: 'Data Synthesizer' },
      { id: 'c5', sourceId: 's5', targetId: 's1', agent: 'Decision Engine' },
      { id: 'c6', sourceId: 's4', targetId: 's2', agent: 'Log Parser' }
    ]
  },
  Focus: {
    screens: [
      presetScreen('s1', 'Deep Work', 'code', [0, 1.55, -1.85], [0, 0, 0], [3.15, 1.95]),
      presetScreen('s2', 'Reference', 'docs', [-2.55, 1.25, -1.2], [0, 0.62, 0], [1.2, 1.55], 'https://en.wikipedia.org/wiki/Flow_(psychology)')
    ],
    connections: [
      { id: 'c7', sourceId: 's2', targetId: 's1', agent: 'Research Assistant' }
    ]
  },
  WideArc: {
    screens: [
      presetScreen('s1', 'Operations', 'browser', [0, 1.55, -2.65], [0, 0, 0], [2.0, 1.3]),
      presetScreen('s2', 'Research', 'docs', [-2.25, 1.55, -2.25], [0, 0.38, 0], [1.55, 1.3]),
      presetScreen('s3', 'Messages', 'chat', [2.25, 1.55, -2.25], [0, -0.38, 0], [1.55, 1.3]),
      presetScreen('s4', 'Telemetry', 'terminal', [-4.1, 1.55, -1.0], [0, 0.75, 0], [1.35, 1.2]),
      presetScreen('s5', 'Assistant', 'chat', [4.1, 1.55, -1.0], [0, -0.75, 0], [1.35, 1.2])
    ],
    connections: [
      { id: 'c8', sourceId: 's2', targetId: 's1', agent: 'Research Link' },
      { id: 'c9', sourceId: 's4', targetId: 's1', agent: 'Telemetry Agent' }
    ]
  },
  TripleMonitor: {
    screens: [
      presetScreen('s1', 'Main Display', 'browser', [0, 1.55, -2.25], [0, 0, 0], [2.25, 1.4]),
      presetScreen('s2', 'Left Display', 'code', [-2.25, 1.55, -1.65], [0, 0.42, 0], [1.85, 1.35]),
      presetScreen('s3', 'Right Display', 'docs', [2.25, 1.55, -1.65], [0, -0.42, 0], [1.85, 1.35])
    ],
    connections: [
      { id: 'c10', sourceId: 's2', targetId: 's1', agent: 'Build Context' },
      { id: 'c11', sourceId: 's3', targetId: 's1', agent: 'Reference Link' }
    ]
  },
  Stack: {
    screens: [
      presetScreen('s1', 'Upper Monitor', 'docs', [0, 2.45, -2.25], [0, 0, 0], [2.2, 1.05]),
      presetScreen('s2', 'Primary Monitor', 'code', [0, 1.15, -2.0], [0, 0, 0], [2.55, 1.45]),
      presetScreen('s3', 'Build Output', 'terminal', [0, 0.05, -1.72], [-0.12, 0, 0], [2.35, 0.62]),
      presetScreen('s4', 'Assistant', 'chat', [2.35, 1.35, -1.35], [0, -0.48, 0], [1.3, 1.35])
    ],
    connections: [
      { id: 'c12', sourceId: 's1', targetId: 's2', agent: 'Spec Reader' },
      { id: 'c13', sourceId: 's3', targetId: 's2', agent: 'Build Monitor' }
    ]
  },
  Surround: {
    screens: [
      presetScreen('s1', 'Center', 'browser', [0, 1.55, -2.8], [0, 0, 0], [1.9, 1.25]),
      presetScreen('s2', 'Center Left', 'code', [-2.1, 1.55, -2.45], [0, 0.34, 0], [1.55, 1.2]),
      presetScreen('s3', 'Center Right', 'docs', [2.1, 1.55, -2.45], [0, -0.34, 0], [1.55, 1.2]),
      presetScreen('s4', 'Left', 'terminal', [-3.75, 1.55, -1.35], [0, 0.7, 0], [1.35, 1.1]),
      presetScreen('s5', 'Right', 'chat', [3.75, 1.55, -1.35], [0, -0.7, 0], [1.35, 1.1]),
      presetScreen('s6', 'Far Left', 'docs', [-4.55, 1.55, 0.3], [0, 1.08, 0], [1.15, 1.0]),
      presetScreen('s7', 'Far Right', 'chat', [4.55, 1.55, 0.3], [0, -1.08, 0], [1.15, 1.0])
    ],
    connections: [
      { id: 'c14', sourceId: 's2', targetId: 's1', agent: 'Code Context' },
      { id: 'c15', sourceId: 's3', targetId: 's1', agent: 'Knowledge Link' },
      { id: 'c16', sourceId: 's4', targetId: 's2', agent: 'Log Parser' },
      { id: 'c17', sourceId: 's5', targetId: 's1', agent: 'Comms Agent' }
    ]
  }
};

const clonePreset = (name) => {
  const preset = PRESETS[name] || PRESETS.Developer;
  return {
    screens: preset.screens.map((screen) => normalizeScreen(serializeScreen(screen))),
    /* Preset connections are written in the short legacy form
     * { id, sourceId, targetId, agent }. They must go through the same
     * normalizer a saved workspace does, or the first save of a fresh
     * workspace throws on the missing capability list (the default layout
     * never saved at all until 2026-10-28). */
    connections: preset.connections.map((connection) => normalizeConnector({ ...connection }))
  };
};

export { PRESETS, clonePreset, presetScreen };
