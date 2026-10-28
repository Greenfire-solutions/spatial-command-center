/*
 * Virtual displays, and the map from a display to something ffmpeg can capture.
 *
 * macOS Spaces are the obvious way to get "more desktops" and the wrong one:
 * only the active Space is composited, so the others cannot be captured while
 * you are not looking at them — which is exactly when a spatial workspace needs
 * them. Virtual displays are the primitive that actually works. Every one is
 * always composited, whether or not it is on screen, because as far as the
 * window server is concerned a monitor is plugged in.
 *
 * BetterDisplay provides them. It is already how this Mac drives its panels, it
 * exposes a CLI, and its virtual screens appear to the system as ordinary
 * displays — so they land in avfoundation's capture list for free.
 *
 * Sizing is deliberate. A virtual screen is created at 1600x1000 logical with
 * HiDPI on, which presents a 3200x2000 framebuffer. Capturing that and scaling
 * to 1600 wide supersamples by exactly 2x, and the resulting text is markedly
 * cleaner than capturing 1600 natively. It is also the width the headset
 * measurement settled on: at the Quest 3S's ~25 pixels per degree, 1600px
 * subtends ~64 degrees, which is a full comfortable field for one screen.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const VIRTUAL_PREFIX = 'SCC-';
export const LOGICAL_WIDTH = 1600;
export const LOGICAL_HEIGHT = 1000;

const cli = async (args) => {
  try {
    const { stdout } = await run('betterdisplaycli', args, { timeout: 20_000 });
    return stdout.trim();
  } catch (error) {
    throw new Error(`betterdisplaycli ${args.join(' ')}: ${error.stderr?.trim() || error.message}`);
  }
};

/*
 * betterdisplaycli prints its identifiers as bare JSON objects separated by
 * commas, which is not a document. Wrapping in brackets is what makes it one.
 */
export const listDevices = async () => {
  const raw = await cli(['get', '-identifiers']);
  if (!raw) return [];
  return JSON.parse(`[${raw}]`);
};

export const listVirtual = async () =>
  (await listDevices()).filter((d) => d.deviceType === 'VirtualScreen');

/*
 * avfoundation's device index is not the display's index.
 *
 * The list interleaves cameras and screens — a FaceTime camera and a phone
 * continuity camera push "Capture screen 0" to index 2 on this machine, and
 * plugging in a webcam would move it again. Only the "Capture screen N" ordinal
 * is stable against that, so the ordinal is what a display is addressed by and
 * the ffmpeg index is looked up fresh each time.
 */
export const captureDeviceMap = async () => {
  let output = '';
  try {
    await run('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeout: 20_000 });
  } catch (error) {
    /* ffmpeg always exits non-zero for a device listing; the list is on stderr. */
    output = error.stderr || '';
  }
  const map = new Map();
  for (const line of output.split('\n')) {
    const match = line.match(/\[(\d+)\]\s+Capture screen (\d+)/i);
    if (match) map.set(Number(match[2]), String(match[1]));
  }
  return map;
};

/* `macos://display/3` -> 3. Anything unparseable is the main display, which is
 * the safe default: a mistyped URL shows the wrong desktop rather than nothing. */
export const displayOrdinal = (url) => {
  const match = String(url || '').match(/^macos:\/\/display\/(\d+)/);
  return match ? Number(match[1]) : 0;
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Bring the virtual displays up to `count`, idempotently.
 *
 * Existing SCC- screens are reused rather than recreated: tearing them down
 * would move every window the user has already placed on them, which turns a
 * restart of the host into a lost workspace.
 */
export const ensureVirtualDisplays = async (count, log = () => {}) => {
  const existing = await listVirtual();
  log(`${existing.length} virtual screen(s) already present`);

  for (let index = existing.length; index < count; index += 1) {
    const name = `${VIRTUAL_PREFIX}${index + 1}`;
    log(`creating ${name}`);
    await cli([
      'create', '-type=VirtualScreen', `-virtualScreenName=${name}`,
      '-aspectWidth=16', '-aspectHeight=10', '-virtualScreenHiDPI=on'
    ]);
    await settle(1500);
  }

  /* Connect and size every one, including pre-existing screens: a screen left
   * disconnected by a previous run has a displayID of 0 and never reaches the
   * capture list, which looks exactly like a broken host. */
  const all = await listVirtual();
  for (const device of all.slice(0, count)) {
    await cli(['set', `-tagID=${device.tagID}`, '-connected=on']);
    await settle(800);
    /*
     * A resolution set reports failure when the mode is already active, and a
     * screen that was already the right size is a success, not an error. It can
     * also fail transiently while a freshly connected screen settles, so this
     * retries once and then reports rather than aborting: a wrong-sized screen
     * is still a usable screen, and taking down the whole run over one is worse
     * than saying which one is off.
     */
    const size = `${LOGICAL_WIDTH}x${LOGICAL_HEIGHT}`;
    let current = await cli(['get', `-tagID=${device.tagID}`, '-resolution']).catch(() => '');
    for (let attempt = 0; attempt < 2 && current !== size; attempt += 1) {
      await cli(['set', `-tagID=${device.tagID}`, `-resolution=${size}`]).catch(() => {});
      await settle(800);
      current = await cli(['get', `-tagID=${device.tagID}`, '-resolution']).catch(() => '');
    }
    log(current === size
      ? `${device.name} connected at ${size} HiDPI`
      : `${device.name} connected, but reports ${current || 'unknown'} rather than ${size}`);
  }
  await settle(1500);
  return listVirtual();
};

export const disconnectVirtualDisplays = async (log = () => {}) => {
  for (const device of await listVirtual()) {
    await cli(['set', `-tagID=${device.tagID}`, '-connected=off']);
    log(`${device.name} disconnected`);
  }
};

/*
 * Which avfoundation screen device is which display.
 *
 * ffmpeg numbers "Capture screen N" by CGGetActiveDisplayList order, so that
 * list is the answer rather than something to be inferred. On this machine
 * betterdisplaycli's listing order and the displayID order disagreed, so at
 * most one of them could have been right, and picking wrong would have
 * produced a workspace showing five real desktops with the labels shuffled —
 * the kind of wrong that stays plausible for a long time.
 *
 * The first attempt measured it by setting each screen to a unique resolution
 * and asking every capture device what size it was producing. That needs
 * exclusive access to a device the running host already holds, so it hung
 * forever on the first one. Reading the list the enumeration is built from
 * costs nothing and cannot deadlock.
 */
const LIST_DISPLAYS = new URL('./.bin/list-displays', import.meta.url).pathname;

export const activeDisplays = async () => {
  try {
    const { stdout } = await run(LIST_DISPLAYS, [], { timeout: 10_000 });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `could not enumerate displays (${error.message}). ` +
      'Rebuild with: swiftc -O -o macos-bridge/.bin/list-displays macos-bridge/list-displays.swift'
    );
  }
};

/*
 * Displays joined to the names BetterDisplay knows them by, on displayID —
 * the one identifier both sides agree on.
 */
export const describeDisplays = async () => {
  const [displays, devices, ffmpeg] = await Promise.all([
    activeDisplays(), listDevices(), captureDeviceMap()
  ]);
  const byId = new Map(devices.map((d) => [String(d.displayID), d]));
  return displays.map((display) => ({
    ...display,
    name: byId.get(String(display.displayID))?.name || `Display ${display.displayID}`,
    virtual: byId.get(String(display.displayID))?.deviceType === 'VirtualScreen',
    ffmpegIndex: ffmpeg.get(display.ordinal) ?? null,
    address: `macos://display/${display.ordinal}`
  }));
};
