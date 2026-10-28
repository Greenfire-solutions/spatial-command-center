'use strict';

class BrowserSourceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BrowserSourceError';
    this.code = code || 'BROWSER_SOURCE_ERROR';
    this.details = details;
  }
}

const serializeError = (error) => ({
  code: error && error.code ? String(error.code) : 'BROWSER_SOURCE_ERROR',
  message: error instanceof Error ? error.message : 'The browser source operation failed.',
  details: error && error.details ? error.details : undefined
});

module.exports = { BrowserSourceError, serializeError };
