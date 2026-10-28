/**
 * The PC's secure-desktop helper as every screen session sees it: the current
 * adapter (secure-desktop-adapter.ts), its install state, and the paired
 * phone's install request.
 *
 * - Install on demand only (main/secure-desktop/install-request.ts): the
 *   phone's `screen-helper-install` reaches `requestInstall`, which hands it to
 *   the installer with the phone's controller key. The installer joins a
 *   request already running, so there is at most one UAC prompt.
 * - Rebuilt after an install: a client reads the install state (its secret)
 *   once, when it is built, so after an `installed` or `updated` outcome the
 *   adapter is built afresh, as install-request.ts requires. So it is when an
 *   install-state check reads `installed` while the adapter reports not
 *   installed: an install finished outside a request that saw it end (one
 *   that answered `in-progress`), and the phone, offered nothing, would
 *   otherwise stay blocked beside a stale adapter.
 * - One holder (helper ownership). Each session sees the helper through its
 *   own lease (`lease()`). The helper serves one session at a time: the one
 *   that activated it first holds it. Only the holder's video runs are
 *   declared, only its grants and input reach the helper, and only it hears
 *   the helper's frames, challenges and issues. Another session that wants
 *   the helper meanwhile reads `ownedElsewhere()` (its status says the
 *   helper is in use) and waits, in the order it asked. The hold passes when
 *   the holder deactivates the helper or its session ends (`dispose()` of
 *   its lease): to the first waiting session or, with none, the helper is
 *   deactivated. Every lease hears `onDesktopChanged` when the holder
 *   changes.
 * - Unique epochs, and an explicit revoke on every hold. The helper ends a
 *   grant on a declaration only when the epoch differs from its current one
 *   (re-declaring the same epoch changes nothing: `GrantBook::set_epoch` in
 *   native/mixdog-secure-desktop/src/security.rs), so a declaration alone
 *   guarantees nothing across sessions. Two things do:
 *   - every video run's epoch comes from one helper-wide counter that only
 *     rises (`mintVideoRun`), so no two sessions' runs share an epoch; the
 *     run is the epoch the phone is shown in `screen-video` and in its
 *     challenges, and signs (the phone signs only a challenge of the run it
 *     was shown);
 *   - taking the hold always goes: deactivate (on a handover; the helper
 *     then releases what it held and revokes its grant and every open
 *     challenge, helper.rs), the new holder starts a fresh run (`onHold`;
 *     declared through its `setVideoRun`), then activate. Messages to the
 *     helper keep their order, so nothing of the new holder reaches it
 *     before the revoke.
 *   The lease mirrors that gate: a grant passes only from the holder, for
 *   the epoch it declared in this hold, naming a challenge forwarded to it
 *   since (the latest `CHALLENGES_OPEN`, each used once); input passes only
 *   once such a grant was relayed. The helper stays the authority on a
 *   grant's lifetime.
 * - One prompt per phone request, none after a refusal. A `declined` outcome
 *   latches: until the app restarts (for now the local action that clears
 *   it), every later install request, from any session, answers `declined`
 *   with `DECLINED_ON_PC` and launches nothing.
 * - Rebuilt only when the install changed: a request whose phone key was
 *   already installed and current before it (and that the adapter knows),
 *   or one that ends after the adapter was rebuilt since it began (a request
 *   another session joined ends with the same install), rebuilds nothing.
 * - The swap is transparent: listeners stay on the leases, the holder's
 *   activation and declared video run are applied to the new adapter, and
 *   `onDesktopChanged` fires so every session re-reads it. The old adapter is
 *   disposed; presses held through it are dropped by the sessions' routers
 *   (no identity), and before an install nothing could be pressed through it.
 * - After a reboot the registered service is stopped: `ensureRunning` starts
 *   it unelevated, with no prompt (the installer's `ensureRunning`; a current
 *   install only). The adapter, already dialling while activation is wanted,
 *   reaches it on its next reconnect.
 * - `dispose()`: the adapter is disposed and every listener dropped; a request
 *   or check that ends later rebuilds nothing.
 */
import type { SecureDesktopInstallResult, SecureDesktopInstallState, SecureDesktopStatus } from '../secure-desktop';
import type { SecureDesktopAdapter } from './secure-desktop-adapter';

