import { ROTATION_ORDER } from '../constants.js';

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const makeId = (prefix) => {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return prefix + '-' + globalThis.crypto.randomUUID();
  }
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
};

export const normalizeVec3 = (value, fallback) => {
  if (!Array.isArray(value) || value.length < 3) return fallback.slice();
  const next = value.slice(0, 3).map(Number);
  return next.every(Number.isFinite) ? next : fallback.slice();
};

export const normalizeRotation = (value) => {
  const rotation = normalizeVec3(value, [0, 0, 0]);
  rotation.push(Array.isArray(value) && typeof value[3] === 'string' ? value[3] : ROTATION_ORDER);
  return rotation;
};
