// session-client/attachment-calls.mjs
// The request half of one session attachment: dispatching session calls over
// /call — where a transport death and a session error are deliberately
// different outcomes — and the deregistration that ends the attachment. The
// frame-stream half lives in ./stream-link.mjs. The HTTP `request` is injected
// so this module stays a wire-shape concern only.
import { DAEMON_RETRY_LATER } from '../daemon-refusal.mjs';

const URGENT_CALLS = new Set([
  'session.submit',
  'session.abort',
  'session.approve',
  'session.unsubscribe',
  'desktop.control',
  'desktop.unsubscribe',
]);

export function createAttachmentCalls({ request, port, serverToken, clientToken, stopStream, stopHeartbeat, log }) {
  let closed = false;

  async function call(name, args = {}, { timeoutMs = 300_000, callId = null } = {}) {
    let out;
    try {
      out = await request({
        port,
        token: serverToken,
        method: 'POST',
        path: '/call',
        body: { token: clientToken, name, args: args || {}, ...(callId ? { callId } : {}) },
        timeoutMs,
        urgent: URGENT_CALLS.has(name),
      });
    } catch (err) {
      // A daemon answering retry-later (busy, not ready) serves again
      // shortly: the caller asks again on this attachment under the same
      // callId, after `retryAfterMs`. Anything else — transport death (daemon
      // restarted or unreachable), a fenced or draining daemon, a client token
      // it no longer knows — is recoverable only by re-attaching; a session
      // error comes back as a 200 {error} envelope.
      if (err?.code === DAEMON_RETRY_LATER) err.retryable = true;
      else err.daemonTransportError = true;
      throw err;
    }
    if (out?.error) {
      // Preserve the daemon's machine-readable classification across the wire.
      const err = new Error(out.error);
      if (out.code) err.code = String(out.code);
      if (out.details && typeof out.details === 'object') err.details = out.details;
      throw err;
    }
    return out?.result;
  }

  async function close(reason = 'client close') {
    if (closed) return;
    closed = true;
    stopStream();
    stopHeartbeat?.();
    try {
      await request({
        port,
        token: serverToken,
        method: 'POST',
        path: '/client/deregister',
        body: { token: clientToken },
        timeoutMs: 1500,
        control: true,
      });
    } catch {
      /* the daemon sweep reaps us anyway */
    }
    log(`detached (${reason})`);
  }

  return { call, close };
}
