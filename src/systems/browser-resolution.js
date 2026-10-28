/*
 * How many physical pixels a browser surface is allowed to render.
 *
 * deviceScaleFactor was previously a hard-coded 1, which is why browser text
 * looks soft on a HiDPI display: the page renders at 1280x800 and is then
 * magnified onto a plane that may occupy far more physical pixels.
 *
 * The reason it was 1 is not an oversight, it is the transport. Every frame
 * currently crosses IPC as an uncompressed bitmap:
 *
 *   1280 x  800 @ 1x  =   4.1 MB per frame  (~123 MB/s at 30fps)
 *   1280 x  800 @ 2x  =  16.4 MB per frame  (~491 MB/s at 30fps)
 *
 * Quadrupling that for every screen is not affordable on the bitmap path, and
 * it is actively wrong on a future network path. So rather than a magic
 * literal, the scale factor is derived from an explicit per-frame byte budget:
 * a surface renders as sharply as it can while staying inside the budget.
 *
 * A small surface therefore gets a genuinely higher scale factor today, and
 * when a shared-texture or video transport lands the budget rises in one place
 * and every screen sharpens. See docs/FRAME_TRANSPORT.md.
 */

const BYTES_PER_PIXEL = 4;

/* Chosen so a standard 1280x800 surface renders at 1x and anything materially
 * smaller can afford more. Raise this when frames stop being CPU bitmaps. */
export const DEFAULT_FRAME_BYTE_BUDGET = 1280 * 800 * BYTES_PER_PIXEL;

/* Chromium's own validation accepts 0.5 to 4; there is no visible benefit
 * beyond the display's own ratio. */
const CANDIDATE_SCALE_FACTORS = [3, 2, 1.5, 1.25, 1];

export const frameBytesFor = (logicalWidth, logicalHeight, deviceScaleFactor) => (
  Math.round(logicalWidth * deviceScaleFactor) *
  Math.round(logicalHeight * deviceScaleFactor) *
  BYTES_PER_PIXEL
);

/*
 * Pick the sharpest scale factor that fits the budget and does not exceed the
 * display's own pixel ratio. Rendering above the display ratio costs bandwidth
 * for detail the user cannot resolve.
 */
export const resolveDeviceScaleFactor = ({
  logicalWidth,
  logicalHeight,
  displayPixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
  byteBudget = DEFAULT_FRAME_BYTE_BUDGET
} = {}) => {
  const width = Math.max(1, Number(logicalWidth) || 1);
  const height = Math.max(1, Number(logicalHeight) || 1);
  const ceiling = Math.max(1, Number(displayPixelRatio) || 1);

  for (const candidate of CANDIDATE_SCALE_FACTORS) {
    if (candidate > ceiling) continue;
    if (frameBytesFor(width, height, candidate) <= byteBudget) return candidate;
  }
  return 1;
};
