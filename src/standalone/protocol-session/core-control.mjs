// Client of the core's management path (lifecycle spec §6): `POST /mgmt/stop` on the control listener, authorized
// by the discovery token. The headless CLI uses it to stop the core it started under its own runtime root.
import http from 'node:http';
import { join } from 'node:path';
import { sleep as delay } from '../../runtime/shared/sleep.mjs';
import { isPidAlive } from '../../runtime/shared/pid-liveness.mjs';
import { CoreDiscoveryError, DISCOVERY_FILE, controlEndpoint, readCoreDiscovery } from '../../tui/protocol-session/discovery.mjs';

const REQUEST_TIMEOUT_MS = 3_000;
const POLL_MS = 50;

function postJson({ port, token }, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        agent: false,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 400) {
            reject(Object.assign(new Error(data || `HTTP ${response.statusCode}`), { statusCode: response.statusCode }));
          } else {
            resolve(data ? JSON.parse(data) : {});
          }
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error(`core control timeout: POST ${path}`)));
    request.on('error', reject);
    request.end(payload);
  });
}

/**
 * Asks the core under `root` to stop once it is idle (`stop{whenIdle}`: nothing is aborted) and, with
 * `waitForExit`, waits for its process to end. False when no core publishes discovery there.
 */
export async function stopCoreForRuntimeRoot(
  root,
  { waitForExit = false, timeoutMs = 15_000, reason = 'quit', pidAlive = isPidAlive } = {}
) {
  const runtimeRoot = String(root || '').trim();
  if (!runtimeRoot) return false;
  let discovery;
  try {
    discovery = await readCoreDiscovery(join(runtimeRoot, DISCOVERY_FILE));
  } catch (error) {
    if (error instanceof CoreDiscoveryError && error.code === 'absent') return false;
    throw error;
  }
  try {
    await postJson(controlEndpoint(discovery), '/mgmt/stop', { mode: 'whenIdle', reason });
  } catch {
    // Past its front door already (the process is exiting): only the exit wait remains.
    return !pidAlive(discovery.pid);
  }
  if (!waitForExit) return true;
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 15_000);
  while (pidAlive(discovery.pid) && Date.now() < deadline) await delay(POLL_MS);
  if (pidAlive(discovery.pid)) throw new Error(`core pid=${discovery.pid} did not exit within ${timeoutMs}ms`);
  return true;
}
