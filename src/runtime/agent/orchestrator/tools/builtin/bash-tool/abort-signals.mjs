import { getAbortSignalForSession } from '../../../session/abort-lookup.mjs';

export async function sessionAbortSignal(sessionId) {
  try {
    return (await getAbortSignalForSession(sessionId)) || null;
  } catch {
    return null;
  }
}

// Combine an existing session abort signal with an externally-supplied
// AbortSignal (e.g. the MCP/request signal threaded through options.abortSignal).
// Uses AbortSignal.any when available; falls back to a manual controller.
export function combineAbortSignals(sessionSignal, externalSignal) {
  const a = sessionSignal || null;
  const b = externalSignal || null;
  if (!a && !b) return { signal: null, cleanup() {} };
  if (!a) return { signal: b, cleanup() {} };
  if (!b) return { signal: a, cleanup() {} };
  if (a === b) return { signal: a, cleanup() {} };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    try {
      return { signal: AbortSignal.any([a, b]), cleanup() {} };
    } catch {
      /* fall through */
    }
  }
  const ctl = new AbortController();
  const onAbort = (sig) => {
    if (ctl.signal.aborted) return;
    try {
      ctl.abort(sig?.reason);
    } catch {
      try {
        ctl.abort();
      } catch {}
    }
  };
  if (a.aborted) {
    onAbort(a);
    return { signal: ctl.signal, cleanup() {} };
  }
  if (b.aborted) {
    onAbort(b);
    return { signal: ctl.signal, cleanup() {} };
  }
  const onAbortA = () => onAbort(a);
  const onAbortB = () => onAbort(b);
  try {
    a.addEventListener('abort', onAbortA, { once: true });
  } catch {}
  try {
    b.addEventListener('abort', onAbortB, { once: true });
  } catch {}
  return {
    signal: ctl.signal,
    cleanup() {
      try {
        a.removeEventListener('abort', onAbortA);
      } catch {}
      try {
        b.removeEventListener('abort', onAbortB);
      } catch {}
    },
  };
}
