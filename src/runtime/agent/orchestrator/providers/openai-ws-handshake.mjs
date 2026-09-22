/**
 * openai-ws-handshake.mjs — what happens to a Responses WebSocket between
 * `new WebSocket()` and a settled connect promise: the 101-upgrade capture
 * (CF cookie jar + the optional header probe) and the three ways a handshake
 * can fail (socket error, close before open, non-101 HTTP response).
 *
 * The pool owns the promise; these handlers only report through `settle`.
 */
import { appendFileSync, chmodSync } from 'node:fs';
import { errText } from '../../../shared/err-text.mjs';
import { _cfCookieCapture, _formatRedactedHeaders } from './openai-ws-headers.mjs';

/** CF cookie jar refresh plus the opt-in upgrade-header dump. */
export function captureHandshakeUpgrade(auth, res) {
  try {
    _cfCookieCapture(auth, res?.headers?.['set-cookie']);
    // Probe: dump the full 101-upgrade response header set so we can
    // see what the server actually issues (turn-state investigation).
    if (process.env.MIXDOG_WS_UPGRADE_HEADER_PROBE) {
      const all = res?.headers && typeof res.headers === 'object' ? _formatRedactedHeaders(res.headers) : '(none)';
      const line = `[ws-upgrade-probe] ts=${new Date().toISOString()} status=${res?.statusCode} headers={ ${all} }\n`;
      process.stderr.write(line);
      // Bench runners swallow child stderr on success; persist to a
      // file so the probe survives (value of the env var = path, or
      // default under tmp).
      try {
        const probePath =
          process.env.MIXDOG_WS_UPGRADE_HEADER_PROBE !== '1'
            ? process.env.MIXDOG_WS_UPGRADE_HEADER_PROBE
            : `${process.env.TEMP || process.env.TMPDIR || '.'}/mixdog-ws-upgrade-probe.log`;
        appendFileSync(probePath, line, { encoding: 'utf8', mode: 0o600 });
        try {
          chmodSync(probePath, 0o600);
        } catch {}
      } catch {}
    }
  } catch {}
}

/**
 * @param {object} deps
 * @param {import('ws')} deps.socket
 * @param {string} deps.errLabel     transport label for the error messages
 * @param {number} deps.openStart    Date.now() at handshake start (debug elapsed)
 * @param {() => boolean} deps.isSettled
 * @param {(ok: boolean, val: any) => void} deps.settle
 */
export function attachHandshakeFailureHandlers({ socket, errLabel, openStart, isSettled, settle }) {
  socket.once('error', (err) => {
    if (process.env.MIXDOG_DEBUG_AGENT) {
      process.stderr.write(
        `[agent-trace] ws-open-fail kind=error msg=${String(err?.message || err).slice(0, 120)} elapsed=${Date.now() - openStart}ms\n`
      );
    }
    try {
      socket.terminate();
    } catch {}
    settle(
      false,
      err instanceof Error
        ? err
        : Object.assign(new Error(errText(err) || 'openai-oauth WS error'), { wsErrorEvent: true, original: err })
    );
  });
  socket.once('close', (code, reason) => {
    // Half-open handshake: the peer closed before 'open'/'error' fired
    // (TCP RST / TLS edge). Without this the connect Promise never
    // settles and only the 600s outer watchdog can break the stall
    // (observed stage=requesting 601s hang). Open-path closes are
    // no-ops here because settle() has already flipped `settled`.
    if (isSettled()) return;
    try {
      socket.terminate();
    } catch {}
    settle(
      false,
      Object.assign(new Error(`${errLabel} handshake closed before open (code=${code})`), {
        wsCloseCode: code,
        wsCloseReason: reason?.toString ? reason.toString('utf-8') : '',
      })
    );
  });
  socket.once('unexpected-response', (_req, res) => {
    if (isSettled()) return;
    const status = res?.statusCode || 0;
    let body = '';
    res.on('data', (c) => {
      if (body.length < 2048) body += c.toString('utf-8');
    });
    res.on('end', () => {
      if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(
          `[agent-trace] ws-open-fail kind=http status=${status} body=${body.slice(0, 120)} elapsed=${Date.now() - openStart}ms\n`
        );
      }
      try {
        socket.terminate();
      } catch {}
      settle(
        false,
        Object.assign(new Error(`${errLabel} handshake ${status}: ${body.slice(0, 200)}`), {
          httpStatus: status,
          httpBody: body,
        })
      );
    });
  });
}
