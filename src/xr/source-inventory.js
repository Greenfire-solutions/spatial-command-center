/*
 * What every screen is actually receiving.
 *
 * This exists because of a specific hour that should not have happened. A
 * capture host was accepting connections, answering the protocol, and logging
 * "workspace connected" while producing zero frames. Meanwhile a completely
 * different application was putting a desktop in the headset. The person wearing
 * it said "I can see my desktop", the developer said "no frames are being sent",
 * and both were correct.
 *
 * Every fact needed to catch that in seconds already existed: the runtime tracks
 * frameCount, lastFrameAt and status per source. It was simply never shown to
 * anybody. So this collects it, once a second, for the panel in the headset and
 * for the terminal at the same time.
 *
 * The rule it encodes: a connection is not a stream. Only a rising frame count
 * proves a surface is live.
 */

import { getChromiumSourceRuntime } from '../chromium-texture-source.js';
import { resolveBrowserProvider } from '../providers/index.js';
import { useStore } from '../store/workspace-store.js';

/*
 * Frame timestamps come from recordRuntimeFrame, which stamps performance.now()
 * — milliseconds since page load, not since 1970. Subtracting them from
 * Date.now() yields the age of the unix epoch, which is how this reported every
 * live source as 56 years stale while frames were arriving normally.
 *
 * Read the clock the writer used.
 */
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const age = (timestamp) => (timestamp ? Math.round((now() - timestamp) / 100) / 10 : null);

/**
 * A snapshot of every screen and what it is being fed.
 *
 * Deliberately flat and small: it is sent over the wire once a second and read
 * on a panel at arm's length, so it has to survive both.
 */
export const collectSourceInventory = () => {
  const store = useStore.getState();
  const provider = resolveBrowserProvider();

  const sources = store.screens.map((screen) => {
    const sourceId = screen.source && screen.source.sourceId;
    const runtime = sourceId ? getChromiumSourceRuntime(sourceId) : null;
    return {
      id: screen.id,
      name: screen.name || screen.title || screen.id,
      type: (screen.source && screen.source.type) || 'none',
      status: runtime ? runtime.status || runtime.state || 'unknown' : 'no-runtime',
      frames: runtime ? runtime.frameCount : 0,
      /* Seconds since the last paint. This is the number that separates "live"
       * from "a still image of something that was live". */
      lastFrameAgo: runtime ? age(runtime.lastFrameAt) : null,
      texture: runtime && runtime.textureWidth
        ? `${runtime.textureWidth}x${runtime.textureHeight}`
        : null,
      url: screen.url || null
    };
  });

  return {
    provider: provider ? provider.id : 'none',
    providerAvailable: Boolean(provider && provider.available),
    providerError: (provider && provider.lastError) || null,
    screens: sources.length,
    /* A live source is one that has painted recently. Counting them is the
     * single number worth putting in front of someone in a headset. */
    live: sources.filter((entry) => entry.lastFrameAgo !== null && entry.lastFrameAgo < 3).length,
    sources
  };
};

/** One line per source, for a panel or a terminal. */
export const formatInventory = (inventory) => inventory.sources.map((entry) => {
  const age_ = entry.lastFrameAgo === null ? 'never' : `${entry.lastFrameAgo}s`;
  return `${entry.name.slice(0, 18).padEnd(18)} ${entry.type.padEnd(9)} ${String(entry.frames).padStart(6)}f  ${age_.padStart(6)}  ${entry.texture || '-'}`;
});
