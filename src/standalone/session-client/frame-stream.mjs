// session-client/frame-stream.mjs
// The GET /events frame stream of one session attachment: one live request at
// a time, a liveness deadline (keepalive silence is detected independently
// from TCP close), frame delivery, and loss reporting. Outcomes go to the
// owner: onHealthy on the first bytes, onLoss for a transient loss worth a
// reconnect, onFatal for a token/route rejection.
import http from 'node:http';
import { createSseFrameParser } from '../sse-frames.mjs';

const FATAL_STATUSES = new Set([401, 403, 404]);

export function createFrameStream({
  port,
  serverToken,
  clientToken,
  livenessMs,
  onFrame,
  log,
  onHealthy,
  onLoss,
  onFatal,
}) {
  let current = null;
  let livenessTimer = null;
  let stopped = false;

  function clearLiveness() {
    if (!livenessTimer) return;
    clearTimeout(livenessTimer);
    livenessTimer = null;
  }

  function deliver(frame) {
    try {
      onFrame(frame);
    } catch (err) {
      log(`onFrame threw: ${err?.message || err}`);
    }
  }

  function watchResponse(req, res) {
    res.setEncoding('utf8');
    let lossHandled = false;
    const lost = (reason) => {
      if (req !== current || stopped || lossHandled) return;
      lossHandled = true;
      clearLiveness();
      current = null;
      onLoss(reason);
    };
    const armLiveness = () => {
      clearLiveness();
      livenessTimer = setTimeout(() => {
        if (req !== current || stopped) return;
        lost(`sse liveness timeout after ${livenessMs}ms`);
        try {
          req.destroy(new Error('session SSE liveness timeout'));
        } catch {}
      }, livenessMs);
      livenessTimer.unref?.();
    };
    armLiveness();
    const parse = createSseFrameParser(deliver);
    res.on('data', (chunk) => {
      if (req !== current || stopped) return;
      // Any bytes, including `: ka` comments, prove transport liveness.
      onHealthy();
      armLiveness();
      parse(chunk);
    });
    res.on('end', () => lost('sse ended'));
    res.on('error', () => lost('sse error'));
    res.on('aborted', () => lost('sse aborted'));
    res.on('close', () => lost('sse closed'));
  }

  function open() {
    if (stopped || current) return;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/events?token=${encodeURIComponent(clientToken)}`,
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
          current = null;
          const reason = `bad sse status ${res.statusCode}`;
          if (FATAL_STATUSES.has(res.statusCode)) onFatal(reason);
          else onLoss(reason);
          return;
        }
        watchResponse(req, res);
      }
    );
    req.on('error', () => {
      if (req !== current || stopped) return;
      clearLiveness();
      current = null;
      onLoss('sse request error');
    });
    current = req;
    req.end();
  }

  /** Ends the stream for good: no reopen, no further callbacks. */
  function destroy() {
    stopped = true;
    clearLiveness();
    const req = current;
    current = null;
    try {
      req?.destroy?.();
    } catch {}
  }

  return { open, destroy };
}