/** The installer, as this module uses it (install-request.ts). */
interface SecureDesktopInstallPort {
  /** The install state, for that phone when its key is given; never prompts. */
  state(controllerKey?: string): Promise<SecureDesktopInstallState>;
  /** One phone request, enrolling its controller key: at most one UAC
   *  prompt, joining a request already running. */
  request(controllerKey: string): Promise<SecureDesktopInstallResult>;
  /** Start the current, registered service if stopped (after a reboot):
   *  unelevated, never installs, never prompts; the running status after. */
  ensureRunning(): Promise<SecureDesktopStatus>;
}

/** One screen session's view of the shared helper. */
export interface SecureDesktopLease extends SecureDesktopAdapter {
  /** Another session holds the helper now: this one's runs aren't declared,
   *  its grants and input are refused, and it hears no frames, challenges or
   *  issues. */
  ownedElsewhere(): boolean;
  /** A video-run epoch no session has used: one helper-wide counter, only
   *  rising. Every run of every session takes its epoch from here. */
  mintVideoRun(): number;
  /** This session has just taken the hold: it starts a fresh run now (minted,
   *  declared through `setVideoRun`), after the previous holder's grant was
   *  revoked and before the helper is activated for it. */
  onHold(listener: () => void): () => void;
  /** The install state (for that phone when its key is given); never prompts. */
  installState(controllerKey?: string): Promise<SecureDesktopInstallState>;
  /** The paired phone's install request with its controller key: at most one
   *  prompt, none after a decline (see the header). */
  requestInstall(controllerKey: string): Promise<SecureDesktopInstallResult>;
  /** Bring a stopped service up (the installer's `ensureRunning`), unless the
   *  helper is connected (then it runs). Sessions starting together share one
   *  attempt. */
  ensureRunning(): Promise<SecureDesktopStatus>;
  /** This session is done with the helper: the hold or the wait ends (as
   *  `setActive(false)`), and its listeners are dropped. Idempotent. */
  dispose(): void;
}

export interface SecureDesktopHelper {
  /** A new session's lease. */
  lease(): SecureDesktopLease;
  /** The adapter is disposed and every lease detached. */
  dispose(): void;
}

/** A latched decline's answer to a later request. */
export const DECLINED_ON_PC = 'the helper install was refused on the PC; restart Mixdog on the PC before asking again';

interface SecureDesktopHelperDeps {
  /** A fresh client and its adapter. */
  adapter(): SecureDesktopAdapter;
  installer: SecureDesktopInstallPort;
}

/** Challenges the helper keeps open: one issued every 2 s, each kept through
 *  an age of 6 s inclusive (`GrantBook::prune`; ipc-spec "Control grants"),
 *  so at most floor(6 / 2) + 1 = 4, issued at 0, 2, 4 and 6 s. Older ones
 *  the helper has dropped. */
const CHALLENGES_OPEN = 4;

/** One session's hold on (or wait for) the helper. */
interface Lease {
  hold: Set<() => void>;
  change: Set<() => void>;
  frame: Set<Parameters<SecureDesktopAdapter['onFrame']>[0]>;
  challenge: Set<Parameters<SecureDesktopAdapter['onGrantChallenge']>[0]>;
  issue: Set<(code: string) => void>;
}

const NOT_HOLDER = 'the secure-desktop helper is held by another session';
const NOT_GRANTED = 'no grant for this hold and run was relayed';
const NO_CHALLENGE = 'the grant names no challenge of this hold and run';
const WRONG_RUN = 'the grant is for another run than this hold declared';

interface InstallFlowHost {
  installer: SecureDesktopInstallPort;
  /** The current adapter; a rebuild replaces it. */
  adapter(): SecureDesktopAdapter;
  isDisposed(): boolean;
  /** The count of rebuilds so far. */
  adapterSerial(): number;
  rebuild(): void;
}

/** The install state, the phone's install request and the service start, with
 *  the latched decline and the shared start attempt they keep. */
