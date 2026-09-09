import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { computerUseCoordinator } from '../session/coordinator';
import { createComputerUserWait } from '../session/user-wait';
import type { ComputerCommand, PowerShellResponse } from '../shared/types';
import type { SessionLifecycle } from './session-lifecycle';
import { assertSafeComputerSessionId } from '../input/guards';

export const USER_WAIT_SESSION_ID = '__computer_user_wait__';

export function createUserWaitService(options: {
  directory: string;
  lifecycle: SessionLifecycle;
  callPowerShell: (request: Record<string, unknown>, timeout?: number) => Promise<PowerShellResponse>;
  enabled: () => boolean;
  recordDiagnostic?: (sessionId: string, record: Record<string, unknown>) => void;
}) {
  const path = join(options.directory, 'computer-idle-resume.json');
  const manager = createComputerUserWait({
    coordinator: computerUseCoordinator,
    enabled: options.enabled,
    diagnostic: (code, elapsedMs) => options.recordDiagnostic?.(USER_WAIT_SESSION_ID, {
      action: 'input_idle_state', stage: 'observation', ok: false, code, ms: elapsedMs,
    }),
    resume: (generation, signal, recheck) => options.lifecycle.resumeAfterTakeover(generation, signal, recheck),
    observe: async () => {
      const response = await options.callPowerShell({
        action: 'input_idle_state', session_id: USER_WAIT_SESSION_ID, read_only: true,
      }, 5_000);
      const value = response.result;
      if (!response.ok || !value) throw new Error('input_observation_unavailable');
      return {
        ready: value.ready === true, monitor: String(value.monitor || ''),
        sequence: Number(value.sequence), idleMs: Number(value.idleMs), held: value.held !== false,
      };
    },
  });
  try {
    if (statSync(path).size > 1024) throw new Error('oversized idle policy');
    manager.configure(JSON.parse(readFileSync(path, 'utf8')).seconds);
  } catch (error) {
    // A malformed saved preference never silently enables automatic resume.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') manager.configure(0);
  }
  return {
    ...manager,
    configure(seconds: number): void {
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 60) {
        throw new Error('computer_idle_seconds_invalid: use 0 or 1..60');
      }
      mkdirSync(options.directory, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ seconds }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        try { unlinkSync(temporary); } catch { /* rename consumed it */ }
      }
      manager.configure(seconds);
    },
    async command(command: ComputerCommand, signal: AbortSignal) {
      assertSafeComputerSessionId(command);
      if (Object.keys(command).some((key) => !['action', 'session_id', 'timeout_ms'].includes(key))) {
        throw new Error('invalid_request: wait_for_user accepts only timeout_ms');
      }
      const status = await manager.wait(String(command.session_id || 'default'), command.timeout_ms, signal);
      return { text: JSON.stringify({
        ok: true, action: 'wait_for_user', status,
        resumed: status === 'resumed', fresh_capture_required: status === 'resumed',
        input_replayed: false,
        reason: computerUseCoordinator.snapshot().takeoverReason || '',
      }) };
    },
  };
}
