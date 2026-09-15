import type { DesktopApi, DesktopCapability } from '../shared/contract';
import type { CommandSurface as CommandSurfaceName } from './slash-commands';

export type SurfaceApi = Pick<DesktopApi, 'invokeCapability'> &
  Partial<Pick<DesktopApi, 'getSnapshot' | 'subscribeState' | 'readCapabilities'>>;

export const LOADERS: Record<CommandSurfaceName, DesktopCapability[]> = {
  context: ['contextStatus'],
  usage: ['getUsageDashboard'],
  // What was SPENT, next to /usage's what is LEFT.
  stats: ['getUsageStats'],
  doctor: ['runDoctor'],
  // /inherit decides on the same reading the context gauge uses: a transcript
  // that no longer fits cannot be carried into a fresh session as it is.
  inherit: ['contextStatus'],
};

// The usage dashboard's first service pass probes live provider quotas and
// can take seconds. Context payloads are session-scoped, so keep a bounded LRU:
// reopening paints instantly without retaining every conversation forever.
export const SURFACE_DATA_CACHE_LIMIT = 64;

const surfaceDataCache = new Map<string, Record<string, unknown>>();
const statsDataCache = new WeakMap<SurfaceApi, Record<string, unknown>>();

export function isSurfaceCacheable(surface: CommandSurfaceName): boolean {
  return surface !== 'doctor';
}

export function readSurfaceDataCache(key: string): Record<string, unknown> | undefined {
  const retained = surfaceDataCache.get(key);
  if (!retained) return undefined;
  surfaceDataCache.delete(key);
  surfaceDataCache.set(key, retained);
  return retained;
}

export function writeSurfaceDataCache(key: string, value: Record<string, unknown>): void {
  surfaceDataCache.delete(key);
  surfaceDataCache.set(key, value);
  while (surfaceDataCache.size > SURFACE_DATA_CACHE_LIMIT) {
    const oldest = surfaceDataCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    surfaceDataCache.delete(oldest);
  }
}

export function clearSurfaceDataCache(): void {
  surfaceDataCache.clear();
}

export function surfaceDataCacheSize(): number {
  return surfaceDataCache.size;
}

export function getStatsDataCache(api: SurfaceApi): Record<string, unknown> | undefined {
  return statsDataCache.get(api);
}

export function setStatsDataCache(api: SurfaceApi, value: Record<string, unknown>): void {
  statsDataCache.set(api, value);
}

export function hasStatsDataCache(api: SurfaceApi): boolean {
  return statsDataCache.has(api);
}

