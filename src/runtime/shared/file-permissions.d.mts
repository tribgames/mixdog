export function enforceOwnerOnlyAclWin32(targetPath: string, options?: { fresh?: boolean }): void;

/** Test hook: the live per-process ACL helper, or null. */
export function ownerOnlyAclHelperForTests(): import('node:child_process').ChildProcess | null;

/** Test/diagnostic hook: helper attachment, pending requests, starts in the restart window. */
export function ownerOnlyAclHelperStats(): {
  alive: boolean;
  pid: number | null;
  pending: number;
  recentStarts: number;
};

/** Non-fresh calls verify (and tighten) the real DACL on every call through a shared helper. */
export function enforceOwnerOnlyAclWin32Async(targetPath: string, options?: { fresh?: boolean }): Promise<void>;

export function enforceOwnerOnlyDirectoryWin32Async(targetPath: string): Promise<void>;

/** Test hook: synchronous calls skip the sync bridge and use the one-shot update. */
export function disableOwnerOnlyAclSyncBridgeForTests(): void;

/** Starts this thread's ACL helper and the sync bridge off any write path. Never rejects. */
export function prewarmOwnerOnlyAclWin32(options?: { bridge?: boolean }): Promise<void>;
