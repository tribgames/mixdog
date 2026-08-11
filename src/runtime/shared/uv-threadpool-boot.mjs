// Evaluate BEFORE the first libuv threadpool consumer (async fs/dns/zlib/
// crypto): Node sizes the pool lazily on first use from UV_THREADPOOL_SIZE.
// The default of 4 starves bursty multi-session tool execution — dozens of
// concurrent async stats/reads queue behind 4 workers and simple stats take
// seconds (observed >5s, tripping the dead-mount reachability guard on live
// local paths). Size to the host, bounded: operators override by setting the
// env var themselves.
import { availableParallelism } from 'node:os';

if (!process.env.UV_THREADPOOL_SIZE) {
  const cpus = Math.max(1, Number(availableParallelism()) || 1);
  process.env.UV_THREADPOOL_SIZE = String(Math.min(16, Math.max(8, cpus)));
}
