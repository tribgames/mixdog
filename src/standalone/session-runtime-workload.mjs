// Fields whose machine-wide value is the WORST shard rather than the sum:
// configured caps do not add up across processes, and wait/age gauges are
// worst-case signals. Everything else (inflight, queued, counters, bytes) is
// real per-process load and sums.
const WORKLOAD_MAX_FIELDS = new Set([
  'limit',
  'maxInflight',
  'queueMax',
  'activeMax',
  'waitTimeoutMs',
  'concurrency',
  'maxAgents',
  'maxShells',
  'maxHighLoad',
  'maxQueue',
  'minFreeMemoryMb',
  'maxRssMb',
  'oldestWaitMs',
  'oldestQueuedMs',
  'maxWaitMs',
  'averageWaitMs',
  'ageMs',
  'freeMemoryBytes',
  'totalMemoryBytes',
  'p50Ms',
  'p95Ms',
  'p99Ms',
  'maxMs',
  'meanMs',
  'intervalMs',
  'at',
]);
const WORKLOAD_LIST_CAP = 64;

/** Structural merge of two shard workload rows. */
function mergeShardWorkloadValues(left, right, key = '') {
  if (right === undefined || right === null) return left;
  if (left === undefined || left === null) return right;
  if (typeof left === 'number' && typeof right === 'number') {
    return WORKLOAD_MAX_FIELDS.has(key) ? Math.max(left, right) : left + right;
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return Boolean(left) || Boolean(right);
  }
  if (typeof left === 'string' || typeof right === 'string') {
    return left === right ? left : 'mixed';
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const entries = [...left, ...right];
    const named =
      entries.length > 0 &&
      entries.every((entry) => entry && typeof entry === 'object' && typeof entry.name === 'string');
    if (!named) return entries.slice(0, WORKLOAD_LIST_CAP);
    // Lane/gate rows are per-process views of ONE machine-wide lane: merge by
    // name so `childSpawns.lanes[].inflight` reports the machine total.
    const byName = new Map();
    for (const entry of entries) {
      const existing = byName.get(entry.name);
      byName.set(entry.name, existing ? mergeShardWorkloadValues(existing, entry) : entry);
    }
    return [...byName.values()];
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const out = {};
    for (const field of new Set([...Object.keys(left), ...Object.keys(right)])) {
      out[field] = mergeShardWorkloadValues(left[field], right[field], field);
    }
    return out;
  }
  return left;
}

/** Aggregate EVERY live shard into the single-worker shape older status
 *  consumers still read (resources/toolIo/childSpawns included), keeping the
 *  per-shard rows alongside it. */
export function aggregateShardWorkload(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (list.length === 0) return null;
  let merged = {};
  for (const row of list) merged = mergeShardWorkloadValues(merged, row);
  const errors = list.filter((row) => row?.error).map((row) => `shard ${row.shard ?? '?'}: ${row.error}`);
  const worstLag = list.reduce((worst, row) => {
    const sample = row?.eventLoopLag;
    if (!sample) return worst;
    return !worst || (Number(sample.p99Ms) || 0) > (Number(worst.p99Ms) || 0) ? sample : worst;
  }, null);
  return {
    ...merged,
    // Identity/telemetry fields describe shards individually — never summed.
    shard: list[0]?.shard ?? 0,
    pid: list.find((row) => row?.pid)?.pid ?? null,
    pids: list.map((row) => row?.pid ?? null),
    shards: list.length,
    degraded: list.some((row) => row?.degraded === true),
    eventLoopLag: worstLag,
    ...(errors.length > 0 ? { error: errors[0], errors } : {}),
  };
}
