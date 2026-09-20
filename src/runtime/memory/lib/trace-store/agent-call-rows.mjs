// Normalisation of agent trace events into agent_calls / agent_llm rows.
import { createHash } from 'node:crypto';

const TOOL_ARGS_MAX_BYTES = 65536; // 64 KB cap; oversized → sha256 + truncated preview

export function eventSessionId(ev) {
  return ev.session_id ?? ev.sessionId ?? null;
}

export function eventTimestampIso(ev) {
  let ts = ev.ts;
  if (typeof ts === 'string') ts = Date.parse(ts);
  ts = Number(ts);
  if (!Number.isFinite(ts)) ts = Date.now();
  return new Date(ts).toISOString();
}

function capToolArgs(args) {
  if (args == null) return null;
  const raw = typeof args === 'string' ? args : JSON.stringify(args);
  if (Buffer.byteLength(raw, 'utf8') <= TOOL_ARGS_MAX_BYTES) {
    if (typeof args !== 'string') return args;
    // tool_args is JSONB in PG; round-trip parse for string inputs, but a
    // plain non-JSON string (e.g. a bare path) would otherwise throw and
    // fail the whole insert batch. Treat unparseable as the raw string.
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return { _oversized: true, sha256: createHash('sha256').update(raw).digest('hex'), preview: raw.slice(0, 512) };
}

function toolRow(ev, { sid, ts, iteration }) {
  const tool_ms = ev.tool_ms ?? ev.toolMs ?? null;
  return {
    session_id: sid,
    iteration,
    ts,
    tool_name: ev.tool_name ?? ev.toolName ?? null,
    tool_kind: ev.tool_kind ?? ev.toolKind ?? null,
    tool_ms: tool_ms != null ? Number(tool_ms) : null,
    tool_args: capToolArgs(ev.tool_args ?? ev.toolArgs ?? null),
    result_kind: ev.result_kind ?? ev.resultKind ?? null,
    result_error_category: ev.result_error_category ?? ev.resultErrorCategory ?? null,
    result_error_first_line: ev.result_error_first_line ?? ev.resultErrorFirstLine ?? null,
  };
}

function llmRow(ev, { sid, ts, iteration }) {
  return {
    session_id: sid,
    iteration,
    ts,
    model: ev.model ?? null,
    input_tokens: ev.input_tokens ?? ev.inputTokens ?? null,
    output_tokens: ev.output_tokens ?? ev.outputTokens ?? null,
    cached_tokens: ev.cached_tokens ?? ev.cachedTokens ?? null,
    cache_write_tokens: ev.cache_write_tokens ?? ev.cacheWriteTokens ?? null,
    prompt_tokens: ev.prompt_tokens ?? ev.promptTokens ?? null,
    response_id: ev.response_id ?? ev.responseId ?? null,
  };
}

// Events without a session id are dropped; kind-less usage is recognised by
// its snake_case token fields.
export function collectAgentCallRows(events) {
  const toolRows = [];
  const llmRows = [];
  for (const ev of events) {
    const sid = eventSessionId(ev);
    if (!sid) continue;
    const row = { sid, ts: eventTimestampIso(ev), iteration: ev.iteration != null ? Number(ev.iteration) : null };
    if (ev.kind === 'tool') toolRows.push(toolRow(ev, row));
    else if (ev.kind === 'usage_raw' || (ev.input_tokens != null && ev.output_tokens != null)) {
      llmRows.push(llmRow(ev, row));
    }
  }
  return { toolRows, llmRows };
}
