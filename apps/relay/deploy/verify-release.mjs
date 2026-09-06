// Non-mutating deployment probes. No synthetic device is registered and no
// real pairing credential is read: the WebSocket check exercises the public
// upgrade route and requires its authentication/origin gates to remain shut.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

function transportOptions(address) {
  if (!address) return {};
  return {
    lookup: (_host, options, callback) => {
      if (options?.all) callback(null, [{ address, family: 4 }]);
      else callback(null, address, 4);
    },
  };
}

function readJson(url, { address, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      ...transportOptions(address),
      headers: { Accept: 'application/json' },
    }, (response) => {
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          request.destroy(new Error('Deployment probe response exceeds limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`${url.pathname} returned HTTP ${response.statusCode}.`));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {
          reject(new Error(`${url.pathname} returned invalid JSON.`));
        }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Deployment HTTP probe timed out.')), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
}

function checkWebSocket(origin, { address, timeoutMs, foreignOrigin = false }) {
  return new Promise((resolve, reject) => {
    const url = new URL('/ws', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, {
      ...transportOptions(address),
      origin: foreignOrigin ? 'https://deployment-probe.invalid' : origin.origin,
      handshakeTimeout: timeoutMs,
    });
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Deployment WebSocket probe timed out.')), timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      if (error) reject(error); else resolve();
    };
    ws.on('error', (error) => finish(error));
    ws.on('unexpected-response', (_request, response) => {
      const status = response.statusCode;
      response.resume();
      finish(foreignOrigin && status === 403
        ? null : new Error(`WebSocket upgrade returned HTTP ${status}.`));
    });
    ws.on('open', () => {
      if (foreignOrigin) finish(new Error('WebSocket accepted a foreign origin.'));
    });
    ws.on('close', (code) => finish(!foreignOrigin && code === 4005
      ? null : new Error(`WebSocket pairing gate returned close ${code}.`)));
  });
}

export async function verifyRelease({
  origin,
  expectedIndex,
  address,
  timeoutMs = 5000,
  startupMs = 15000,
}) {
  const base = new URL(origin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Deployment probe requires an HTTP(S) origin without credentials.');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedIndex || '')) throw new Error('Expected renderer digest is required.');
  if (address && address !== '127.0.0.1') throw new Error('Only loopback may override deployment DNS.');
  const options = { address, timeoutMs };
  const deadline = Date.now() + startupMs;
  let health;
  for (;;) {
    try {
      health = await readJson(new URL('/healthz', base), options);
      break;
    } catch (error) {
      // Only an unbound listener is a startup race. TLS, HTTP and content
      // failures are real failures and must reach rollback immediately.
      if (error?.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error;
      await delay(Math.min(250, Math.max(0, deadline - Date.now())));
    }
  }
  if (health?.status !== 'ok') throw new Error('Relay liveness check failed.');
  const ready = await readJson(new URL('/readyz', base), options);
  if (ready?.status !== 'ready' || ready.indexSha256 !== expectedIndex
    || !/^[a-f0-9]{64}$/.test(ready.version || '') || !(ready.assets > 0)) {
    throw new Error('Renderer readiness or deployed release identity does not match.');
  }
  await checkWebSocket(base, options);
  await checkWebSocket(base, { ...options, foreignOrigin: true });
  return { status: 'verified', indexSha256: ready.indexSha256, assets: ready.assets, websocket: 'gated' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Invalid verification argument: ${arg}`);
    return [match[1], match[2]];
  }));
  try {
    console.log(JSON.stringify(await verifyRelease({
      origin: args.origin, expectedIndex: args['expected-index'], address: args.address,
    })));
  } catch (error) {
    console.error(`[deploy] verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
