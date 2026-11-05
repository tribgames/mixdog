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

export type DesktopProtocolStatus = 'ready' | 'reconnecting' | 'closed';

export interface DesktopSectionsSnapshot {
  readonly status: DesktopProtocolStatus;
  readonly entries: readonly DesktopSectionEntry[];
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
  | { readonly kind: 'replace'; readonly stage: 'commit' }
  | { readonly kind: 'status'; readonly status: DesktopProtocolStatus };

/** The only core methods a renderer may call. Each is a detail read the pushed state does not carry (stubs, history). */
export const RENDERER_PROTOCOL_METHODS = [
  'review/diff/get',
  'usage/getUsageDashboard',
  'usage/getUsageStats',
  'usage/getUsageRequests',
  'account/getOAuthProviderLoginStatus',
  'github/login/status',
  'media/getMediaJob',
  'system/ports/subscribe',
  'system/ports/unsubscribe',
  'fs/watch',
  'fs/unwatch',
] as const;
export type RendererProtocolMethod = (typeof RENDERER_PROTOCOL_METHODS)[number];

export const SECTIONS_IPC = {
  snapshot: 'mixdog:sections:snapshot',
  push: 'mixdog:sections:push',
  call: 'mixdog:protocol:call',
  /** `fs/changed` notifications for the watches this window opened. */
  fsChanged: 'mixdog:protocol:fs-changed',
  /** `login/updated`: progress of a GitHub CLI or provider sign-in (scoped feed `login:<flowId>`). */
  loginUpdated: 'mixdog:protocol:login-updated',
} as const;

export interface DesktopSectionsApi {
  snapshot(): Promise<DesktopSectionsSnapshot>;
  subscribe(listener: (push: DesktopSectionsPush) => void): () => void;
  call(method: RendererProtocolMethod, params: unknown): Promise<unknown>;
  /** `fs/changed` for this window's watches; returns the unsubscribe. */
  subscribeFsChanged(listener: (change: { watchId: string; changedPaths: string[]; kind?: string }) => void): () => void;
  /** Progress of a sign-in flow (`login/updated`); the caller filters by `flowId`. Returns the unsubscribe. */
  subscribeLoginUpdated(listener: (update: { flowId: string; state: unknown }) => void): () => void;
}

export function isRendererProtocolMethod(method: unknown): method is RendererProtocolMethod {
  return typeof method === 'string' && (RENDERER_PROTOCOL_METHODS as readonly string[]).includes(method);
}

