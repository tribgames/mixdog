/**
 * app/btw-controller.mjs — the transient `/btw` side-question panel.
 *
 * The answer lives only in this panel (never the transcript). `ask` replaces
 * any existing panel, `close` (Esc) cancels a pending request, and a result
 * that arrives after a replace/close is ignored via the request sequence.
 */
import { measureMarkdownRenderedRows } from '../markdown/measure-rendered-rows.mjs';

export const BTW_USAGE_HINT = 'usage: /btw <question>';
// Border (2) + header (1) + footer (1).
export const BTW_CHROME_ROWS = 4;
const BTW_MAX_BODY_ROWS = 10;

/** Rendered row count of the answer body (the scrollable content height). */
export function btwContentRows(panel, columns) {
  const body =
    panel.status === 'done'
      ? measureMarkdownRenderedRows(panel.text, Math.max(1, columns - 4))
      : String(panel.text || '').split('\n').length;
  return Math.max(1, body);
}

export function btwPanelRows(panel, columns) {
  if (!panel) return 0;
  return BTW_CHROME_ROWS + Math.min(BTW_MAX_BODY_ROWS, btwContentRows(panel, columns));
}

/** Largest scroll offset for `total` content rows shown through `visible` rows. */
export function btwScrollMax(total, visible) {
  return Math.max(0, total - Math.max(1, visible));
}

/** Next scroll offset for a PageUp/PageDown key (other keys leave it unchanged). */
export function btwScrollOffset(key, offset, visible, total) {
  const max = btwScrollMax(total, visible);
  const page = Math.max(1, visible - 1);
  if (key.pageUp) return Math.max(0, Math.min(max, offset) - page);
  if (key.pageDown) return Math.min(max, offset + page);
  return Math.min(max, offset);
}

/**
 * Each request is bound to the session it was asked in. A settlement whose
 * session no longer matches is ignored; `sync` (session change) and `dispose`
 * (unmount) cancel a pending request for its originating session.
 */
export function createBtwController({ getStore, setPanel, getSessionId = () => '' }) {
  let seq = 0;
  let pending = null; // { sessionId, dispatched } while a request is queued or in flight
  let origin = null; // session the visible panel was asked in

  const cancelPending = () => {
    if (!pending) return;
    const { sessionId, dispatched } = pending;
    pending = null;
    // Not dispatched yet: dropping `pending` stops the queued request, so
    // there is nothing to cancel (a cancel sent first would not hit it).
    if (!dispatched) return;
    try {
      const result = getStore().cancelSide?.(sessionId);
      if (result?.catch) void result.catch(() => {});
    } catch {
      /* best-effort cancel */
    }
  };

  const ask = (question) => {
    cancelPending();
    const id = ++seq;
    const sessionId = getSessionId();
    const request = { sessionId, dispatched: false };
    pending = request;
    origin = sessionId;
    setPanel({ question, status: 'pending', text: '' });
    const settle = (next) => {
      if (id !== seq || getSessionId() !== sessionId) return;
      pending = null;
      setPanel({ question, ...next });
    };
    Promise.resolve()
      .then(() => {
        // askSide runs against the store's current session, so only dispatch
        // while this ask is still live and still in its origin session.
        if (pending !== request || id !== seq || getSessionId() !== sessionId) {
          if (pending === request) pending = null;
          return undefined; // dropped, never sent; `settle` ignores it (stale id/session)
        }
        request.dispatched = true;
        return getStore().askSide(question);
      })
      .then(
        (result) => settle({ status: 'done', text: String(result?.text ?? '') }),
        (error) => settle({ status: 'error', text: String(error?.message || error || 'side question failed') })
      );
  };

  const close = () => {
    cancelPending();
    seq += 1;
    origin = null;
    setPanel(null);
  };

  /** Session changed: a panel from another conversation is cancelled and cleared. */
  const sync = () => {
    if (origin !== null && getSessionId() !== origin) close();
  };

  /** Unmount: cancel without touching React state. */
  const dispose = () => {
    cancelPending();
    seq += 1;
    origin = null;
  };

  return { ask, close, sync, dispose };
}
