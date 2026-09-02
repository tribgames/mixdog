import { performance } from 'node:perf_hooks';

function token(value) {
  return String(value ?? '')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.:+-]/g, '')
    .slice(0, 120);
}

function milliseconds(value) {
  return Math.max(0, Math.round(Number(value) * 10) / 10);
}

export function createBootPhaseProfiler({
  log = () => {},
  now = () => performance.now(),
  startedAt = now(),
} = {}) {
  const origin = Number(startedAt);

  function emit(phase, status, fields = {}) {
    const parts = [
      'boot-phase',
      `phase=${token(phase)}`,
      `status=${token(status)}`,
      `totalMs=${milliseconds(now() - origin)}`,
    ];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === '') continue;
      parts.push(`${token(key)}=${token(value)}`);
    }
    log(parts.join(' '));
  }

  function mark(phase, fields = {}) {
    emit(phase, 'mark', fields);
  }

  async function measure(phase, task, fields = {}) {
    const phaseStartedAt = now();
    emit(phase, 'start', fields);
    try {
      const result = await task();
      emit(phase, 'ready', {
        ...fields,
        durationMs: milliseconds(now() - phaseStartedAt),
      });
      return result;
    } catch (error) {
      emit(phase, 'failed', {
        ...fields,
        durationMs: milliseconds(now() - phaseStartedAt),
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  return { mark, measure };
}
