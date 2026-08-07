import { createOwnerFairGate } from './owner-fair-gate.mjs';

function positiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

export const readIoAdmission = createOwnerFairGate({
  name: 'read I/O',
  activeMax: positiveInt(process.env.MIXDOG_READ_MAX_INFLIGHT, 16),
  queueMax: positiveInt(process.env.MIXDOG_READ_MAX_QUEUE, 2048),
  minOwnerQueue: 16,
  waitTimeoutMs: positiveInt(process.env.MIXDOG_READ_WAIT_TIMEOUT_MS, 30_000),
});

export const codeGraphSourceIoAdmission = createOwnerFairGate({
  name: 'code graph source I/O',
  activeMax: positiveInt(process.env.MIXDOG_CODE_GRAPH_SOURCE_MAX_INFLIGHT, 16),
  queueMax: positiveInt(process.env.MIXDOG_CODE_GRAPH_SOURCE_MAX_QUEUE, 2048),
  minOwnerQueue: 16,
  waitTimeoutMs: positiveInt(process.env.MIXDOG_CODE_GRAPH_SOURCE_WAIT_TIMEOUT_MS, 30_000),
});

export function toolWorkloadSnapshot() {
  return {
    readIo: readIoAdmission.snapshot(),
    codeGraphSourceIo: codeGraphSourceIoAdmission.snapshot(),
  };
}
