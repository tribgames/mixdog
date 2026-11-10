// Per-session accumulation of one agent_calls/agent_llm batch for the
// agent_sessions upsert.
import { eventSessionId, eventTimestampIso } from './agent-call-rows.mjs';

function emptySessionSummary(ts) {
  return {
    tool_calls: 0,
    llm_calls: 0,
    max_iteration: 0,
    total_input: 0n,
    total_output: 0n,
    ts0: ts,
    ts1: ts,
    agent: null,
    model: null,
  };
}

function touchSummary(s, r) {
  if (r.iteration != null && r.iteration > s.max_iteration) s.max_iteration = r.iteration;
  if (r.ts < s.ts0) s.ts0 = r.ts;
  if (r.ts > s.ts1) s.ts1 = r.ts;
}

export function summarizeAgentSessions(events, toolRows, llmRows) {
  const sessions = new Map();
  const summaryFor = (sid, ts) => {
    let s = sessions.get(sid);
    if (!s) {
      s = emptySessionSummary(ts);
      sessions.set(sid, s);
    }
    return s;
  };
  for (const r of toolRows) {
    const s = summaryFor(r.session_id, r.ts);
    s.tool_calls += 1;
    touchSummary(s, r);
  }
  for (const r of llmRows) {
    const s = summaryFor(r.session_id, r.ts);
    s.llm_calls += 1;
    s.total_input += BigInt(r.input_tokens ?? 0);
    s.total_output += BigInt(r.output_tokens ?? 0);
    if (r.model) s.model = r.model;
    touchSummary(s, r);
  }
  const presetAssigns = events.filter((ev) => ev.kind === 'preset_assign' && eventSessionId(ev));
  // The agent comes from preset_assign events in the same batch.
  for (const ev of presetAssigns) {
    const s = sessions.get(eventSessionId(ev));
    if (s && ev.agent) s.agent = ev.agent;
  }
  // A preset_assign-only batch (no tool/llm rows yet) still upserts its session.
  for (const ev of presetAssigns) {
    const sid = eventSessionId(ev);
    if (sessions.has(sid)) continue;
    sessions.set(sid, {
      ...emptySessionSummary(eventTimestampIso(ev)),
      agent: ev.agent ?? null,
      model: ev.model ?? null,
    });
  }
  return sessions;
}
