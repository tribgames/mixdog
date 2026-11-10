/**
 * http-router/tool-routes.mjs — the owner-side /api/tool + /api/cancel
 * plumbing. In-flight controllers are keyed by the caller-supplied
 * X-Mixdog-Call-Id so /api/cancel aborts the AbortSignal threaded into
 * handleToolCall and the upstream tool actually stops when the fork-proxy
 * parent cancels.
 */
import { readBody, sendJson, TOOL_HTTP_BODY_MAX_BYTES } from '../http-wire.mjs';

export function createToolRoutes({ handleToolCall, getDraining }) {
  const inFlight = new Map();

  function rejectDrainingToolCall(res) {
    if (!getDraining?.()) return false;
    sendJson(res, { content: [{ type: 'text', text: 'memory worker draining' }], isError: true }, 503);
    return true;
  }

  const toolCall = async (req, res) => {
    // Reject tool calls that arrive after shutdown has begun. The error text
    // carries the "draining" token so the proxy treats it as transient,
    // respawns a fresh daemon, and retries the RPC (including write RPCs).
    if (rejectDrainingToolCall(res)) return;
    const callId = String(req.headers['x-mixdog-call-id'] || '').trim() || null;
    const ac = new AbortController();
    // Abort only on a genuine mid-flight client disconnect. The req 'close'
    // event fires on every normal request once the request body is consumed
    // (before handleToolCall resolves), so gating on it would mark normal
    // completions as aborted. Use the response side instead: when the
    // socket closes, res.writableFinished is true iff the response was
    // fully written — a real client disconnect closes the socket before
    // the response finishes, leaving writableFinished===false.
    res.on('close', () => {
      if (res.writableFinished) return;
      ac.abort();
    });
    if (callId) inFlight.set(callId, ac);
    try {
      // Raised cap: ingest_session ships whole-session transcripts (see
      // TOOL_HTTP_BODY_MAX_BYTES in http-wire.mjs).
      const body = await readBody(req, { maxBytes: TOOL_HTTP_BODY_MAX_BYTES });
      // Body parsing can outlive cancellation or shutdown. Do not acquire
      // new runtime resources after either boundary has been crossed.
      ac.signal.throwIfAborted();
      if (rejectDrainingToolCall(res)) return;
      const result = await handleToolCall(body.name, body.arguments ?? {}, ac.signal);
      sendJson(res, result);
    } catch (e) {
      sendJson(
        res,
        { content: [{ type: 'text', text: `api/tool error: ${e.message}` }], isError: true },
        Number(e?.statusCode) || 500
      );
    } finally {
      if (callId && inFlight.get(callId) === ac) inFlight.delete(callId);
    }
  };

  const cancel = async (req, res) => {
    try {
      const body = await readBody(req);
      const id = String(body.callId || '').trim();
      if (!id) {
        sendJson(res, { ok: false, error: 'callId required' }, 400);
        return;
      }
      const ac = inFlight.get(id);
      if (ac) {
        ac.abort();
        inFlight.delete(id);
        sendJson(res, { ok: true, cancelled: true });
      } else {
        sendJson(res, { ok: true, cancelled: false });
      }
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, Number(e?.statusCode) || 500);
    }
  };

  return {
    'POST /api/tool': toolCall,
    'POST /api/cancel': cancel,
  };
}
