/*
 * The voice bridge: local transcription reaching a page that is not local.
 *
 * The microphone worth using is on the desk, plugged into the machine, and the
 * transcriber worth using runs on that machine too. The page, meanwhile, is on
 * a headset. Nothing in a browser can cross that gap on its own, so this does:
 * the page says when to listen, the machine listens and transcribes however it
 * likes, and the text comes back.
 *
 * It is deliberately tool-agnostic. The bridge never runs a transcriber itself;
 * it runs whatever shell command it is configured with and accepts text on an
 * HTTP endpoint. Willow today, Whisper tomorrow, and section 11 of the
 * architecture brief is satisfied without the command registry learning that
 * any of them exist.
 *
 *   headset  --ws-->  bridge  --shell-->  dictation tool
 *   headset  <--ws--  bridge  <--POST--   dictation tool
 *
 * Configure with:
 *   SCC_DICTATE_START   shell run when push-to-talk goes down
 *   SCC_DICTATE_STOP    shell run when it comes back up
 */

import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const MAX_TEXT = 2000;

/*
 * This endpoint executes workspace commands, so it is an authority boundary and
 * has to behave like one. Two attacks are specific to a local service:
 *
 *   CSRF — any page in any tab can POST to a loopback port. A form post carries
 *     no custom headers and needs no preflight, so a bare POST handler is
 *     reachable by any site the user visits. Requiring a token *in a custom
 *     header* forces a CORS preflight for cross-origin callers, which a
 *     no-cors form post cannot satisfy.
 *
 *   Cross-site WebSocket hijacking — the same-origin policy does not apply to
 *     WebSocket upgrades. Without an Origin check, any page can open this
 *     socket, drive push-to-talk, and read every transcript. Origin is set by
 *     the browser and cannot be forged from page script, so checking it is the
 *     defence.
 */
const originAllowed = (origin, allowedOrigins) => {
  /* A non-browser client (a CLI, a dictation tool) sends no Origin at all.
   * That is allowed, because it is not a browser being used against the user;
   * such callers still have to present the token. */
  if (!origin) return true;
  return allowedOrigins.includes(origin);
};

const tokenMatches = (provided, expected) => {
  if (!expected) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const runHook = (command, label) => {
  if (!command) return;
  exec(command, { timeout: 5000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[voice] ${label} hook failed: ${error.message}`);
      return;
    }
    const output = String(stdout || stderr || '').trim();
    if (output) console.log(`[voice] ${label}: ${output.slice(0, 200)}`);
  });
};

/**
 * Attach the bridge to an existing HTTP server.
 *
 * Sharing the server matters: the page then reaches the bridge on its own
 * origin, so it rides whatever tunnel or port-forward already serves the build
 * and inherits the same gate. A second port would need its own exposure, and
 * exposing more of a laptop to reach a headset in the same room is the wrong
 * trade.
 */
export const attachVoiceBridge = (httpServer, options = {}) => {
  const startHook = options.startHook ?? process.env.SCC_DICTATE_START ?? '';
  const stopHook = options.stopHook ?? process.env.SCC_DICTATE_STOP ?? '';

  /* Generated rather than optional. A bridge that runs commands must never be
   * reachable without a secret, and defaulting to "none configured means no
   * check" is how that happens by accident. */
  const token = options.token || process.env.SCC_VOICE_TOKEN
    || crypto.randomBytes(16).toString('hex');
  if (!options.token && !process.env.SCC_VOICE_TOKEN) {
    console.log(`[voice] SCC_VOICE_TOKEN not set; using ${token}`);
  }

  const allowedOrigins = options.allowedOrigins
    ?? String(process.env.SCC_VOICE_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

  const clients = new Set();

  const wss = new WebSocketServer({ noServer: true });

  const broadcast = (payload) => {
    const message = JSON.stringify(payload);
    for (const socket of clients) {
      if (socket.readyState === 1) socket.send(message);
    }
  };

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'ready', startHook: Boolean(startHook) }));

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.type !== 'ptt') return;
      const down = message.state === 'down';
      /* Announce to every client, not just the sender: the desk-side page and
       * the headset should agree about whether the microphone is live. */
      broadcast({ type: 'dictating', value: down });
      runHook(down ? startHook : stopHook, down ? 'start' : 'stop');
    });

    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  httpServer.on('upgrade', (request, socket, head) => {
    if (!request.url || !request.url.startsWith('/voice')) return;

    /* The same-origin policy does not cover WebSocket upgrades, so without this
     * any page the user visits could drive dictation and read transcripts. */
    if (!originAllowed(request.headers.origin, allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    let query;
    try {
      query = new URL(request.url, 'http://localhost').searchParams;
    } catch {
      socket.destroy();
      return;
    }
    if (!tokenMatches(query.get('token'), token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  /* The injection endpoint. Any local process that can POST can be the
   * transcriber, which is the whole point of not building one in. */
  const middleware = (request, response, next) => {
    if (!request.url || !request.url.startsWith('/voice/say')) return next();
    if (request.method !== 'POST') return next();

    /* Both checks matter. The header cannot be set by a cross-origin form post
     * without a preflight the attacker cannot pass; the Origin check stops a
     * page that has somehow obtained the token from using it. */
    if (!tokenMatches(request.headers['x-voice-token'], token)
      || !originAllowed(request.headers.origin, allowedOrigins)) {
      response.statusCode = 401;
      response.end('unauthorized');
      return undefined;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_TEXT * 4) request.destroy();
    });
    request.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        payload = { text: body };
      }
      const text = String(payload.text || '').slice(0, MAX_TEXT).trim();
      if (text) {
        broadcast({
          type: 'transcript',
          text,
          /* Interim text updates the display; final text is what may run. */
          final: payload.final !== false,
          at: Date.now()
        });
      }
      response.statusCode = text ? 204 : 400;
      response.end();
    });
    return undefined;
  };

  return { middleware, broadcast, token, clientCount: () => clients.size };
};
