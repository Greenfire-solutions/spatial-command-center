export const BRIDGE_CHANNEL = 'spatial-command-center.chrome-tabs';
export const PROTOCOL_VERSION = 1;

export const REQUEST_ACTIONS = Object.freeze({
  LIST_TABS: 'tabs.list',
  OPEN_TAB: 'tabs.open',
  NAVIGATE_TAB: 'tabs.navigate',
  CLOSE_TAB: 'tabs.close'
});

export const TAB_EVENTS = Object.freeze({
  CREATED: 'tabs.created',
  UPDATED: 'tabs.updated',
  REMOVED: 'tabs.removed',
  REPLACED: 'tabs.replaced'
});

export function isBridgeRequest(message) {
  return Boolean(
    message &&
    typeof message === 'object' &&
    message.channel === BRIDGE_CHANNEL &&
    message.version === PROTOCOL_VERSION &&
    message.kind === 'request' &&
    typeof message.requestId === 'string' &&
    message.requestId.length > 0 &&
    message.requestId.length <= 128 &&
    typeof message.action === 'string' &&
    message.action.length > 0 &&
    message.action.length <= 64
  );
}

export function createSuccessResponse(request, data) {
  return {
    channel: BRIDGE_CHANNEL,
    version: PROTOCOL_VERSION,
    kind: 'response',
    requestId: request.requestId,
    action: request.action,
    ok: true,
    data
  };
}

export function createErrorResponse(request, code, message) {
  return {
    channel: BRIDGE_CHANNEL,
    version: PROTOCOL_VERSION,
    kind: 'response',
    requestId: typeof request?.requestId === 'string' ? request.requestId : null,
    action: typeof request?.action === 'string' ? request.action : null,
    ok: false,
    error: { code, message }
  };
}

export function createTabEvent(event, data) {
  return {
    channel: BRIDGE_CHANNEL,
    version: PROTOCOL_VERSION,
    kind: 'event',
    event,
    data
  };
}
