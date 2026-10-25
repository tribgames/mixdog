export type CacheWarmTarget = 'scheduled' | 'bot-chats' | 'bot-rooms' | 'favorites' | 'conversations';
export const CACHE_WARM_TARGETS: readonly CacheWarmTarget[];
export const CACHE_WARM_IDLE_TARGETS: readonly CacheWarmTarget[];
export const DEFAULT_CACHE_WARM_TARGETS: readonly CacheWarmTarget[];
export function normalizeCacheWarmTargets(value: unknown): CacheWarmTarget[];
export function parseCacheWarmTargetsEnv(text: unknown): CacheWarmTarget[] | null;
export function resolveCacheWarmTargets(
  config: { cacheWarming?: unknown } | null | undefined,
  env?: Record<string, string | undefined>
): CacheWarmTarget[];
