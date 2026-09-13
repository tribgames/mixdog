// Two independent measurements: requested array dimensions and observed
// execution overlap. Never infer missed opportunities or dependency freedom.
const key = (session, batch) => JSON.stringify([session ?? null, batch]);
const validIntervals = intervals => Array.isArray(intervals) && intervals.every(interval =>
  Number.isFinite(interval?.started_at_ms) && Number.isFinite(interval?.completed_at_ms)
  && interval.completed_at_ms >= interval.started_at_ms);

function overlap(calls) {
  const points = [];
  for (const call of calls) {
    for (const interval of call.intervals) {
      if (interval.completed_at_ms === interval.started_at_ms) continue;
      points.push({ at: interval.started_at_ms, delta: 1, id: call.id, name: call.name });
      points.push({ at: interval.completed_at_ms, delta: -1, id: call.id, name: call.name });
    }
  }
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);
  const active = new Map();
  let max = 0;
  let mixed = false;
  for (const point of points) {
    const count = (active.get(point.id)?.count ?? 0) + point.delta;
    if (count) active.set(point.id, { count, name: point.name });
    else active.delete(point.id);
    max = Math.max(max, active.size);
    if (new Set([...active.values()].map(value => value.name)).size > 1) mixed = true;
  }
  return { max_concurrency: max, mixed_tool_overlap: mixed };
}

export function summarizeToolBatching(trace) {
  const batches = trace.filter(row => row.kind === 'batch');
  const toolRows = new Map();
  for (const row of trace) {
    const batch = row.payload?.batch;
    if (row.kind !== 'tool' || !batch?.batch_id || !batch.tool_call_id) continue;
    const groupKey = key(row.session_id, batch.batch_id);
    if (!toolRows.has(groupKey)) toolRows.set(groupKey, new Map());
    toolRows.get(groupKey).set(batch.tool_call_id, row);
  }
  const byTool = {};
  let arrayCalls = 0;
  let arrayContractCalls = 0;
  const groups = [];
  for (const row of batches) {
    const batch = row.payload;
    if (batch?.batch_schema_version !== 1 || !Array.isArray(batch.calls) || !batch.batch_id) continue;
    const completed = toolRows.get(key(row.session_id, batch.batch_id));
    const timed = [];
    const calls = batch.calls.map(call => {
      const lengths = call.array_lengths;
      if (lengths && typeof lengths === 'object' && !Array.isArray(lengths)) {
        arrayContractCalls++;
        const tool = byTool[call.tool_name] ??= { calls: 0, array_batched_calls: 0, arrays: {} };
        tool.calls++;
        if (Object.values(lengths).some(length => length > 1)) {
          tool.array_batched_calls++;
          arrayCalls++;
        }
        for (const [field, length] of Object.entries(lengths)) {
          const dimension = tool.arrays[field] ??= { calls: 0, items: 0 };
          dimension.calls++;
          dimension.items += length;
        }
      }
      const result = completed?.get(call.tool_call_id);
      const intervals = result?.payload?.execution_intervals;
      const timingKnown = validIntervals(intervals);
      if (timingKnown) timed.push({ id: call.tool_call_id, name: call.tool_name, intervals });
      return { ...call, result_kind: result?.result_kind ?? null, timing_known: timingKnown };
    });
    const measured = timed.length ? overlap(timed) : null;
    groups.push({
      batch_id: batch.batch_id,
      session_id: row.session_id ?? null,
      calls,
      timing_complete: timed.length === calls.length,
      timing_known_calls: timed.length,
      // Partial groups only establish lower bounds, never absence of overlap.
      observed_max_concurrency: measured?.max_concurrency ?? null,
      observed_mixed_tool_overlap: measured?.mixed_tool_overlap ?? null,
    });
  }
  const measured = groups.filter(group => group.observed_max_concurrency !== null);
  return {
    groups_total: batches.length,
    detailed_groups: groups.length,
    legacy_groups: batches.length - groups.length,
    internal_arrays: groups.length ? {
      calls_with_array_contract: arrayContractCalls,
      array_batched_calls: arrayCalls,
      by_tool: byTool,
    } : null,
    inter_tool: {
      multi_call_groups: batches.filter(row => row.payload?.tool_call_count > 1).length,
      mixed_tool_groups: groups.length
        ? groups.filter(group => new Set(group.calls.map(call => call.tool_name)).size > 1).length : null,
      timing_complete_groups: groups.filter(group => group.timing_complete).length,
      timing_unknown_or_partial_groups: batches.length - groups.filter(group => group.timing_complete).length,
      groups_with_observed_overlap: measured.length
        ? measured.filter(group => group.observed_max_concurrency > 1).length : null,
      groups_with_observed_mixed_tool_overlap: measured.length
        ? measured.filter(group => group.observed_mixed_tool_overlap).length : null,
      max_observed_concurrency: measured.length
        ? Math.max(...measured.map(group => group.observed_max_concurrency)) : null,
    },
    groups,
  };
}
