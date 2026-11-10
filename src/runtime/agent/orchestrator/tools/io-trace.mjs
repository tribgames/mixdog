// MIXDOG_IO_TRACE stderr tracing shared by the builtin, atomic-write and patch layers.
import { performance } from 'node:perf_hooks';
import { envFlag } from '../../../shared/env.mjs';

export function createIoTrace(enabled) {
  const start = () => (enabled() ? performance.now() : 0);
  const trace = (event, fields = {}) => {
    if (!enabled()) return;
    try {
      process.stderr.write(`[io-trace] ${JSON.stringify({ event, ts: Date.now(), ...fields })}\n`);
    } catch {}
  };
  const done = (event, started, fields = {}) => {
    if (!started || !enabled()) return;
    trace(event, {
      ...fields,
      ms: Number((performance.now() - started).toFixed(3)),
    });
  };
  return { enabled, start, trace, done };
}

export const {
  enabled: ioTraceEnabled,
  start: ioTraceStart,
  trace: ioTrace,
  done: ioTraceDone,
} = createIoTrace(() => envFlag('MIXDOG_IO_TRACE'));
