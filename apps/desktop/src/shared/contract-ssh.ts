// "SSH server" connections: the saved servers, the host-key check made before
// the first connection, and the outcomes the connect dialog turns into views.

export type DesktopSshPhase = 'connect' | 'check' | 'install' | 'start' | 'ready';

/** What a saved server remembers besides its name and address. */
export interface DesktopSshHostSettings {
  /** Server folder the session opens in: `~`, `~/x` or an absolute server path. */
  remoteCwd?: string;
  /** Private key file on this PC (passed to ssh with `-i`). */
  identityFile?: string;
  /** Re-dial the tunnel when it drops; on unless false. */
  autoReconnect?: boolean;
  /** Model providers this server may use through this PC; null or absent: every provider enabled on this PC. */
  allowedProviders?: string[] | null;
  /** Minutes the server keeps its work after the connection drops (1–10080, default 30). */
  graceMinutes?: number;
}

/** A saved SSH server. `open` is true while its server window is open. */
export interface DesktopSshHost {
  id: string;
  name: string;
  /** `alias`, `host`, `user@host` or `user@host:port`. */
  target: string;
  lastConnectedAt: number | null;
  open: boolean;
  settings?: DesktopSshHostSettings;
}

/** A `Host` alias of this PC's ~/.ssh/config; `detail` is `user@host[:port]`. */
export interface DesktopSshConfigHost {
  alias: string;
  detail: string;
}

/** One server on the way to the target (a ProxyJump hop, then the target itself). */
export interface DesktopSshHopKey {
  name: string;
  role: 'jump' | 'target';
  /** pending: not read yet — it is only reachable through a hop that is not trusted yet. */
  status: 'trusted' | 'unknown' | 'changed' | 'revoked' | 'unreadable' | 'pending';
  fingerprint?: string;
  keyType?: string;
}

/** What `ssh -G` resolves the address to. */
export interface DesktopSshConfigSummary {
  hostName: string;
  user: string | null;
  port: number;
  proxyJump: string | null;
  /** A ProxyCommand is configured (its text is not shown). */
  proxyCommand: boolean;
  /** Only when Mixdog could not set them aside: the LocalForward / RemoteForward / DynamicForward lines of the user's ssh config that will apply while connected. */
  forwards?: string[];
}

/** What the server's key looks like against this PC's known_hosts. `hops` is set
 *  when the connection goes through a jump host: every key on the way. */
export type DesktopSshHostKeyCheck =
  | { status: 'trusted'; authority?: string; hops?: DesktopSshHopKey[] }
  | { status: 'unknown'; fingerprint: string; keyType: string; hops?: DesktopSshHopKey[] }
  | {
      status: 'changed';
      previous: string;
      current: string;
      keyType: string;
      /** The name to type to confirm replacing the key. */
      host: string;
      /** The exact command that forgets the old key. */
      removeCommand: string;
      /** The old key is in Mixdog's own known_hosts, so Mixdog may replace it; false: only the command above does. */
      replaceable: boolean;
      hops?: DesktopSshHopKey[];
    }
  | { status: 'revoked'; fingerprint: string; host: string }
  | { status: 'unreachable'; message: string; sshMissing?: { command: string | null } };

/** State of the ssh-agent on this PC, for the login guidance. */
export interface DesktopSshAgentStatus {
  state: 'running' | 'empty' | 'stopped' | 'disabled' | 'missing' | 'unknown';
  /** Commands that bring the agent up and load a key, when there is something to run. */
  command?: string;
}

/** Why a connection stopped; each kind has its own guidance view. */
export type DesktopSshFailure = DesktopSshFailureKind & {
  /** The error code behind the view (a bootstrap code such as `install-failed`, or the view's own name); shown in the details line. */
  code?: string;
};

