/*
 * The control protocol between a headset and a desktop browser host.
 *
 * Video travels a WebRTC media track. Everything else — lifecycle, navigation,
 * input, metadata, events — travels this protocol over a DataChannel.
 *
 * Two properties matter:
 *
 *   It mirrors BrowserSourceProvider. Actions are named after provider
 *   methods, so there is no translation layer to get out of step, and reading
 *   one tells you what the other does.
 *
 *   It is validated on both ends. The host must never trust the client, for
 *   exactly the reasons the local Electron IPC validates everything: a browser
 *   host that accepts unvalidated URLs and input from the network is a far
 *   worse liability than one embedded in a desktop app.
 */

export const PROTOCOL_CHANNEL = 'spatial-command-center.browser-control';
export const PROTOCOL_VERSION = 1;

export const REQUEST_ACTIONS = Object.freeze([
  'createSource',
  'destroySource',
  'getSource',
  'listSources',
  'navigate',
  'back',
  'forward',
  'reload',
  'stop',
  'resize',
  'setQuality',
  'focus',
  'blur',
  'sendPointerEvent',
  'sendWheelEvent',
  'sendKeyboardEvent',
  'insertText',
  'extract'
]);

/* Actions the host pushes without being asked. */
export const NOTIFICATION_TYPES = Object.freeze(['metadata', 'event', 'track']);

const MAX_PAYLOAD_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

let requestCounter = 0;

export const nextRequestId = () => {
  requestCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `r${requestCounter.toString(36)}-${random}`;
};

export const createRequest = (action, sourceId, payload = {}) => ({
  channel: PROTOCOL_CHANNEL,
  version: PROTOCOL_VERSION,
  kind: 'request',
  requestId: nextRequestId(),
  action,
  sourceId: sourceId ?? null,
  payload
});

export const createResponse = (request, result) => ({
  channel: PROTOCOL_CHANNEL,
  version: PROTOCOL_VERSION,
  kind: 'response',
  requestId: request.requestId,
  action: request.action,
  ok: true,
  result
});

export const createErrorResponse = (request, code, message) => ({
  channel: PROTOCOL_CHANNEL,
  version: PROTOCOL_VERSION,
  kind: 'response',
  requestId: request?.requestId ?? null,
  action: request?.action ?? null,
  ok: false,
  error: { code: code || 'REMOTE_BROWSER_ERROR', message: String(message || 'The operation failed.') }
});

export const createNotification = (type, sourceId, data) => ({
  channel: PROTOCOL_CHANNEL,
  version: PROTOCOL_VERSION,
  kind: 'notification',
  type,
  sourceId: sourceId ?? null,
  data
});

const isPlainObject = (value) => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/*
 * Validate an inbound request on the host.
 *
 * Returns { ok, request } or { ok: false, code, message }. Deliberately
 * returns rather than throws, so a hostile peer cannot break the message loop
 * by sending something unparseable.
 */
export const validateRequest = (message) => {
  if (!isPlainObject(message)) return { ok: false, code: 'INVALID_MESSAGE', message: 'Message must be an object.' };
  if (message.channel !== PROTOCOL_CHANNEL) return { ok: false, code: 'INVALID_CHANNEL', message: 'Unknown channel.' };
  if (message.version !== PROTOCOL_VERSION) {
    return { ok: false, code: 'UNSUPPORTED_VERSION', message: `Protocol v${message.version} is not supported.` };
  }
  if (message.kind !== 'request') return { ok: false, code: 'INVALID_KIND', message: 'Expected a request.' };
  if (typeof message.requestId !== 'string' || !REQUEST_ID_PATTERN.test(message.requestId)) {
    return { ok: false, code: 'INVALID_REQUEST_ID', message: 'requestId is malformed.' };
  }
  if (!REQUEST_ACTIONS.includes(message.action)) {
    return { ok: false, code: 'UNSUPPORTED_ACTION', message: `Unsupported action: ${message.action}` };
  }
  if (message.sourceId !== null && message.sourceId !== undefined) {
    if (typeof message.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(message.sourceId)) {
      return { ok: false, code: 'INVALID_SOURCE_ID', message: 'sourceId is malformed.' };
    }
  }
  if (message.payload !== undefined && !isPlainObject(message.payload)) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'payload must be an object.' };
  }

  // A control message is small by construction. Anything large is either a
  // mistake or an attempt to use the channel as a data pipe.
  const encoded = JSON.stringify(message);
  if (encoded.length > MAX_PAYLOAD_BYTES) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'Control messages must stay small.' };
  }

  return { ok: true, request: { ...message, payload: message.payload || {} } };
};

/* Validate an inbound response or notification on the client. */
export const validateInbound = (message) => {
  if (!isPlainObject(message)) return { ok: false, reason: 'not-an-object' };
  if (message.channel !== PROTOCOL_CHANNEL) return { ok: false, reason: 'wrong-channel' };
  if (message.version !== PROTOCOL_VERSION) return { ok: false, reason: 'wrong-version' };
  if (message.kind === 'response') {
    if (typeof message.requestId !== 'string') return { ok: false, reason: 'missing-request-id' };
    return { ok: true, message };
  }
  if (message.kind === 'notification') {
    if (!NOTIFICATION_TYPES.includes(message.type)) return { ok: false, reason: 'unknown-notification' };
    return { ok: true, message };
  }
  return { ok: false, reason: 'unknown-kind' };
};

export const encode = (message) => JSON.stringify(message);

export const decode = (raw) => {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
  } catch {
    return null;
  }
};
