// The persistent GET /events SSE stream that replaces the old node-IPC
// `{type:'notify'}` messages. Owns one live request at a time plus the two
// timers that judge it: the stable timer (a bare 200 followed by an immediate
// end is not a stable stream) and the liveness deadline (the daemon writes a
// `: ka` comment every 15s; a half-open socket delivers no bytes and no FIN,
// so without it the stream stays "connected" forever). Outcomes are reported
// to the owner: onLoss for a transient loss worth a reconnect, onFatal for a
// token rejection or request error, onStable once the stream proved itself.
import http from 'node:http';
import { createSseFrameParser } from '../sse-frames.mjs';

const STREAM_LIVENESS_MS = 45_000;
const STABLE_STREAM_MS = 5_000;

export function createNotifyStream({ port, serverToken, getClientToken, onNotify, log, onLoss, onFatal, onStable }) {
  let current = null;
  let stableTimer = null;
  let livenessTimer = null;
  let stopped = false;

  function clearTimers() {
    clearTimeout(stableTimer);
    stableTimer = null;
    clearTimeout(livenessTimer);
    livenessTimer = null;
  }

  function deliver(msg) {
    if (msg?.type !== 'notify') return;
    try {
      onNotify(msg);
    } catch (e) {
      log(`onNotify threw: ${e?.message || e}`);
    }
  }

  function watchResponse(req, res, flags) {
    res.setEncoding('utf8');
    // Only reset the bounded reconnect budget after this exact stream stays live.
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (!stopped && req === current) onStable();
    }, STABLE_STREAM_MS);
    stableTimer.unref?.();
    const armLiveness = () => {
      clearTimeout(livenessTimer);
      livenessTimer = setTimeout(() => {
        if (stopped || req !== current) return;
        // A liveness expiry is a transient stream loss (reconnect), not a dead
        // endpoint: keep the destroy() it triggers off the fatal path.
        flags.livenessLost = true;
        onLoss(`sse liveness timeout after ${STREAM_LIVENESS_MS}ms`);
        try {
          req.destroy(new Error('channel SSE liveness timeout'));
        } catch {}
      }, STREAM_LIVENESS_MS);
      livenessTimer.unref?.();
    };
    armLiveness();
    const parse = createSseFrameParser(deliver);
    res.on('data', (chunk) => {
      if (req !== current || stopped) return;
      // Any byte, including a `: ka` keepalive comment, proves liveness.
      armLiveness();
      parse(chunk);
    });
    const lost = (reason) => () => {
      if (req !== current) return;
      clearTimers();
      onLoss(reason);
    };
    res.on('end', lost('sse ended'));
    res.on('error', lost('sse error'));
  }

  function open() {
    if (stopped) return;
    const flags = { livenessLost: false };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/events?token=${encodeURIComponent(getClientToken())}`,
        method: 'GET',
        headers: { Accept: 'text/event-stream', 'X-Mixdog-Daemon-Token': serverToken },
      },
      (res) => {
        if (req !== current || stopped) {
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          // A token rejection means this port now belongs to a different daemon;
          // re-read discovery now rather than re-registering against it.
          const reason = `bad sse status ${res.statusCode}`;
          if (res.statusCode === 401 || res.statusCode === 403) onFatal(reason);
          else onLoss(reason);
          return;
        }
        watchResponse(req, res, flags);
      }
    );
    // Registered before any byte moves: a socket that drops before the headers
    // arrive must not surface as an unhandled 'error'.
    req.on('error', () => {
      if (req !== current || flags.livenessLost) return;
      onFatal('sse req error');
    });
    current = req;
    req.end();
  }

  function stop() {
    stopped = true;
    clearTimers();
    try {
      current?.destroy?.();
    } catch {}
  }

  return { open, stop };
}