type DesktopSshFailureKind =
  | { kind: 'host-key-changed'; previous?: string; current?: string }
  | { kind: 'host-key-revoked' }
  /** The key shown was saved, and a server further along the jump chain now needs its own check. */
  | { kind: 'host-key-next' }
  | { kind: 'auth'; keygen: string; register: string; agent?: DesktopSshAgentStatus }
  | { kind: 'ssh-missing'; command: string | null }
  | { kind: 'unsupported-platform'; message: string }
  | { kind: 'install-failed'; message: string }
  | { kind: 'install-locked' }
  /** The server's Mixdog speaks another protocol version: reconnecting reinstalls the matching one. */
  | { kind: 'protocol-mismatch'; message: string }
  /** An unexpected error inside Mixdog (bootstrap/protocol), not something the user's server setup caused. */
  | { kind: 'internal'; message: string }
  /** The login shell or home directory of the server answered in a way the bootstrap cannot use. */
  | { kind: 'remote-shell'; message: string }
  | { kind: 'daemon-busy'; message: string }
  | { kind: 'port-unavailable'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'node'; reason: 'missing' | 'too-old'; found: string | null; required: number; command: string }
  | { kind: 'npm-missing'; command: string }
  | { kind: 'deps-install'; message: string }
  | { kind: 'daemon-stop' | 'daemon-replace' | 'daemon-unproven'; message: string }
  /** The server's own (non-desktop) Mixdog is in the way, or another daemon holds the data folder: it is left running and there is nothing to restart. */
  | { kind: 'daemon-unmanaged' | 'daemon-data-in-use'; message: string }
  | { kind: 'daemon-running'; pid: number }
  | { kind: 'failed'; message: string };

export type DesktopSshConnectResult = { ok: true; host: DesktopSshHost } | { ok: false; failure: DesktopSshFailure };

/** The host-key pre-check of one address. `attemptId` is minted by main and
 *  bound to the asking window: connecting, cancelling and stopping a daemon
 *  all name it, and main connects only to the address and key it inspected. */
export interface DesktopSshInspection {
  attemptId: string;
  check: DesktopSshHostKeyCheck;
  summary?: DesktopSshConfigSummary;
}

export interface DesktopSshConnectRequest {
  /** From `sshInspectHostKey`; also pairs the progress events with this call. */
  attemptId: string;
  /** The user confirmed the fingerprint `sshInspectHostKey` reported: save that key first. */
  trustHostKey?: boolean;
  /** Replace the changed key: the server name typed to confirm (must equal the name `check.host` showed). */
  replaceHostKey?: string;
  /** The user accepted the forwards listed in the inspection summary. */
  acceptForwards?: boolean;
  /** Entered in the connect dialog's advanced options: used for this attempt and saved with the server. Validated like the per-server settings. */
  settings?: Pick<DesktopSshHostSettings, 'identityFile' | 'remoteCwd'>;
  /** Stop whatever daemon runs on the server and start this app's (after the user confirmed). */
  forceRestart?: boolean;
}

/** A question from ssh (passphrase, password, one-time code) for the user; `close` withdraws it. */
export interface DesktopSshAskpass {
  /** The connect attempt or cleanup the question belongs to. */
  attemptId: string;
  requestId: string;
  kind: 'passphrase' | 'password' | 'otp' | 'other' | 'close';
  /** The server the question comes from, shown above text the server supplied. */
  host?: string;
  /** The prompt exactly as ssh printed it. */
  prompt: string;
  /** The previous answer was refused. */
  retry: boolean;
  timeoutMs: number;
}

/** The connection log of one server (ring buffer, secrets removed). `copyText` is the same text with the server's user and host replaced by <server>. */
export interface DesktopSshLogView {
  lines: string[];
  copyText: string;
}

/** The tail of the server's daemon.log, fetched over ssh. */
export type DesktopSshServerLog = { ok: true; text: string; copyText: string } | { ok: false; message: string };

export interface DesktopSshCleanupRequest {
  /** The window's own id for this run; its questions arrive with it as `attemptId`. */
  operationId: string;
  /** Also delete the server's work history. */
  removeUserData: boolean;
  /** Forget the saved entry afterwards. */
  forget: boolean;
}

/** Where a server cleanup is: reaching the server, stopping its daemon, removing the files. */
export interface DesktopSshCleanupProgress {
  operationId: string;
  phase: 'connect' | 'stop' | 'remove' | 'done';
  detail?: string;
}

export type DesktopSshCleanupResult =
  | { ok: true; hosts: DesktopSshHost[]; detail?: string }
  | { ok: false; failure: DesktopSshFailure };

export interface DesktopSshProgress {
  attemptId: string;
  phase: DesktopSshPhase;
  detail?: string;
}
