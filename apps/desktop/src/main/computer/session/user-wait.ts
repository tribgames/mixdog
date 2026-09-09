import type { ComputerUseCoordinator, ComputerUseSnapshot } from './coordinator';

export interface IdleObservation {
  ready: boolean;
  monitor: string;
  sequence: number;
  idleMs: number;
  held: boolean;
}

export function isIdleResumePause(snapshot: ComputerUseSnapshot): boolean {
  return snapshot.userControlActive && snapshot.cleanupState === 'ready'
    && !snapshot.attentionRequired && snapshot.takeoverReason === 'user_input_active';
}

/** Waiters never enter the execution/cleanup queues and never replay input. */
export function createComputerUserWait(options: {
  coordinator: ComputerUseCoordinator;
  observe: () => Promise<IdleObservation>;
  resume: (generation: number, signal: AbortSignal, recheck: () => Promise<boolean>) => Promise<void>;
  enabled: () => boolean;
  now?: () => number;
  diagnostic?: (code: string, elapsedMs: number) => void;
}) {
  const now = options.now ?? (() => performance.now());
  const waiters = new Map<string, (status: string) => void>();
  let seconds = 5;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let generation = -1;
  let baseline: IdleObservation | undefined;
  let quietSince = now();
  let attempt: AbortController | undefined;
  let observationFailures = 0;

  const reset = () => { baseline = undefined; quietSince = now(); attempt?.abort(); };
  const publish = (remaining?: number) => options.coordinator.setIdleResume(seconds, remaining);
  const valid = (value: IdleObservation) => value.ready
    && Boolean(value.monitor) && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && Number.isFinite(value.idleMs) && value.idleMs >= 0;
  const eligible = () => !disposed && seconds > 0 && options.enabled()
    && isIdleResumePause(options.coordinator.snapshot());
  const same = (a: IdleObservation, b: IdleObservation) =>
    a.monitor === b.monitor && a.sequence === b.sequence;
  const observationFailed = (code: string, elapsedMs: number) => {
    reset();
    observationFailures++;
    options.diagnostic?.(code, elapsedMs);
    publish(seconds);
    // At most two retries per takeover, including failures at the final check.
    // A valid sample never restores time accrued before an uncertain sample.
    if (observationFailures >= 3) options.coordinator.pauseForUser('input_observation_unavailable');
  };

  async function sample(): Promise<void> {
    if (inFlight || !eligible()) return;
    inFlight = true;
    const currentGeneration = generation;
    const sampledAt = now();
    try {
      const value = await options.observe();
      if (!eligible() || generation !== currentGeneration) return;
      if (!valid(value) || now() - sampledAt > 2_000) {
        observationFailed(!valid(value) ? 'idle_observation_invalid' : 'idle_observation_slow', now() - sampledAt);
        return;
      }
      if (value.held) { reset(); publish(seconds); return; }
      if (!baseline || !same(value, baseline) || value.idleMs < baseline.idleMs) {
        baseline = value;
        quietSince = now();
      } else baseline = value;
      const remaining = Math.max(0, seconds * 1000 - Math.min(now() - quietSince, value.idleMs));
      publish(Math.ceil(remaining / 1000));
      if (remaining > 0) return;
      attempt = new AbortController();
      const expected = value;
      const signal = attempt.signal;
      await options.resume(currentGeneration, signal, async () => {
        const started = now();
        const last = await options.observe();
        if (!signal.aborted && eligible() && currentGeneration === generation
          && (now() - started > 2_000 || !valid(last))) {
          observationFailed(!valid(last) ? 'idle_observation_invalid' : 'idle_observation_slow', now() - started);
          return false;
        }
        return !signal.aborted && eligible() && currentGeneration === generation
          && now() - started <= 2_000 && valid(last) && !last.held && same(expected, last)
          && last.idleMs >= seconds * 1000;
      });
    } catch (error) {
      if (eligible() && generation === currentGeneration) {
        if (!/computer_resume_(stale|cancelled)/.test(String(error))) {
          observationFailed('idle_observation_error', now() - sampledAt);
        } else reset();
      }
    } finally {
      attempt = undefined;
      inFlight = false;
      schedule();
    }
  }
  function schedule(): void {
    if (timer || inFlight || !eligible()) return;
    timer = setTimeout(() => { timer = undefined; void sample(); }, 500);
    timer.unref?.();
  }
  const unsubscribe = options.coordinator.subscribe((snapshot) => {
    if (snapshot.takeoverGeneration !== generation) {
      generation = snapshot.takeoverGeneration ?? 0;
      observationFailures = 0;
      reset();
    }
    if (!snapshot.userControlActive && snapshot.cleanupState === 'ready') {
      for (const finish of [...waiters.values()]) finish('resumed');
    }
    if (snapshot.userControlActive && snapshot.takeoverReason === 'user_stop') {
      for (const finish of [...waiters.values()]) finish('cancelled');
    }
    if (!isIdleResumePause(snapshot)) {
      reset();
      if (timer) clearTimeout(timer);
      timer = undefined;
    } else schedule();
  });
  publish();

  return {
    configure(value: number): void {
      if (!Number.isInteger(value) || value < 0 || value > 60) {
        throw new Error('computer_idle_seconds_invalid: use 0 (manual) or 1..60 seconds');
      }
      seconds = value; reset(); publish(); schedule();
    },
    wait(sessionId: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<string> {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) {
        return Promise.reject(new Error('invalid_request: timeout_ms must be 0..120000'));
      }
      if (disposed || signal?.aborted) return Promise.resolve('cancelled');
      const current = options.coordinator.snapshot();
      if (current.userControlActive && current.takeoverReason === 'user_stop') return Promise.resolve('cancelled');
      if (!current.userControlActive && current.cleanupState === 'ready') return Promise.resolve('resumed');
      if (waiters.has(sessionId) || waiters.size >= 16) {
        return Promise.reject(new Error('computer_capacity_exhausted: user wait already active or full'));
      }
      return new Promise((resolve) => {
        const finish = (status: string) => {
          clearTimeout(deadline);
          signal?.removeEventListener('abort', cancel);
          waiters.delete(sessionId);
          resolve(status);
        };
        const cancel = () => finish('cancelled');
        const deadline = setTimeout(() => finish('timeout'), timeoutMs);
        waiters.set(sessionId, finish);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    },
    cancel(sessionId?: string): void {
      reset();
      if (sessionId) waiters.get(sessionId)?.('cancelled');
      else for (const finish of [...waiters.values()]) finish('cancelled');
    },
    dispose(): void {
      disposed = true;
      unsubscribe(); reset();
      if (timer) clearTimeout(timer);
      for (const finish of [...waiters.values()]) finish('cancelled');
    },
  };
}
