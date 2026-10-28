import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserVideoTextureSurface,
  SURFACE_KINDS,
  createSurfaceForFormat,
  surfaceKindForFormat
} from './video-texture-surface.js';
import { FRAME_FORMATS } from './providers/frame-formats.js';

/* A stand-in for an HTMLVideoElement; three only needs the shape. */
const fakeVideo = (width = 1280, height = 800) => ({
  videoWidth: width,
  videoHeight: height,
  readyState: 2,
  addEventListener() {},
  removeEventListener() {}
});

const videoFrame = (element, overrides = {}) => ({
  sourceId: 'browser-a',
  format: FRAME_FORMATS.VIDEO_ELEMENT,
  width: element.videoWidth,
  height: element.videoHeight,
  frame: element,
  ...overrides
});

test('a video frame binds a texture the GPU samples directly', () => {
  const surface = new BrowserVideoTextureSurface();
  const element = fakeVideo();

  const result = surface.update(videoFrame(element));
  assert.equal(result.ok, true);
  assert.equal(result.width, 1280);
  assert.equal(result.height, 800);
  assert.equal(surface.material.name, 'BrowserVideoTextureMaterial');
  assert.ok(surface.videoTexture, 'a VideoTexture is bound');
  assert.equal(surface.videoTexture.image, element, 'and it samples the element itself');
  surface.dispose();
});

test('re-binding the same element does not churn GPU resources', () => {
  const surface = new BrowserVideoTextureSurface();
  const element = fakeVideo();

  surface.update(videoFrame(element));
  const first = surface.videoTexture;
  surface.update(videoFrame(element));
  assert.equal(surface.videoTexture, first, 'the same track keeps the same texture');

  surface.update(videoFrame(fakeVideo(640, 400)));
  assert.notEqual(surface.videoTexture, first, 'a new track replaces it');
  surface.dispose();
});

test('a video surface refuses bitmap frames rather than mispresenting them', () => {
  const surface = new BrowserVideoTextureSurface();
  const result = surface.update({
    format: FRAME_FORMATS.BGRA8_BITMAP,
    width: 8,
    height: 8,
    frame: new Uint8Array(8 * 8 * 4)
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot present/);
  surface.dispose();
});

test('a disposed surface reports rather than throwing', () => {
  const surface = new BrowserVideoTextureSurface();
  surface.dispose();
  assert.equal(surface.update(videoFrame(fakeVideo())).ok, false);
});

test('the surface is chosen by the declared frame format', () => {
  class BitmapSurface { constructor() { this.kind = 'bitmap'; } }

  assert.equal(createSurfaceForFormat(FRAME_FORMATS.BGRA8_BITMAP, { BitmapSurface }).kind, 'bitmap');
  assert.equal(createSurfaceForFormat(FRAME_FORMATS.RGBA8_BITMAP, { BitmapSurface }).kind, 'bitmap');
  assert.equal(createSurfaceForFormat(null, { BitmapSurface }).kind, 'bitmap', 'an unknown provider defaults to the local path');

  assert.ok(
    createSurfaceForFormat(FRAME_FORMATS.VIDEO_ELEMENT, { BitmapSurface }) instanceof BrowserVideoTextureSurface
  );
  assert.ok(
    createSurfaceForFormat(FRAME_FORMATS.VIDEO_FRAME, { BitmapSurface }) instanceof BrowserVideoTextureSurface
  );
});

test('an absent provider and a local one need the same surface kind', () => {
  assert.equal(surfaceKindForFormat(null), SURFACE_KINDS.BITMAP);
  assert.equal(surfaceKindForFormat(undefined), SURFACE_KINDS.BITMAP);
  assert.equal(surfaceKindForFormat(FRAME_FORMATS.BGRA8_BITMAP), SURFACE_KINDS.BITMAP);
  assert.equal(
    surfaceKindForFormat(null),
    surfaceKindForFormat(FRAME_FORMATS.BGRA8_BITMAP),
    'a provider resolving from unavailable to Electron must not rebuild a live texture'
  );
  assert.equal(surfaceKindForFormat(FRAME_FORMATS.VIDEO_ELEMENT), SURFACE_KINDS.VIDEO);
});