function createInstallFlow(host: InstallFlowHost) {
  const { installer } = host;
  /** A phone request was declined on the PC: no prompt until restart. */
  let declined = false;
  /** The `ensureRunning` attempt under way, shared by its callers. */
  let starting: Promise<SecureDesktopStatus> | null = null;

  const installState = async (controllerKey?: string): Promise<SecureDesktopInstallState> => {
    const state = await installer.state(controllerKey);
    if (!host.isDisposed() && state === 'installed' && !host.adapter().installed()) host.rebuild();
    return state;
  };

  const refused = async (controllerKey: string): Promise<SecureDesktopInstallResult> => ({
    outcome: 'declined',
    state: await installer.state(controllerKey),
    detail: DECLINED_ON_PC,
  });

  const requestInstall = async (controllerKey: string): Promise<SecureDesktopInstallResult> => {
    if (declined) return refused(controllerKey);
    const serial = host.adapterSerial();
    // Relative to this phone's key: `installed` is current and enrolls it.
    const before = await installer.state(controllerKey);
    if (declined) return refused(controllerKey);
    // A request already prompting (this phone's) is joined by the installer.
    const result = await installer.request(controllerKey);
    if (result.outcome === 'declined') declined = true;
    const changed = before !== 'installed' || !host.adapter().installed();
    if (
      !host.isDisposed() &&
      changed &&
      serial === host.adapterSerial() &&
      (result.outcome === 'installed' || result.outcome === 'updated')
    ) {
      host.rebuild();
    }
    return result;
  };

  const ensureRunning = (): Promise<SecureDesktopStatus> => {
    if (host.adapter().connected()) return Promise.resolve({ installed: true, running: true });
    starting ??= installer.ensureRunning().finally(() => {
      starting = null;
    });
    return starting;
  };

  return { installState, requestInstall, ensureRunning };
}

