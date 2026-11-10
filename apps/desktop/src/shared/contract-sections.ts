// Pushed state in the renderer (desktop-services.md §2, §15). Electron main owns the one protocol connection
// per target; the renderer holds a read-only mirror of its section store and asks the core for detail through
// a closed list of methods. Nothing here is polled.

/** One `(section, key)` of the store; the shape of `@mixdog/protocol-client`'s `SectionEntry`. */
export interface DesktopSectionEntry {
  readonly section: string;
  readonly key: string | null;
  readonly revision: number;
  readonly value: unknown;
}

/** Every section of the protocol's closed registry (`SectionName`); main's open-core.ts fails to compile when the
 *  registry grows past this list. Also the list the phone reads its fold store with. */
export const SECTION_NAMES = [
  'config', 'projects', 'agentPool', 'agents', 'botOrder', 'presets', 'modelCatalog', 'workflows', 'webSearch', 'toolModules',
  'providerSetup', 'providerAccounts', 'usage', 'hostShellJobs', 'terminalActivity', 'terminalTabs', 'remote',
  'notice', 'update', 'hostState', 'computer', 'approvalInbox', 'core', 'coreHealth', 'migration', 'reviewDiff',
  'gitStatus', 'lspStatus', 'lspDiagnostics', 'mediaJobs', 'ports',
] as const;

/** Sections that are a tell, not state (Node's `turn-review-changed` desktop event): a change notifies the listeners that
 *  are there when it happens. A store never takes one from a snapshot or a whole-store replace, so a window that attaches
 *  later, or a reconnect of the core, does not make a listener act on a tell it was not there for. */
export const EVENT_SECTIONS: readonly string[] = ['reviewDiff'];

export type DesktopProtocolStatus = 'ready' | 'reconnecting' | 'closed';

export interface DesktopSectionsSnapshot {
  readonly status: DesktopProtocolStatus;
  readonly entries: readonly DesktopSectionEntry[];
  /** The core's app feed these entries are of (see the commit push's `epoch`). */
  readonly epoch?: string;
}

/** `entry: null` removes the `(section, key)`. */
export interface DesktopSectionChange {
  readonly section: string;
  readonly key: string | null;
  readonly entry: DesktopSectionEntry | null;
}

export type DesktopSectionsPush =
  /** Changes of one flush. */
  | { readonly kind: 'sections'; readonly changes: readonly DesktopSectionChange[] }
  /** The complete store after a reconnect (an app snapshot was folded), in budgeted chunks so no turn carries all of
   *  it: `begin`, any number of `chunk`s, then `commit`, when the window swaps the staged store in at once and drops
   *  whatever the staged store lacks. Changes made after `begin` follow the commit as ordinary `sections` pushes. */
  | { readonly kind: 'replace'; readonly stage: 'begin' }
  | { readonly kind: 'replace'; readonly stage: 'chunk'; readonly entries: readonly DesktopSectionEntry[] }
  /** `epoch`: the core's app feed the store comes from (a restarted core has another), so a store can tell a reconnect to the same core from one to a restarted core. */
  | { readonly kind: 'replace'; readonly stage: 'commit'; readonly epoch?: string }
  /** A scoped feed the window watches could not be restored after a reconnect, for a reason other than the core not
   *  holding it (that one is a removal of its sections). Its held sections stay. */
  | { readonly kind: 'feedError'; readonly feedId: string; readonly message: string }
  | { readonly kind: 'status'; readonly status: DesktopProtocolStatus };

/** The only core methods a renderer may call. Each is a detail read the pushed state does not carry (stubs, history). */
export const RENDERER_PROTOCOL_METHODS = [
  'review/diff/get',
  // Recomputes the `providerSetup` section (the `force`/`refresh`/keychain options of `getProviderSetup`).
  'account/refreshProviderSetup',
  'usage/getUsageDashboard',
  'usage/getUsageStats',
  'usage/getUsageRequests',
  'account/getOAuthProviderLoginStatus',
  'github/login/status',
  'media/getMediaJob',
  // A scoped feed that carries sections (`SCOPED_SECTION_FEED_PREFIXES`); main folds what it delivers into the mirror.
  'feed/subscribe',
  'feed/unsubscribe',
  'system/ports/subscribe',
  'system/ports/unsubscribe',
  'fs/watch',
  'fs/unwatch',
] as const;
/** The scoped feeds a window may watch for their sections (`media:<jobId>` carries section `mediaJobs`). */
export const SCOPED_SECTION_FEED_PREFIXES = ['media:'] as const;
export const isScopedSectionFeed = (feedId: unknown): feedId is string =>
  typeof feedId === 'string' && SCOPED_SECTION_FEED_PREFIXES.some((prefix) => feedId.startsWith(prefix));
export type RendererProtocolMethod = (typeof RENDERER_PROTOCOL_METHODS)[number];

export const SECTIONS_IPC = {
  /** Whether this window's connection has a core endpoint (the per-connection source of the replaced session capabilities). */
  core: 'mixdog:sections:core',
  snapshot: 'mixdog:sections:snapshot',
  push: 'mixdog:sections:push',
  call: 'mixdog:protocol:call',
  /** `fs/changed` notifications for the watches this window opened. */
  fsChanged: 'mixdog:protocol:fs-changed',
  /** `login/updated`: progress of a GitHub CLI or provider sign-in (scoped feed `login:<flowId>`). */
  loginUpdated: 'mixdog:protocol:login-updated',
  /** A sign-in flow's feed was lost (it could not be subscribed, or the link to the core went down). */
  loginFeedLost: 'mixdog:protocol:login-feed-lost',
  /** What the connection holds of a sign-in flow's feed: its last state and whether it was lost. */
  loginFeed: 'mixdog:protocol:login-feed',
} as const;

export interface DesktopSectionsApi {
  /** True when this window's connection has a core endpoint; false on a Node-hosted connection. */
  core(): Promise<boolean>;
  snapshot(): Promise<DesktopSectionsSnapshot>;
  subscribe(listener: (push: DesktopSectionsPush) => void): () => void;
  call(method: RendererProtocolMethod, params: unknown): Promise<unknown>;
  /** `fs/changed` for this window's watches; returns the unsubscribe. */
  subscribeFsChanged(listener: (change: { watchId: string; changedPaths: string[]; kind?: string }) => void): () => void;
  /** Progress of a sign-in flow (`login/updated`); the caller filters by `flowId`. Returns the unsubscribe. */
  subscribeLoginUpdated(listener: (update: { flowId: string; state: unknown }) => void): () => void;
  /** The flow's feed can no longer deliver (`flowId`); its progress will not arrive. Returns the unsubscribe. */
  subscribeLoginFeedLost(listener: (update: { flowId: string }) => void): () => void;
  /** The last state a sign-in flow's feed delivered and whether it was lost: read once after listening, so what came
   *  before the listener is not missed. A flow the connection does not follow is lost. */
  loginFeed(flowId: string): Promise<{ state: unknown; lost: boolean }>;
}

export function isRendererProtocolMethod(method: unknown): method is RendererProtocolMethod {
  return typeof method === 'string' && (RENDERER_PROTOCOL_METHODS as readonly string[]).includes(method);
}

