import * as http from 'node:http';
import { logWebhook } from './log.mjs';
import { resolveHookRelayUrl, startHookTunnel } from './relay-tunnel.mjs';

const WEBHOOK_BIND_HOST = '127.0.0.1';

function createWebhookListener({ getConfig, setConfig, handleRequest }) {
  let server = null;
  let boundPort = 0;
  let listenInFlight = false;
  let hookTunnel = null;

  function start() {
    if (server || listenInFlight) return;
    server = http.createServer(handleRequest);
    listenWithRetry();
  }

  function listenWithRetry() {
    if (!server || listenInFlight) return;
    listenInFlight = true;
    const config = getConfig();
    const basePort = config.port || 3333;
    const maxPort = basePort + 7;
    let currentPort = basePort;
    const tryListen = () => {
      server.listen(currentPort, WEBHOOK_BIND_HOST, () => {
        listenInFlight = false;
        boundPort = currentPort;
        logWebhook(`listening on ${WEBHOOK_BIND_HOST}:${currentPort}`);
        startRelayTunnel();
      });
    };
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && currentPort < maxPort) {
        // The relay tunnel forwards to whatever port this process binds, so
        // port identity no longer matters (the ngrok-era domain↔port coupling
        // is gone) — walk up the range.
        logWebhook(`port ${currentPort} already in use, trying ${currentPort + 1}`);
        currentPort++;
        tryListen();
      } else if (err.code === 'EADDRINUSE') {
        logWebhook(`all ports ${basePort}-${maxPort} in use — webhook server disabled`);
        listenInFlight = false;
        server = null;
      } else {
        // Non-EADDRINUSE listen error: null the server so a later start()
        // can retry instead of holding a dead server reference.
        logWebhook(`listen error: ${err?.code || ''} ${err?.message || err}`);
        listenInFlight = false;
        server = null;
      }
    });
    tryListen();
  }

  function startRelayTunnel() {
    if (hookTunnel) return;
    const relayUrl = resolveHookRelayUrl();
    if (!relayUrl) {
      logWebhook('hook tunnel disabled (MIXDOG_RELAY_URL=off)');
      return;
    }
    try {
      hookTunnel = startHookTunnel({ relayUrl, getLocalPort: () => boundPort });
      logWebhook(`public hook base: ${hookTunnel.publicBase}`);
    } catch (err) {
      logWebhook(`hook tunnel start failed: ${err?.message || err}`);
    }
  }

  function stop() {
    if (hookTunnel) {
      try {
        hookTunnel.close();
      } catch {
        /* already closed */
      }
      hookTunnel = null;
    }
    let closed = Promise.resolve();
    if (server) {
      const srv = server;
      server = null;
      listenInFlight = false;
      closed = new Promise((resolve) => {
        try {
          srv.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    logWebhook('stopped');
    return closed;
  }

  async function reloadConfig(config, options = {}) {
    // Await server.close() before re-listen: server.close() is async and
    // releases the bound port only after the close callback fires. Calling
    // start() before that drains races the port and surfaces EADDRINUSE
    // through listenWithRetry's port-bump path even when no other process
    // holds the port.
    await stop();
    setConfig(config);
    if (options.autoStart !== false && config.enabled) start();
  }

  function getUrl(name) {
    if (hookTunnel) {
      return `${hookTunnel.publicBase}/webhook/${name}`;
    }
    return `http://localhost:${boundPort || getConfig().port}/webhook/${name}`;
  }

  return { start, stop, reloadConfig, getUrl };
}

export { WEBHOOK_BIND_HOST, createWebhookListener };
