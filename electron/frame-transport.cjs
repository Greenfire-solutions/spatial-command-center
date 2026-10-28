'use strict';

const { IPC_CHANNELS } = require('./constants.cjs');

/**
 * BrowserFrameTransport isolates Electron's CPU bitmap delivery from browser
 * source lifecycle. A future shared-texture implementation can implement this
 * interface without changing BrowserSourceManager or the spatial workspace.
 */
class BrowserFrameTransport {
  publish() {
    throw new Error('BrowserFrameTransport.publish() must be implemented.');
  }

  acknowledge() {}
  requestLatest() {}
  releaseSource() {}
  close() {}
}

class IpcBitmapFrameTransport extends BrowserFrameTransport {
  constructor({ getTargetWebContents, logger = console } = {}) {
    super();
    this.getTargetWebContents = getTargetWebContents || (() => null);
    this.logger = logger;
    this.inFlight = new Map();
    this.pending = new Map();
    this.latest = new Map();
    this.sequence = 0;
    this.closed = false;
  }

  publish(frame) {
    if (this.closed || !frame || !frame.sourceId || !frame.image) return false;
    this.latest.set(frame.sourceId, frame);
    if (this.inFlight.has(frame.sourceId)) {
      // One pending slot is intentional: newer paints replace stale paints.
      this.pending.set(frame.sourceId, frame);
      return false;
    }
    return this.send(frame);
  }

  send(frame) {
    const target = this.getTargetWebContents();
    if (!target || target.isDestroyed()) return false;

    const nativeBitmap = frame.image.toBitmap({ scaleFactor: 1 });
    const exactBuffer = nativeBitmap.buffer.slice(
      nativeBitmap.byteOffset,
      nativeBitmap.byteOffset + nativeBitmap.byteLength
    );
    const frameId = ++this.sequence;
    const payload = {
      sourceId: frame.sourceId,
      frameId,
      width: frame.width,
      height: frame.height,
      logicalWidth: frame.logicalWidth,
      logicalHeight: frame.logicalHeight,
      deviceScaleFactor: frame.deviceScaleFactor,
      dirtyRect: frame.dirtyRect,
      // NativeImage.toBitmap() is platform-dependent in Electron's public API.
      // Chromium OSR currently yields premultiplied BGRA on the pinned desktop
      // targets; the POC fixture makes channel-order regressions visible.
      pixelFormat: 'BGRA',
      premultipliedAlpha: true,
      colorSpace: 'srgb',
      nativePlatform: process.platform,
      stride: frame.width * 4,
      buffer: exactBuffer,
      capturedAt: Date.now()
    };

    try {
      target.send(IPC_CHANNELS.FRAME, payload);
      this.inFlight.set(frame.sourceId, frameId);
      return true;
    } catch (error) {
      this.logger.warn?.(`Could not send browser frame for ${frame.sourceId}: ${error.message}`);
      return false;
    }
  }

  acknowledge(sourceId, frameId) {
    if (this.inFlight.get(sourceId) !== frameId) return false;
    this.inFlight.delete(sourceId);
    const next = this.pending.get(sourceId);
    if (next) {
      this.pending.delete(sourceId);
      this.send(next);
    }
    return true;
  }

  requestLatest(sourceId = null) {
    if (sourceId) {
      const frame = this.latest.get(sourceId);
      if (frame) this.publish(frame);
      return;
    }
    for (const frame of this.latest.values()) this.publish(frame);
  }

  releaseSource(sourceId) {
    this.inFlight.delete(sourceId);
    this.pending.delete(sourceId);
    this.latest.delete(sourceId);
  }

  close() {
    this.closed = true;
    this.inFlight.clear();
    this.pending.clear();
    this.latest.clear();
  }
}

module.exports = { BrowserFrameTransport, IpcBitmapFrameTransport };
