// The in-process host's telemetry shapes. Both mirror the multi-shard host's
// wire shape with a single implicit shard (the daemon process itself), so a
// caller reads one workload/status contract regardless of host mode.

export function inlineWorkloads(runtimes) {
  const memory = process.memoryUsage();
  return {
    mode: 'in-process',
    refreshedAt: Date.now(),
    shardCount: 0,
    shards: [],
    worker: {
      pid: process.pid,
      runtimes,
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
      },
    },
  };
}

export function inlineStatus(runtimes, active) {
  return {
    mode: 'in-process',
    active,
    worker: {
      pid: process.pid,
      pids: [process.pid],
      runtimes,
    },
    shards: [],
    shardCount: 0,
    providerCooldown: null,
  };
}
