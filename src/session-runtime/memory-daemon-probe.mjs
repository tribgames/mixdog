// Eager memory-daemon boot for remote sessions. The channels worker forwards
// transcript ingests to the memory HTTP service, so its port must be published
// (and actually listening) before the worker sends its first ingest — otherwise
// early channel traffic finds no port and gets buffered. Extracted from
// runtime-core's startRemote, which now just fires it.
import * as httpMod from 'node:http';

const HEALTH_ATTEMPTS = 30;
const HEALTH_RETRY_MS = 500;
const HEALTH_TIMEOUT_MS = 1500;

function healthOk(port) {
  return new Promise((resolve) => {
    const request = httpMod.request(
      { hostname: '127.0.0.1', port, path: '/health', timeout: HEALTH_TIMEOUT_MS },
      (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try { resolve(JSON.parse(body)?.status === 'ok'); } catch { resolve(false); }
        });
      },
    );
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.end();
  });
}

/** Detached, never throws: resolving the module only hands back a handle, so
 *  this awaits start() and then polls /health until the daemon is provably
 *  reachable (or the failure is profiled). */
export function startMemoryDaemonEagerly({ getMemoryModule, bootProfile }) {
  void (async () => {
    try {
      // Yield one tick first: the module resolve + daemon fork below is a long
      // synchronous chain that would otherwise starve Ink's queued render and
      // keypress handling.
      await new Promise((resolve) => setImmediate(resolve));
      const module = await getMemoryModule();
      const started = typeof module?.start === 'function' ? await module.start() : null;
      const port = started?.port;
      if (!port) {
        bootProfile('channels:memory-eager-init-failed', { error: 'no port from start()' });
        return;
      }
      for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
        try {
          if (await healthOk(port)) {
            bootProfile('channels:memory-eager-init-ready', { port });
            return;
          }
        } catch { /* probe failure is retried below */ }
        await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS));
      }
      bootProfile('channels:memory-eager-init-failed', { error: `health not ok after retries (port ${port})` });
    } catch (error) {
      bootProfile('channels:memory-eager-init-failed', { error: error?.message || String(error) });
    }
  })();
}
