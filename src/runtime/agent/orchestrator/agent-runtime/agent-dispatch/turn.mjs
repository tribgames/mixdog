// One dispatch turn: run askSession against the prepared session, cap the
// answer, and salvage the partial handoff a watchdog or deadline abort left
// behind. Returns the text; throws when nothing can be salvaged.
import {
  partialHandoffTextFromSession,
  resolveHandoffMessageStartIndex,
  watchdogPartialHandoffFromError,
} from '../agent-progress-watchdog.mjs';
import { buildAgentDispatchAskSessionArgs } from './ask-args.mjs';

// Cap agent role synthesis to ~3000 tokens (~12 KB at the 4 B/tok
// working average). Pool B recall/search answers occasionally land
// 8-10k-token walls that then ride in the Lead context for the rest of the
// turn; the cap keeps those outliers bounded without touching the 95%+ of
// answers already under the threshold.
const BRIEF_CAP_BYTES = 12 * 1024;
function applyBriefCap(text) {
  if (typeof text !== 'string') return text;
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength <= BRIEF_CAP_BYTES) return text;
  // encodeInto stops before any character that would not fit, so `read`
  // (UTF-16 units consumed) never splits a multi-byte character.
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(BRIEF_CAP_BYTES));
  const head = text.slice(0, read);
  const approxTokens = Math.round(byteLength / 4);
  return `${head}\n\n... [TRUNCATED — full answer was ~${approxTokens} tokens / ${Math.round(byteLength / 1024)} KB. Re-run with brief:false for the complete synthesis]`;
}

function formatCompactElapsedSeconds(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value <= 0) return '';
  return `${Math.max(1, Math.ceil(value / 1000))}s`;
}

// True when an abort explicitly opted into partial salvage — the error object
// or the abort reason carries `salvagePartial: true`. A hard deadline sets it
// so partial output the sub-agent already produced is returned instead of
// discarded; user cancellation (ESC) never sets it and keeps the
// throw-everything behaviour.
function salvagePartialRequested(error, signal) {
  if (error && typeof error === 'object' && error.salvagePartial === true) return true;
  const reason = signal?.reason;
  return !!(reason && typeof reason === 'object' && reason.salvagePartial === true);
}

function agentCompactEventLabel(event = {}) {
  const status = String(event.status || '').toLowerCase();
  const reactive = String(event.trigger || '').toLowerCase() === 'reactive';
  if (status === 'failed') return reactive ? 'Compact failed (overflow retry)' : 'Compact failed';
  if (status === 'skipped') return 'Compact skipped';
  if (status === 'no_change') return 'Compact checked';
  return reactive ? 'Compact complete (overflow recovery)' : 'Compact complete';
}

function agentCompactEventDetail(event = {}) {
  const parts = [];
  const elapsed = formatCompactElapsedSeconds(Number(event.durationMs ?? event.elapsedMs ?? 0));
  if (elapsed) parts.push(elapsed);
  const before = Number(event.beforeTokens ?? event.pressureTokens ?? 0);
  const after = Number(event.afterTokens ?? 0);
  const fmtTok = (n) => {
    const v = Number(n) || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
    return `${Math.round(v)}`;
  };
  if (before > 0 && after > 0 && after !== before) parts.push(`${fmtTok(before)}→${fmtTok(after)}`);
  return parts.join(' · ');
}

function compactEventLogger(agent, sessionId) {
  return (event) => {
    try {
      const label = agentCompactEventLabel(event);
      const detail = agentCompactEventDetail(event);
      const suffix = detail ? ` (${detail})` : '';
      process.stderr.write(`[agent-dispatch] agent=${agent} session=${sessionId} compact: ${label}${suffix}\n`);
    } catch {
      /* best-effort compact visibility */
    }
  };
}

export async function runDispatchTurn({ agent, session, prompt, cwd, opts, callArgs, ask, readSession, abortSignal }) {
  // Brief cap. Agent role answers (recall/search)
  // occasionally balloon to 8-10k token walls that then ride in the
  // parent Lead's context for the rest of the turn. A 3000-token
  // (~12 KB) ceiling trims the long tail while leaving the vast
  // majority of answers untouched. Opt-out via `brief:false` when
  // the caller explicitly wants the full synthesis.
  const brief = (text) => (opts.brief === false ? text : applyBriefCap(text));
  const t0 = Date.now();
  let handoffMsgStart = 0;
  try {
    handoffMsgStart = resolveHandoffMessageStartIndex(readSession(session.id));
    const { onToolCall, askOpts } = buildAgentDispatchAskSessionArgs(
      opts,
      callArgs,
      { onCompactEvent: compactEventLogger(agent, session.id) },
      session
    );
    // liveProjection is a send-opt on askOpts only. Do not stamp it
    // (or interactiveSessionSurface) onto `session`.
    const result = await ask(session.id, prompt, null, onToolCall, cwd, undefined, askOpts);
    process.stderr.write(`[agent-dispatch] agent=${agent} session=${session.id} elapsed=${Date.now() - t0}ms\n`);
    return brief(result?.content || '');
  } catch (err) {
    const partial =
      watchdogPartialHandoffFromError(err, readSession(session.id), handoffMsgStart) ??
      (salvagePartialRequested(err, abortSignal)
        ? partialHandoffTextFromSession(readSession(session.id), handoffMsgStart)
        : null);
    if (partial) return brief(partial);
    throw err;
  }
}