export function createSecureDesktopHelper(deps: SecureDesktopHelperDeps): SecureDesktopHelper {
  const leases = new Set<Lease>();
  /** The session the helper serves, null when none activated it. */
  let holder: Lease | null = null;
  /** Sessions that want the helper while another holds it, in asking order. */
  const waiting = new Set<Lease>();
  let disposed = false;
  /** Bumped by every rebuild: a request that ends after one rebuilt nothing
   *  of its own (that adapter already read the install). */
  let adapterSerial = 0;
  /** The helper-wide video-run counter (`mintVideoRun`). */
  let runs = 0;
  /** The epoch the holder declared in its hold; null until it did. */
  let declared: { epoch: number; by: Lease } | null = null;
  /** Challenges forwarded to the holder for that declaration, newest last. */
  const issued: string[] = [];
  /** A grant for that declaration was relayed: its input may pass. */
  let granted = false;

  /** Nothing granted so far counts any more (a hold or run ended). */
  const forgetGrants = (): void => {
    issued.length = 0;
    granted = false;
  };

  const notify = (lease: Lease): void => {
    for (const listener of [...lease.change]) listener();
  };
  const notifyAll = (): void => {
    for (const lease of [...leases]) notify(lease);
  };

  let current: SecureDesktopAdapter;
  let detach: Array<() => void> = [];
  const attach = (adapter: SecureDesktopAdapter): void => {
    current = adapter;
    detach = [
      adapter.onDesktopChanged(notifyAll),
      adapter.onFrame((frame) => {
        for (const listener of [...(holder?.frame ?? [])]) listener(frame);
      }),
      adapter.onGrantChallenge((challenge) => {
        // Only a holder that declared its run can answer one.
        if (!holder || declared?.by !== holder) return;
        issued.push(challenge.challenge);
        if (issued.length > CHALLENGES_OPEN) issued.shift();
        for (const listener of [...holder.challenge]) listener(challenge);
      }),
      adapter.onHelperIssue((code) => {
        for (const listener of [...(holder?.issue ?? [])]) listener(code);
      }),
    ];
  };
  attach(deps.adapter());

  const rebuild = (): void => {
    for (const off of detach.splice(0)) off();
    current.dispose();
    adapterSerial += 1;
    attach(deps.adapter());
    // A new connection: nothing granted on the old one holds.
    forgetGrants();
    if (holder) {
      if (declared?.by === holder) current.setVideoRun(declared.epoch);
      void current.setActive(true);
    }
    notifyAll();
  };

  /** Declare `epoch` for the holder `lease`; a new one revokes what was
   *  granted for the one before. */
  const declare = (lease: Lease, epoch: number): void => {
    if (declared?.by === lease && declared.epoch === epoch) return;
    declared = { epoch, by: lease };
    forgetGrants();
    current.setVideoRun(epoch);
  };

  /**
   * `lease` holds the helper from now on, in this order: on a handover the
   * helper is deactivated (it releases what it held and revokes the previous
   * holder's grant and challenges), the new holder starts a fresh run
   * (declared), then the helper is activated for it.
   */
  const take = (lease: Lease, handover: boolean): Promise<void> => {
    holder = lease;
    waiting.delete(lease);
    declared = null;
    forgetGrants();
    if (handover) void current.setActive(false);
    for (const listener of [...lease.hold]) listener();
    return current.setActive(true);
  };

  const setActive = async (lease: Lease, active: boolean): Promise<void> => {
    if (disposed || !leases.has(lease)) return;
    if (active) {
      if (holder === lease || waiting.has(lease)) return;
      if (holder) {
        waiting.add(lease);
        // It decided before it asked: it re-reads `ownedElsewhere()`.
        notify(lease);
        return;
      }
      const activated = take(lease, false);
      notifyAll();
      await activated;
      return;
    }
    waiting.delete(lease);
    if (holder !== lease) return;
    holder = null;
    declared = null;
    forgetGrants();
    const [heir] = waiting;
    if (heir) {
      const activated = take(heir, true);
      notifyAll();
      await activated;
      return;
    }
    notifyAll();
    await current.setActive(false);
  };

  const sendGrant = (lease: Lease, grant: Parameters<SecureDesktopAdapter['sendGrant']>[0]): Promise<void> => {
    if (holder !== lease) return Promise.reject(new Error(NOT_HOLDER));
    const run = declared;
    if (run?.by !== lease || grant.epoch !== run.epoch) return Promise.reject(new Error(WRONG_RUN));
    const index = issued.indexOf(grant.challenge);
    if (index < 0) return Promise.reject(new Error(NO_CHALLENGE));
    // Each challenge answers once, as on the helper.
    issued.splice(index, 1);
    return current.sendGrant(grant).then(() => {
      if (declared === run) granted = true;
    });
  };

  const { installState, requestInstall, ensureRunning } = createInstallFlow({
    installer: deps.installer,
    adapter: () => current,
    isDisposed: () => disposed,
    adapterSerial: () => adapterSerial,
    rebuild,
  });

  const listen = <T>(set: Set<T>, listener: T): (() => void) => {
    set.add(listener);
    return () => set.delete(listener);
  };

  const lease = (): SecureDesktopLease => {
    const held: Lease = {
      hold: new Set(),
      change: new Set(),
      frame: new Set(),
      challenge: new Set(),
      issue: new Set(),
    };
    if (!disposed) leases.add(held);
    const holds = (): boolean => holder === held;
    return {
      installed: () => current.installed(),
      connected: () => current.connected(),
      desktop: () => current.desktop(),
      session: () => current.session(),
      locked: () => current.locked(),
      ownedElsewhere: () => holder !== null && !holds(),
      mintVideoRun: () => ++runs,
      onHold: (listener) => listen(held.hold, listener),
      setActive: (active) => setActive(held, active),
      sendInput: (command) => {
        if (!holds()) return Promise.reject(new Error(NOT_HOLDER));
        if (!granted || declared?.by !== held) return Promise.reject(new Error(NOT_GRANTED));
        return current.sendInput(command);
      },
      sendGrant: (grant) => sendGrant(held, grant),
      setVideoRun(epoch) {
        if (holds()) declare(held, epoch);
      },
      latestFrame: () => (holds() ? current.latestFrame() : null),
      onFrame: (listener) => listen(held.frame, listener),
      onDesktopChanged: (listener) => listen(held.change, listener),
      onGrantChallenge: (listener) => listen(held.challenge, listener),
      onHelperIssue: (listener) => listen(held.issue, listener),
      installState,
      requestInstall,
      ensureRunning,
      dispose() {
        if (!leases.has(held)) return;
        // The hold passes on synchronously (the async part only deactivates).
        void setActive(held, false);
        leases.delete(held);
        for (const set of [held.hold, held.change, held.frame, held.challenge, held.issue]) set.clear();
      },
    };
  };

  return {
    lease,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of detach.splice(0)) off();
      current.dispose();
      holder = null;
      declared = null;
      forgetGrants();
      waiting.clear();
      for (const held of leases) {
        for (const set of [held.hold, held.change, held.frame, held.challenge, held.issue]) set.clear();
      }
      leases.clear();
    },
  };
}
