// "PC access" (접근 권한): the secure-desktop service as Computer Use setup on
// Windows grants it. Each moment maps onto one installer operation
// (secure-desktop/install-request.ts):
// - the readiness row's Approve (the person is at the PC): one UAC `install`
//   enrolling every paired phone's delivered key (remote-controller-keys.ts)
//   and applying the pending revokes; the install also turns on app
//   delegation. When installed and a phone's delegated enroll was refused in a
//   way only elevation fixes, Approve new phone enrolls every missing phone
//   under one UAC instead, the pending revokes in the same key-set write;
// - a phone delivers its key (pairing): a delegated `enroll`, unelevated and
//   with no PC prompt (the service shows its own notification);
// - a phone is unpaired on this PC: one transaction in the same queue as
//   every enrollment records its key as a pending revoke (durably), runs the
//   unpair, then a delegated `revoke`; the record goes only once a revoke is
//   confirmed;
// - every pairing removal in the service (unpair from any caller, rotate,
//   recovery) first owes the removed phones' keys there (remote-client-
//   cache.ts `oweAccess`); this app takes them over into its pending record
//   before any enrollment, approval or revoke, then settles them there.
// The rule: a revocation is never lost, and a pending revocation blocks every
// new enrollment; only a phone paired now is ever enrolled. When a record is
// damaged, full, or an unpaired phone's key could not be read, the
// revocations are "unknown": nothing is enrolled until an elevated install,
// which writes the full key set from the current pairings, resolves it.
// The phone's Windows password (`approveWithCredential`, docs/remote-screen.md
// "PC access from the phone") is Approve's twin for when nobody is at the PC:
// the same decisions in the same queue, authorized by a batch logon instead of
// a UAC prompt.
// Whether a key is enrolled is the bridge's `check --controller-key`:
// `installed` while that key is enrolled in a current install, `not-enrolled`
// (exit 7) when the current install lacks it.
// docs/remote-screen.md "PC access: install and enroll moments".
import { constants as fsConstants } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { writeJsonAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';
import type { DesktopPcAccessApproval, DesktopPcAccessReadiness } from '../shared/contract';
import type { RemoteControllerKeyRecord, RemoteControllerKeysOwed } from '../shared/remote-controller-key';
import { MAX_REMOTE_SCREEN_HELPER_KEYS } from '../shared/remote-webrtc';
import { isSecureDesktopControllerKey } from '../shared/secure-desktop-grant';
import type { SecureDesktopInstaller } from './secure-desktop';
import type { SecureDesktopCredential } from './secure-desktop/client';
import type { SecureDesktopKeyChangeResult } from './secure-desktop/install-request';

/** The installer operations this module drives (one shared instance, so its
 *  single in-flight latch also covers the phone's own requests). */
export type PcAccessInstaller = Pick<SecureDesktopInstaller, 'state' | 'install' | 'enroll' | 'revoke'>;

/** The revocations still owed to the service. */
export interface PcAccessPendingState {
  /** Keys of unpaired phones whose revoke is not confirmed yet. */
  keys: string[];
  /** A marker while revocations may be missing (damaged or full record, an
   *  unreadable key at unpair); null when `keys` is the whole debt. */
  unknown: number | null;
}

export interface PcAccessPendingRevokes {
  read(): Promise<PcAccessPendingState>;
  /** Durable once it resolves; rejects when it could not be written. */
  add(key: string): Promise<void>;
  /** Revocations may be missing (durable, like `add`). */
  markUnknown(): Promise<void>;
  /** Confirmed: `keys` were revoked; with the `unknown` marker read before an
   *  install (and still the current one), the unknown state is resolved. */
  settle(keys: readonly string[], unknown?: number | null): Promise<void>;
}

/** What a password request ends with: the installer's result, or `busy` when
 *  another phone's password request was running and nothing was run (the
 *  phone may simply ask again; not an answer about its own request). */
export type PcAccessCredentialResult = Omit<SecureDesktopKeyChangeResult, 'outcome'> & {
  outcome: SecureDesktopKeyChangeResult['outcome'] | 'busy';
};

export interface PcAccess {
  readiness(): Promise<DesktopPcAccessReadiness>;
  /** The readiness row's Approve: install, or enroll the missing phones. */
  approve(): Promise<DesktopPcAccessApproval>;
  /**
   * The phone's fallback when nobody is at the PC: the same install-or-enroll
   * as `approve`, authorized by the Windows password the phone typed (the
   * service's batch-logon path, no UAC prompt) instead of a prompt. Refused
   * (`failed`) unless `clientId` is a phone paired now that delivered exactly
   * `publicKey`. The outcome is the installer's (`bad-credentials`,
   * `not-admin`, … included), its `state` relative to `publicKey`. The
   * credential is passed to the installer and kept nowhere.
   */
  approveWithCredential(request: {
    clientId: string;
    publicKey: string;
    credential: SecureDesktopCredential;
    /** Aborted when the phone's session ends: a request still queued (not yet
     *  with the installer) then runs nothing; one already dispatched finishes. */
    signal?: AbortSignal;
  }): Promise<PcAccessCredentialResult>;
  /** A paired phone delivered its key: enroll it through delegation unless a
   *  pending revocation blocks it. */
  delivered(publicKey: string): Promise<'enrolled' | 'nothing' | 'blocked' | 'delegation-disabled' | 'failed'>;
  /**
   * Settings → Connection's Remove: one queued transaction. The phone's key
   * is recorded as owed (an unreadable key marks revocations unknown; a
   * failed record refuses the unpair), `unpair` runs, and the answer returns;
   * still in the queue, the revoke is tried before any delivery runs. A
   * thrown `unpair` keeps the record.
   */
  unpair<T>(clientId: string, unpair: () => Promise<T>): Promise<T>;
  /** Take over the service's owed revocations and try every pending revoke
   *  now (delegated). */
  revokeOwed(): Promise<'revoked' | 'pending'>;
}

const APPROVED = new Set(['installed', 'updated', 'enrolled']);
const PASSED_ON = new Set(['declined', 'failed', 'in-progress', 'other-user', 'unavailable']);
/** Delegated refusals only an elevated Approve fixes (not a transient one). */
const NEEDS_ELEVATION = new Set(['delegation-disabled', 'delegation-denied']);

const CANCELLED = 'the phone’s session ended before the request ran';
const CREDENTIAL_BUSY = 'another phone password request is already running on the PC';

/** The row's answer for an installer outcome; anything the UAC path should
 *  not produce reads as failed, naming it in the (English, log-only) detail.
 *  The installer's exit code goes along, which the row shows (the elevated
 *  installer's own JSON `error` cannot reach this process through UAC). */
function approvalOf({ outcome, detail, exitCode }: SecureDesktopKeyChangeResult): DesktopPcAccessApproval {
  if (APPROVED.has(outcome)) return { outcome: 'done' };
  const exit = exitCode === undefined ? {} : { exitCode };
  if (PASSED_ON.has(outcome))
    return { outcome: outcome as DesktopPcAccessApproval['outcome'], ...(detail ? { detail } : {}), ...exit };
  return { outcome: 'failed', detail: detail ?? outcome, ...exit };
}

/** Why a delegated step did not run, beside its outcome name in the log. */
const DELEGATED_REASONS: Partial<Record<SecureDesktopKeyChangeResult['outcome'], string>> = {
  'delegation-disabled': 'delegation is turned off',
  'delegation-denied': 'the service refused this app',
  'service-unreachable': 'the service could not be reached',
};

const logFailure = (what: string, result: SecureDesktopKeyChangeResult): void => {
  const reason = DELEGATED_REASONS[result.outcome];
  console.error(
    `[mixdog-pc-access] ${what}: ${result.outcome}${reason ? ` - ${reason}` : ''}${result.detail ? ` (${result.detail})` : ''}`
  );
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** An install of the bundled service (a keyed check may add "lacks this key"). */
const isInstalled = (state: string): boolean => state === 'installed' || state === 'not-enrolled';

/** Records the removed phone's key as owed before the unpair runs (an
 *  unreadable key marks revocations unknown). A failed record rejects the
 *  unpair with `reject` and answers false. */
async function recordOwedKey(
  { keys, pending }: Pick<PcAccessDeps, 'keys' | 'pending'>,
  clientId: string,
  reject: (reason: Error) => void
): Promise<boolean> {
  try {
    let key: string | null = null;
    try {
      key = (await keys()).find((record) => record.clientId === clientId)?.publicKey ?? null;
    } catch (error) {
      console.error(`[mixdog-pc-access] the unpaired phone's key could not be read: ${messageOf(error)}`);
      await pending.markUnknown();
    }
    if (key) await pending.add(key);
    return true;
  } catch (error) {
    reject(
      new Error(`The phone was not removed: its PC access revocation could not be recorded (${messageOf(error)}).`)
    );
    return false;
  }
}

interface PcAccessDeps {
  installer: PcAccessInstaller;
  pending: PcAccessPendingRevokes;
  /** The paired phones' delivered keys (the service's paired-device records). */
  keys(): Promise<RemoteControllerKeyRecord[]>;
  /** The revocations the service owes for removed pairings. */
  owed(): Promise<RemoteControllerKeysOwed>;
  /** Those this app now holds durably. */
  settleOwed(keys: readonly string[], unknown: number): Promise<void>;
}

/** The paired keys and the revocations owed for removed pairings: reading
 *  them, taking over the service's, and draining them through delegation. */
function createRevocationLedger(deps: PcAccessDeps) {
  const { installer, pending } = deps;
  /** Keys of the phones paired now: not unpaired, not waiting to be revoked. */
  const pairedKeys = async (revoking: readonly string[]): Promise<string[]> => {
    const records = await deps.keys();
    const skip = new Set(revoking);
    return [...new Set(records.filter((record) => !record.unpaired).map((record) => record.publicKey))].filter(
      (key) => !skip.has(key)
    );
  };
  /** Paired keys the current install lacks (`not-enrolled`, check exit 7). */
  const missingKeys = async (revoking: readonly string[]): Promise<string[]> => {
    const keys = await pairedKeys(revoking);
    const states = await Promise.all(keys.map((key) => installer.state(key)));
    return keys.filter((_key, index) => states[index] === 'not-enrolled');
  };
  /** Every pending revoke through delegation; the first refusal (after which
   *  nothing may be enrolled), or null once all of them are confirmed. */
  const drainDelegated = async (keys: readonly string[]): Promise<SecureDesktopKeyChangeResult | null> => {
    for (const key of keys) {
      const result = await installer.revoke(key, { delegated: true });
      if (result.outcome !== 'revoked') {
        logFailure('delegated pending revoke', result);
        return result;
      }
      await pending.settle([key]);
    }
    return null;
  };
  /** Takes over the service's owed revocations: durably into the pending
   *  record first, then settled there. Rejects (so nothing is enrolled) when
   *  the service cannot be asked. */
  const absorb = async (): Promise<void> => {
    const owed = await deps.owed();
    if (!owed.keys.length && !owed.unknown) return;
    for (const key of owed.keys) await pending.add(key);
    if (owed.unknown) await pending.markUnknown();
    await deps.settleOwed(owed.keys, owed.unknown);
  };
  /** Every pending revoke, now, through delegation. */
  const revokeOwedNow = async (): Promise<'revoked' | 'pending'> => {
    await absorb();
    const owed = await pending.read();
    if (!owed.keys.length) return 'revoked';
    const state = await installer.state();
    // Nothing can run now: the record waits for the next install or enroll.
    if (state === 'not-installed' || state === 'unavailable' || state === 'other-user') return 'pending';
    return (await drainDelegated(owed.keys)) ? 'pending' : 'revoked';
  };
  return { pairedKeys, missingKeys, drainDelegated, absorb, revokeOwedNow };
}

/**
 * The one authorized install-or-enroll, for Approve (UAC, no `credential`)
 * and for a phone's Windows password (`credential`, with the `phone` that
 * sent it): the same state decisions and the same revocation rules, so the
 * credential path bypasses none of them. Every recorded revoke (and any an
 * unknown record lost) is applied in the same call, and the pending record
 * is cleared only once that call succeeded. Call inside the access queue.
 * `needsElevation` is cleared of the keys a successful call enrolled.
 */
async function authorizeInstall(
  {
    deps,
    ledger,
    needsElevation,
  }: {
    deps: PcAccessDeps;
    ledger: ReturnType<typeof createRevocationLedger>;
    needsElevation: Set<string>;
  },
  credential?: SecureDesktopCredential,
  phone?: { clientId: string; publicKey: string },
  signal?: AbortSignal
): Promise<SecureDesktopKeyChangeResult | 'nothing-to-do'> {
  const { installer, pending } = deps;
  const { pairedKeys, missingKeys, absorb } = ledger;
  const state = await installer.state();
  if (state === 'unavailable' || state === 'other-user') return { outcome: state, state };
  // The request's session ended while it waited in the queue: nothing runs.
  const cancelled = (): SecureDesktopKeyChangeResult | null =>
    signal?.aborted ? { outcome: 'failed', state, detail: CANCELLED } : null;
  const early = cancelled();
  if (early) return early;
  await absorb();
  const owed = await pending.read();
  // Only the phone this connection is, still paired, under the key it delivered.
  if (
    phone &&
    (owed.keys.includes(phone.publicKey) ||
      !(await deps.keys()).some(
        (record) => record.clientId === phone.clientId && record.publicKey === phone.publicKey && !record.unpaired
      ))
  ) {
    return { outcome: 'failed', state, detail: 'this phone is not paired on this PC under that access key' };
  }
  const options = (revoke: readonly string[]) => ({ revoke, ...(credential ? { credential } : {}) });
  if (!isInstalled(state) || owed.unknown !== null) {
    // The install writes exactly these keys: every recorded revoke, and
    // any an unknown record lost, is applied.
    const keys = await pairedKeys(owed.keys);
    const late = cancelled();
    if (late) return late;
    const result = await installer.install(keys, options(owed.keys));
    if (APPROVED.has(result.outcome)) {
      await pending.settle(owed.keys, owed.unknown);
      needsElevation.clear();
    }
    return result;
  }
  const missing = await missingKeys(owed.keys);
  if (!missing.length) return 'nothing-to-do';
  const late = cancelled();
  if (late) return late;
  // One authorized call for every missing phone: the bridge applies the
  // revokes and the enrolls in one key-set write, both or neither.
  const result = await installer.enroll(missing, options(owed.keys));
  if (APPROVED.has(result.outcome)) {
    await pending.settle(owed.keys);
    for (const key of missing) needsElevation.delete(key);
  }
  return result;
}

export function createPcAccess(deps: PcAccessDeps): PcAccess {
  const { installer, pending } = deps;
  // One step at a time: an Approve, a delivery, an unpair and a revoke never overlap.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };
  /** Missing keys whose last delegated attempt was refused in a way only
   *  elevation fixes: what the row's Approve new phone is for. */
  const needsElevation = new Set<string>();
  /** Keys with a delegated enroll queued or running (the row waits for it). */
  const inFlight = new Map<string, number>();
  /** A phone's password request is queued or running (`approveWithCredential`). */
  let credentialBusy = false;

  const ledger = createRevocationLedger(deps);
  const { pairedKeys, missingKeys, drainDelegated, absorb, revokeOwedNow } = ledger;
  const authorize = (
    credential?: SecureDesktopCredential,
    phone?: { clientId: string; publicKey: string },
    signal?: AbortSignal
  ) => authorizeInstall({ deps, ledger, needsElevation }, credential, phone, signal);
  const deliver = async (publicKey: string) => {
    await absorb();
    const owed = await pending.read();
    if (owed.keys.includes(publicKey)) return 'nothing' as const;
    // Only a phone paired now: a removed (or being removed) pairing never enrolls again.
    if (!(await pairedKeys(owed.keys)).includes(publicKey)) return 'nothing' as const;
    // Only a current install lacking this key: nothing before setup, nothing once enrolled.
    if ((await installer.state(publicKey)) !== 'not-enrolled') return 'nothing' as const;
    // A pending revocation blocks every new enrollment; unknown ones need an install.
    if (owed.unknown !== null) return 'blocked' as const;
    const refused = await drainDelegated(owed.keys);
    const result = refused ?? (await installer.enroll([publicKey], { delegated: true }));
    if (NEEDS_ELEVATION.has(result.outcome)) needsElevation.add(publicKey);
    else needsElevation.delete(publicKey);
    if (refused) return 'blocked' as const;
    if (result.outcome === 'enrolled') return 'enrolled' as const;
    // Delegation is off: the readiness row offers Approve new phone.
    if (result.outcome === 'delegation-disabled') return 'delegation-disabled' as const;
    logFailure('delegated enroll', result);
    return 'failed' as const;
  };

  return {
    async readiness() {
      const state = await installer.state();
      if (state === 'unavailable' || state === 'other-user') return { state };
      if (!isInstalled(state)) return { state: 'not-installed' };
      // Read, not taken over (that is a queued step): the service's owed ones count too.
      const [owed, service] = await Promise.all([pending.read(), deps.owed()]);
      if (owed.unknown !== null || service.unknown) return { state: 'revocations-unknown' };
      // Only a refusal elevation fixes: not while a delegated enroll runs, nor
      // for a transient one (the phone's next delivery tries again).
      const missing = await missingKeys([...owed.keys, ...service.keys]);
      return { state: missing.some((key) => needsElevation.has(key) && !inFlight.has(key)) ? 'needs-enroll' : 'ready' };
    },
    approve: () =>
      serial(async (): Promise<DesktopPcAccessApproval> => {
        const result = await authorize();
        return result === 'nothing-to-do' ? { outcome: 'nothing-to-do' } : approvalOf(result);
      }),
    approveWithCredential: async ({ clientId, publicKey, credential, signal }): Promise<PcAccessCredentialResult> => {
      // One password request at a time, from any phone: another is answered,
      // not queued (a guess is never stored for later).
      if (credentialBusy) {
        return { outcome: 'busy', state: await installer.state(publicKey), detail: CREDENTIAL_BUSY };
      }
      credentialBusy = true;
      try {
        return await serial(async (): Promise<SecureDesktopKeyChangeResult> => {
          const result = await authorize(credential, { clientId, publicKey }, signal);
          // Whatever the call enrolled, the answer is about this phone.
          const state = await installer.state(publicKey);
          return result === 'nothing-to-do' ? { outcome: 'enrolled', state } : { ...result, state };
        });
      } finally {
        credentialBusy = false;
      }
    },
    delivered: (publicKey) => {
      inFlight.set(publicKey, (inFlight.get(publicKey) ?? 0) + 1);
      return serial(() => deliver(publicKey)).finally(() => {
        const left = (inFlight.get(publicKey) ?? 1) - 1;
        if (left) inFlight.set(publicKey, left);
        else inFlight.delete(publicKey);
      });
    },
    unpair: <T>(clientId: string, unpair: () => Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        void serial(async () => {
          if (!(await recordOwedKey(deps, clientId, reject))) return;
          let result: T;
          try {
            result = await unpair();
          } catch (error) {
            // The record stays: the pairing may be gone, and only a confirmed revoke removes it.
            reject(error);
            return;
          }
          resolve(result);
          // Still in the queue: no delivery or drain runs before this revoke was tried.
          await revokeOwedNow().catch((error: unknown) => {
            console.error(`[mixdog-pc-access] revoke after unpair failed (still pending): ${messageOf(error)}`);
          });
        }).catch(reject);
      }),
    revokeOwed: () => serial(revokeOwedNow),
  };
}

const EMPTY: PcAccessPendingState = { keys: [], unknown: null };

/** The file's `{ keys, unknown }`, or null for anything else. */
function parsePending(text: string): PcAccessPendingState | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { keys, unknown } = value as { keys?: unknown; unknown?: unknown };
    if (!Array.isArray(keys) || keys.length > MAX_REMOTE_SCREEN_HELPER_KEYS) return null;
    if (!keys.every((key: unknown) => isSecureDesktopControllerKey(key))) return null;
    if (unknown !== null && unknown !== undefined && !Number.isSafeInteger(unknown)) return null;
    return { keys: [...new Set(keys as string[])], unknown: (unknown as number | null | undefined) ?? null };
  } catch {
    return null;
  }
}

