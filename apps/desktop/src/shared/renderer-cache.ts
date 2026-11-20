/** The renderer caches the main process keeps (main/ipc-renderer-cache.ts): the sidebar's session catalog for the
 *  first paint, and the transcript's measured row heights. A name is the cache's file: a cache whose text carries no
 *  version of its own is versioned here. */
export const RENDERER_CACHE_NAMES = ['session-catalog', 'transcript-row-heights-v2'] as const;

export type RendererCacheName = (typeof RENDERER_CACHE_NAMES)[number];

export const isRendererCacheName = (value: unknown): value is RendererCacheName =>
  (RENDERER_CACHE_NAMES as readonly unknown[]).includes(value);
