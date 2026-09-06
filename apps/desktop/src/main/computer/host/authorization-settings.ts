import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ComputerAuthorization, ComputerAuthorizationStatus, ComputerAuthorizationWindow } from '../../../shared/computer-settings';
import { createComputerExecutionPolicy, type ComputerExecutionPolicy } from './execution-policy';

function normalizeAuthorization(value: unknown): ComputerAuthorization {
  createComputerExecutionPolicy(value);
  if (!value || typeof value !== 'object') throw new Error('computer_policy_invalid: an authorization object is required');
  const raw = value as ComputerAuthorization;
  const normalized = {
    version: 1 as const, actions: raw.actions ?? [], windows: raw.windows ?? [],
    launchTargets: raw.launchTargets ?? [], allowElevatedInput: raw.allowElevatedInput === true,
    expiresAt: raw.expiresAt,
  };
  if (Buffer.byteLength(JSON.stringify(normalized)) > 64 * 1024) {
    throw new Error('computer_policy_invalid: authorization exceeds the storage limit');
  }
  return normalized;
}

/** UI restrictions can narrow, but never replace, the host launch policy. */
export function createComputerAuthorizationSettings(options: {
  directory: string;
  base: ComputerExecutionPolicy;
  stop: () => Promise<void>;
  windows: () => Promise<ComputerAuthorizationWindow[]>;
}) {
  const path = join(options.directory, 'computer-authorization.json');
  let raw: ComputerAuthorization | null = null;
  let loadError = false;
  try {
    if (statSync(path).size > 64 * 1024) throw new Error('policy too large');
    raw = normalizeAuthorization(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Keep the settings surface available to repair the file, but no tool
      // operation may run under an unreadable authorization.
      loadError = true;
    }
  }
  let current = createComputerExecutionPolicy(raw ?? undefined);
  let updating = false;
  const assertReady = () => {
    if (updating) throw new Error('computer_policy_updating: authorization is being replaced');
    if (loadError) throw new Error('computer_policy_invalid: repair the saved authorization in local settings');
  };
  const policy: ComputerExecutionPolicy = {
    get restricted() { return updating || loadError || options.base.restricted || current.restricted; },
    authorizationExpiry() {
      const values = [options.base.authorizationExpiry(), current.authorizationExpiry()]
        .filter((value): value is number => value !== null);
      return values.length ? Math.min(...values) : null;
    },
    dispatchAuthority(windowId) {
      assertReady();
      const base = options.base.dispatchAuthority(windowId);
      const selected = current.dispatchAuthority(windowId);
      return { ...base, ...selected, authorization_expires_at: policy.authorizationExpiry() };
    },
    assertAction(command) { assertReady(); options.base.assertAction(command); current.assertAction(command); },
    assertWindow(command, records) { assertReady(); options.base.assertWindow(command, records); current.assertWindow(command, records); },
    assertElevated() { assertReady(); options.base.assertElevated(); current.assertElevated(); },
  };
  const read = (): ComputerAuthorizationStatus => ({
    policy: raw ? structuredClone(raw) : null, externallyRestricted: options.base.restricted, updating,
    ...(loadError ? { error: 'computer_policy_invalid' as const } : {}),
  });
  return {
    policy,
    read,
    windows: options.windows,
    async update(value: unknown): Promise<ComputerAuthorizationStatus> {
      if (updating) throw new Error('computer_policy_updating: another authorization write is in progress');
      // Copy before awaiting so the caller cannot alter already-validated authority.
      const candidate = normalizeAuthorization(structuredClone(value));
      const next = createComputerExecutionPolicy(candidate);
      if (!candidate || next.authorizationExpiry() === null
        || next.authorizationExpiry()! <= Date.now()
        || next.authorizationExpiry()! > Date.now() + 24 * 60 * 60_000) {
        throw new Error('computer_policy_invalid: authorization must expire within 24 hours');
      }
      updating = true;
      try {
        await options.stop();
        const windows = await options.windows();
        for (const target of (candidate as ComputerAuthorization).windows ?? []) {
          if (!windows.some((window) => window.id === target.id && window.pid === target.pid)) {
            throw new Error('computer_policy_denied: selected window is no longer available; refresh the list');
          }
        }
        if (next.authorizationExpiry()! <= Date.now()) throw new Error('computer_policy_expired: authorization expired while saving');
        mkdirSync(options.directory, { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, JSON.stringify(candidate), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          renameSync(temporary, path);
        } finally {
          try { unlinkSync(temporary); } catch { /* rename already consumed the temporary */ }
        }
        raw = candidate as ComputerAuthorization;
        current = next;
        loadError = false;
      } finally {
        updating = false;
      }
      return read();
    },
  };
}