/**
 * A damaged or unreadable record: its revocations are unknown. A copy is kept
 * aside (`<file>.damaged-<marker>`), then the file is replaced by the unknown
 * state. Copying first (not renaming) leaves no moment without a file: if
 * either step fails the damaged file stays and reads as unknown again.
 */
async function setAside(file: string, why: string): Promise<PcAccessPendingState> {
  const state: PcAccessPendingState = { keys: [], unknown: Date.now() };
  console.error(`[mixdog-pc-access] pending revocations ${why}; enrollment waits for PC access to be approved again`);
  try {
    await copyFile(file, `${file}.damaged-${state.unknown}`, fsConstants.COPYFILE_EXCL);
    await writeJsonAtomicAsync(file, state, { compact: true });
  } catch (error) {
    console.error(`[mixdog-pc-access] could not set the pending revocations aside: ${messageOf(error)}`);
  }
  return state;
}

async function loadPending(file: string): Promise<PcAccessPendingState> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    return setAside(file, `could not be read (${messageOf(error)})`);
  }
  return parsePending(text) ?? setAside(file, 'were damaged');
}

/**
 * The pending revokes in this app's user data (public keys only), at most the
 * pairing cap; past it the revocations become unknown. Changes run one at a
 * time and the in-memory state moves only once its atomic write succeeded.
 */
