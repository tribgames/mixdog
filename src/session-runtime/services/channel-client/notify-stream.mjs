// The persistent GET /events SSE stream that replaces the old node-IPC
// `{type:'notify'}` messages. Owns one live request at a time plus the stable
// timer that judges it (a bare 200 followed by an immediate end is not a
// stable stream). The stream is loopback-only, so a dead daemon surfaces as a
// socket end/error; there is no silence timer. Outcomes are reported to the
// owner: onLoss for a transient loss worth a reconnect, onFatal for a token
// rejection or request error, onStable once the stream proved itself.
import http from 'node:http';
import { createSseFrameParser } from '../sse-frames.mjs';

const STABLE_STREAM_MS = 5_000;

export function createNotifyStream({ port, serverToken, getClientToken, onNotify, log, onLoss, onFatal, onStable }) {
  let current = null;
  let stableTimer = null;
  let stopped = false;

  function clearTimers() {
    clearTimeout(stableTimer);
    stableTimer = null;
  }

  function deliver(msg) {
    if (msg?.type !== 'notify') return;
    try {
      onNotify(msg);
    } catch (e) {
      log(`onNotify threw: ${e?.message || e}`);
    }
  }

  function watchResponse(req, res) {
    res.setEncoding('utf8');
    // Only reset the bounded reconnect budget after this exact stream stays live.
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (!stopped && req === current) onStable();
    }, STABLE_STREAM_MS);
    stableTimer.unref?.();
    const parse = createSseFrameParser(deliver);
    res.on('data', (chunk) => {
      if (req !== current || stopped) return;
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
        watchResponse(req, res);
      }
    );
    // Registered before any byte moves: a socket that drops before the headers
    // arrive must not surface as an unhandled 'error'.
    req.on('error', () => {
      if (req !== current) return;
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
