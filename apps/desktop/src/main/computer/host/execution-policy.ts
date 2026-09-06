import { readFileSync } from 'node:fs';
import type { ComputerCommand } from '../shared/types';
import type { ComputerWindowRecord } from '../shared/window-transition';
import { isComputerLifecycleControl } from './action-sets';
import { COMPUTER_POLICY_ACTIONS, computerActionPolicy } from '../../../../../../src/runtime/computer-bridge/actions.mjs';

const ACTIONS = new Set(COMPUTER_POLICY_ACTIONS);
const FIELDS = new Set(['version', 'actions', 'windows', 'launchTargets', 'allowElevatedInput', 'expiresAt']);

function invalid(): never {
  throw new Error('computer_policy_invalid: expected a version 1 policy with exact actions, windows and launch targets');
}

export function createComputerExecutionPolicy(raw?: unknown, now = Date.now) {
  let actions: Set<string> | undefined;
  const windows = new Map<string, number>();
  let launches = new Set<string>();
  let elevated = true;
  let expiresAt = Infinity;
  if (raw !== undefined) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some((key) => !FIELDS.has(key)) || value.version !== 1) invalid();
    const strings = (field: string): string[] => {
      const list = value[field] ?? [];
      if (!Array.isArray(list) || list.length > 128
        || list.some((entry) => typeof entry !== 'string' || !entry.trim() || entry !== entry.trim() || entry.length > 4096)) invalid();
      return list as string[];
    };
    actions = new Set(strings('actions'));
    if ([...actions].some((action) => !ACTIONS.has(action))) invalid();
    launches = new Set(strings('launchTargets'));
    const targets = value.windows ?? [];
    if (!Array.isArray(targets) || targets.length > 128) invalid();
    for (const target of targets) {
      if (!target || typeof target !== 'object' || Array.isArray(target)
        || Object.keys(target).some((key) => !['id', 'pid'].includes(key))
        || typeof target.id !== 'string' || !/^hwnd:0x[0-9a-f]+$/i.test(target.id)
        || !Number.isSafeInteger(target.pid) || target.pid < 1 || windows.has(target.id)) invalid();
      windows.set(target.id, target.pid);
    }
    if (value.allowElevatedInput !== undefined && typeof value.allowElevatedInput !== 'boolean') invalid();
    elevated = value.allowElevatedInput === true;
    if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) invalid();
    expiresAt = Date.parse(value.expiresAt);
  }
  const assertCurrent = () => {
    if (now() >= expiresAt) throw new Error('computer_policy_expired: the configured authorization has expired');
  };
  return {
    restricted: actions !== undefined,
    authorizationExpiry(): number | null {
      return Number.isFinite(expiresAt) ? expiresAt : null;
    },
    dispatchAuthority(windowId?: string): Record<string, unknown> {
      assertCurrent();
      return {
        authorization_expires_at: Number.isFinite(expiresAt) ? expiresAt : null,
        ...(actions && windowId ? {
          authorization_window_id: windowId,
          authorization_pid: windows.get(windowId),
        } : {}),
      };
    },
    assertAction(command: ComputerCommand): void {
      if (!actions || isComputerLifecycleControl(command)) return;
      assertCurrent();
      const action = command.action;
      const publicAction = computerActionPolicy(action);
      if (!actions.has(publicAction)) throw new Error('computer_policy_denied: this action is outside the configured authorization');
      if (action === 'launch' && !launches.has(String(command.app || ''))) {
        throw new Error('computer_policy_denied: launch target is not explicitly authorized');
      }
      if (['act', 'capture', 'window', 'menu', 'verify'].includes(publicAction)
        && !windows.has(String(command.window_id || ''))) {
        throw new Error('computer_policy_denied: an explicitly authorized exact window_id is required');
      }
    },
    assertWindow(command: ComputerCommand, records: ComputerWindowRecord[] | null): void {
      if (!actions || !command.window_id || isComputerLifecycleControl(command)) return;
      assertCurrent();
      const expectedPid = windows.get(command.window_id);
      if (expectedPid && records && command.action === 'verify'
        && !records.some((record) => record.id === command.window_id)) return;
      if (!expectedPid || !records?.some((record) => record.id === command.window_id && record.pid === expectedPid)) {
        throw new Error('computer_policy_denied: target process identity no longer matches the authorization');
      }
    },
    assertElevated(): void {
      assertCurrent();
      if (!elevated) throw new Error('computer_policy_denied: elevated input is not authorized');
    },
  };
}

/** Only trusted host launch configuration can select a policy; tool arguments cannot. */
export function loadComputerExecutionPolicy(path = process.env.MIXDOG_COMPUTER_POLICY_FILE) {
  if (path === undefined) return createComputerExecutionPolicy();
  if (!path.trim()) invalid();
  try {
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source) > 64 * 1024) invalid();
    return createComputerExecutionPolicy(JSON.parse(source));
  } catch {
    throw new Error('computer_policy_invalid: the configured policy could not be loaded; Computer Use was not started');
  }
}

export type ComputerExecutionPolicy = ReturnType<typeof createComputerExecutionPolicy>;
