import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';



/*
 * Headset telemetry sink.
 *
 * A Quest has no reachable console, so the page posts what it observes here and
 * this appends it to a log the developer can tail. Development only: it is
 * mounted on the preview server exclusively, and only when serve-xr.mjs has set
 * SCC_XR_PREVIEW, so it cannot exist in the Electron application or in a plain
 * `npm run preview`.
 */
const headsetDiagnostics = (logPath) => ({
  name: 'scc-headset-diagnostics',
  apply: 'serve',
  configurePreviewServer(server) {
    server.middlewares.use('/__diag', (request, response, next) => {
      if (request.method !== 'POST') return next();
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
        // A misbehaving client must not be able to exhaust memory here.
        if (body.length > 512_000) request.destroy();
      });
      request.on('end', () => {
        try {
          const payload = JSON.parse(body);
          for (const entry of payload.entries || []) {
            appendFileSync(logPath, `${JSON.stringify({
              session: payload.sessionId,
              ua: payload.userAgent,
              ...entry
            })}\n`);
          }
        } catch (error) {
          appendFileSync(logPath, `${JSON.stringify({ kind: 'sink-error', message: error.message })}\n`);
        }
        response.statusCode = 204;
        response.end();
      });
      return undefined;
    });
  }
});

export default defineConfig({
  base: './',
  /*
   * A stamp the running page can report back.
   *
   * Without it there is no way to tell, from a headset, whether the build in
   * front of you is the one that was just made — and "it looks the same as last
   * time" is then impossible to distinguish from a stale cache. One line here
   * removes an entire class of wasted session.
   */
  define: {
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 19).replace('T', ' '))
  },
  resolve: {
    /* The XR emulator's dev UI (@iwer/devui) ships its own copy of React.
     * Two React instances in one page produce 'Invalid hook call' (error #321)
     * the moment the emulator mounts, which crashed emulation before it could
     * inject a device — so XR could not be exercised without hardware.
     * Deduping guarantees a single React for every consumer. */
    dedupe: ['react', 'react-dom', 'three']
  },
  plugins: [
    react(),
    ...(process.env.SCC_XR_PREVIEW === '1'
      ? [
          headsetDiagnostics(resolve(dirname(fileURLToPath(import.meta.url)), '.xr-diagnostics.log'))
        ]
      : [])
  ],
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    /*
     * Vite rejects requests whose Host header it does not recognize, which is
     * DNS-rebinding protection and should stay on. Reaching a headset requires
     * an HTTPS origin, and the tunnel that provides one arrives with a random
     * *.trycloudflare.com hostname.
     *
     * The allowance is therefore narrow and opt-in: only that suffix, and only
     * when scripts/serve-xr.mjs sets SCC_XR_PREVIEW. A plain `npm run preview`
     * keeps the default protection, and no configuration turns it off wholesale.
     */
    allowedHosts: process.env.SCC_XR_PREVIEW === '1'
      /*
       * Quick tunnels publish a random hostname, so their suffixes are allowed
       * wholesale. A named tunnel on a domain you own is not guessable from
       * here, so it is supplied by whoever runs the server:
       *   SCC_XR_ALLOWED_HOSTS=xr.example.com,vr.example.com npm run xr
       */
      ? [
          '.trycloudflare.com',
          '.ngrok-free.app',
          '.ngrok.app',
          '.ngrok.io',
          ...String(process.env.SCC_XR_ALLOWED_HOSTS || '')
            .split(',')
            .map((host) => host.trim())
            .filter(Boolean)
        ]
      : []
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    /* three.js and React make one large bundle by nature. It loads from disk
     * inside Electron, so the size warning is noise in a buyer's first-start
     * log rather than a problem to act on. */
    chunkSizeWarningLimit: 4000,
    /*
     * Two documents are built.
     *
     * index.html is the Electron renderer and receives the trusted preload.
     * xr.html is the headset build, reached over the network from a Quest, and
     * must never receive it. scripts/dev.mjs already refuses any non-loopback
     * host for exactly that reason; keeping the two as separate entries makes
     * the boundary structural rather than a runtime check.
     */
    rollupOptions: {
      input: {
        index: resolve(dirname(fileURLToPath(import.meta.url)), 'index.html'),
        xr: resolve(dirname(fileURLToPath(import.meta.url)), 'xr.html')
      }
    }
  }
});