export function pendingRevokesFile(file: string): PcAccessPendingRevokes {
  let current: Promise<PcAccessPendingState> | null = null;
  const load = (): Promise<PcAccessPendingState> => {
    current ??= loadPending(file);
    return current;
  };
  let changes: Promise<unknown> = Promise.resolve();
  const change = (next: (state: PcAccessPendingState) => PcAccessPendingState | null): Promise<void> => {
    const run = changes.then(async () => {
      const updated = next(await load());
      if (!updated) return;
      await writeJsonAtomicAsync(file, updated, { compact: true });
      current = Promise.resolve(updated);
    });
    changes = run.catch(() => undefined);
    return run;
  };
  /** A new marker on every mark, so an install that read an older one never
   *  resolves a later loss. */
  const marked = (state: PcAccessPendingState): PcAccessPendingState => ({
    keys: state.keys,
    unknown: Math.max(Date.now(), (state.unknown ?? 0) + 1),
  });
  return {
    read: async () => {
      await changes;
      const state = await load();
      return { keys: [...state.keys], unknown: state.unknown };
    },
    add: (key) =>
      change((state) => {
        if (state.keys.includes(key)) return null;
        if (state.keys.length >= MAX_REMOTE_SCREEN_HELPER_KEYS) return marked(state);
        return { keys: [...state.keys, key], unknown: state.unknown };
      }),
    markUnknown: () => change(marked),
    settle: (keys, unknown) =>
      change((state) => {
        const left = state.keys.filter((key) => !keys.includes(key));
        const resolved = unknown != null && state.unknown === unknown;
        if (left.length === state.keys.length && !resolved) return null;
        return { keys: left, unknown: resolved ? null : state.unknown };
      }),
  };
}

/** Settings → Connection's Remove on this PC: the PC access transaction
 *  (`PcAccess.unpair`) where PC access exists, else the plain unpair. */
export function unpairWithPcAccess<T>(
  pcAccess: Pick<PcAccess, 'unpair'> | null | undefined,
  clientId: string,
  unpair: () => Promise<T>
): Promise<T> {
  return pcAccess ? pcAccess.unpair(clientId, unpair) : unpair();
}
