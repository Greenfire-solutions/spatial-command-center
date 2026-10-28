'use strict';

const IPC_CHANNELS = Object.freeze({
  RUNTIME_INFO: 'spatial-browser:runtime-info',
  OPEN_EXTERNAL: 'spatial-browser:open-external',
  SOURCE_CREATE: 'spatial-browser:source-create',
  SOURCE_DESTROY: 'spatial-browser:source-destroy',
  SOURCE_GET: 'spatial-browser:source-get',
  SOURCE_LIST: 'spatial-browser:source-list',
  NAVIGATE: 'spatial-browser:navigate',
  BACK: 'spatial-browser:back',
  FORWARD: 'spatial-browser:forward',
  RELOAD: 'spatial-browser:reload',
  STOP: 'spatial-browser:stop',
  RESIZE: 'spatial-browser:resize',
  QUALITY: 'spatial-browser:quality',
  FOCUS: 'spatial-browser:focus',
  BLUR: 'spatial-browser:blur',
  POINTER: 'spatial-browser:pointer',
  WHEEL: 'spatial-browser:wheel',
  KEYBOARD: 'spatial-browser:keyboard',
  INSERT_TEXT: 'spatial-browser:insert-text',
  EXTRACT: 'spatial-browser:extract',
  AGENT_LIST: 'spatial-browser:agent-list',
  AGENT_RUN: 'spatial-browser:agent-run',
  FRAME: 'spatial-browser:frame',
  FRAME_ACK: 'spatial-browser:frame-ack',
  FRAME_REQUEST: 'spatial-browser:frame-request',
  METADATA: 'spatial-browser:metadata',
  EVENT: 'spatial-browser:event'
});

const DEFAULT_SOURCE_SIZE = Object.freeze({ width: 1280, height: 800 });
const DEFAULT_SOURCE_URL = 'https://example.com/';
const DEFAULT_FRAME_RATE = 30;
const PERSISTENT_PARTITION = 'persist:spatial-command-center';

module.exports = {
  DEFAULT_FRAME_RATE,
  DEFAULT_SOURCE_SIZE,
  DEFAULT_SOURCE_URL,
  IPC_CHANNELS,
  PERSISTENT_PARTITION
};
