export const SERVER_MANIFEST_FILE: 'servers.json';
export const SERVER_PLATFORM_TARGETS: Readonly<Record<string, string>>;
export const CORE_PLATFORM_TARGETS: Readonly<Record<string, string>>;
export function manifestBuild(
  binaries: Readonly<Record<string, { sha256: string; bundle?: { content: string } }>>
): string;
