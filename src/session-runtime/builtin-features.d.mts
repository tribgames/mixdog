export const INSTALLABLE_BUILTIN_IDS: readonly string[];
export function builtinFeatureActive(configLike: unknown, id: string): boolean;
export function builtinInstalled(configLike: unknown, id: string): boolean;
export function featureDisallowedToolsFor(configLike: unknown, options?: {
  browserAvailable?: boolean; computerAvailable?: boolean;
}): string[];
export function setBuiltinInstalledInConfig(configLike: unknown, id: string, installed?: boolean): Record<string, unknown>;
export function withGrandfatheredBuiltins(configLike: unknown): Record<string, unknown>;
