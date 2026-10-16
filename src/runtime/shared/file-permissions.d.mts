export function enforceOwnerOnlyAclWin32(targetPath: string, options?: { fresh?: boolean }): void;

export function enforceOwnerOnlyAclWin32Async(
  targetPath: string,
  options?: { fresh?: boolean }
): Promise<void>;

export function enforceOwnerOnlyDirectoryWin32Async(targetPath: string): Promise<void>;
