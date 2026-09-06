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

/** In-process narrowing of Computer Use for an embedding host or the
 *  reliability harness: it can tighten, never replace, the host launch policy
 *  (`MIXDOG_COMPUTER_POLICY_FILE`). Nothing is persisted — a restriction lives
 *  only for this host's lifetime, so a fresh start is always the launch
 *  policy alone. The settings editor that used to write
 *  `computer-authorization.json` is gone (user: 표면에서 없애고 기본 전부
 *  허용): a saved file could only expire into a lock-out. */
export function createComputerAuthorizationSettings(options: {
  base: ComputerExecutionPolicy;
  stop: () => Promise<void>;
  windows: () => Promise<ComputerAuthorizationWindow[]>;
}) {
  let raw: ComputerAuthorization | null = null;
  let current = createComputerExecutionPolicy();
  let updating = false;
  const assertReady = () => {
    if (updating) throw new Error('computer_policy_updating: authorization is being replaced');
  };
  const policy: ComputerExecutionPolicy = {
    get restricted() { return updating || options.base.restricted || current.restricted; },
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
        raw = candidate as ComputerAuthorization;
        current = next;
      } finally {
        updating = false;
      }
      return read();
    },
  };
}
