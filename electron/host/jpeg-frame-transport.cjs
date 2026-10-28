'use strict';

/*
 * A BrowserFrameTransport that encodes paints as JPEG and pushes them to
 * remote clients over a socket.
 *
 * This is the transport docs/FRAME_TRANSPORT.md reserved a seam for. It
 * satisfies the same contract as IpcBitmapFrameTransport — construct it with a
 * way to reach the far side, hand it to BrowserSourceManager, and the manager
 * is unchanged.
 *
 * Why JPEG rather than the WebRTC video track the remote provider was designed
 * around: a headset needs *some* pixels before it needs *efficient* pixels.
 * Raw BGRA is 4.1 MB per 1280x800 frame, which is why it cannot leave the
 * machine. The same frame as JPEG is 40-150 KB depending on page content —
 * roughly a 30x reduction for one call to a codec Electron already ships. Over
 * an adb-reverse USB link that is a few milliseconds.
 *
 * NativeImage.toJPEG() is synchronous and runs on the main thread, so the
 * encode cost is real and is why this transport enforces its own pacing rather
 * than encoding every paint Chromium produces.
 */

const DEFAULT_QUALITY = 72;
const DEFAULT_MAX_FPS = 15;

/* A frame header travels as JSON, the pixels as bytes, in one binary message:
 *
 *   [ 4 bytes: header length, uint32 little-endian ][ header JSON ][ JPEG ]
 *
 * One message keeps a frame and its metadata atomic. Splitting them across two
 * sends would let a dropped or reordered message pair a frame with the wrong
 * dimensions, which presents as a torn or stretched screen rather than as a
 * transport error. */
const encodeFrameMessage = (header, jpeg) => {
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(headerJson.byteLength, 0);
  return Buffer.concat([prefix, headerJson, jpeg]);
};

class JpegFrameTransport {
  /*
   * `send` is injected rather than a socket being constructed here, so the
   * transport is testable without a network and so the same instance can serve
   * whichever client is currently attached.
   */
  constructor({
    send,
    quality = DEFAULT_QUALITY,
    maxFps = DEFAULT_MAX_FPS,
    logger = console,
    /* Injected for the same reason BrowserSourceManager injects it: pacing is
     * a timing decision, and a test should be able to state the timing rather
     * than race a millisecond clock. */
    now = () => Date.now()
  } = {}) {
    if (typeof send !== 'function') throw new TypeError('A send function is required.');
    this.send = send;
    this.now = now;
    this.quality = Math.min(95, Math.max(20, Math.round(quality)));
    this.logger = logger;
    this.closed = false;
    this.sequence = 0;

    /* Per-source pacing state. Chromium paints on invalidation, which for a
     * video or an animation is far more often than a headset can display. */
    this.minFrameInterval = Math.max(1, Math.round(1000 / Math.max(1, maxFps)));
    this.lastEncodedAt = new Map();
    this.perSourceInterval = new Map();

    this.stats = { published: 0, encoded: 0, skipped: 0, bytes: 0 };
  }

  /*
   * Set a per-source frame ceiling.
   *
   * BrowserSourceManager.setQuality() already expresses the attention tiers
   * from browser-quality.js as a frame rate. Routing that same number here
   * means a far or hidden screen costs proportionally less encode time, with
   * no second policy to keep in step with the first.
   */
  setSourceFrameRate(sourceId, fps) {
    if (!sourceId) return;
    const rate = Number(fps);
    if (!Number.isFinite(rate) || rate <= 0) {
      this.perSourceInterval.delete(sourceId);
      return;
    }
    this.perSourceInterval.set(sourceId, Math.max(1, Math.round(1000 / rate)));
  }

  intervalFor(sourceId) {
    return this.perSourceInterval.get(sourceId) ?? this.minFrameInterval;
  }

  /* BrowserFrameTransport contract. */
  publish(frame) {
    if (this.closed || !frame || !frame.sourceId || !frame.image) return false;
    this.stats.published += 1;

    const now = this.now();
    /* -Infinity, not 0: "never encoded" must always clear the interval test,
     * and 0 is a real reading from an injected clock. */
    const last = this.lastEncodedAt.get(frame.sourceId) ?? -Infinity;
    if (now - last < this.intervalFor(frame.sourceId)) {
      /* Dropping is correct rather than queueing: the next paint supersedes
       * this one, and a queue would trade latency for frames nobody sees. */
      this.stats.skipped += 1;
      return false;
    }
    this.lastEncodedAt.set(frame.sourceId, now);

    let jpeg;
    try {
      jpeg = frame.image.toJPEG(this.quality);
    } catch (error) {
      this.logger.warn?.(`Could not encode frame for ${frame.sourceId}: ${error.message}`);
      return false;
    }
    if (!jpeg || jpeg.byteLength === 0) return false;

    const frameId = ++this.sequence;
    const header = {
      sourceId: frame.sourceId,
      frameId,
      width: frame.width,
      height: frame.height,
      logicalWidth: frame.logicalWidth,
      logicalHeight: frame.logicalHeight,
      deviceScaleFactor: frame.deviceScaleFactor,
      /* The decoded result is an ImageBitmap, not raw channels, so unlike the
       * IPC path there is no channel order or premultiplication for the client
       * to undo. Declaring it keeps the client from guessing. */
      encoding: 'jpeg',
      colorSpace: 'srgb',
      capturedAt: now
    };

    try {
      this.send(encodeFrameMessage(header, jpeg));
      this.stats.encoded += 1;
      this.stats.bytes += jpeg.byteLength;
      return true;
    } catch (error) {
      this.logger.warn?.(`Could not send frame for ${frame.sourceId}: ${error.message}`);
      return false;
    }
  }

  /*
   * The IPC transport gates on an acknowledgement from the renderer. This one
   * gates on time instead, because a socket client that stops acknowledging is
   * indistinguishable from one that has gone away, and a stalled screen is a
   * worse failure than a dropped frame. Accepted for interface compatibility.
   */
  acknowledge() {
    return true;
  }

  /*
   * Admit the next paint immediately, ignoring the pacing interval.
   *
   * The manager pairs this with Chromium's invalidate() when a paused source
   * resumes. Re-encoding a stored frame is the wrong answer here: the stored
   * frame is by definition the one from before the pause, and the invalidate
   * is about to produce a current one.
   */
  requestLatest(sourceId = null) {
    if (sourceId === null) this.lastEncodedAt.clear();
    else this.lastEncodedAt.delete(sourceId);
    return true;
  }

  releaseSource(sourceId) {
    this.lastEncodedAt.delete(sourceId);
    this.perSourceInterval.delete(sourceId);
  }

  close() {
    this.closed = true;
    this.lastEncodedAt.clear();
    this.perSourceInterval.clear();
  }
}

module.exports = { JpegFrameTransport, encodeFrameMessage, DEFAULT_QUALITY, DEFAULT_MAX_FPS };
