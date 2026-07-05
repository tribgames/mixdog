// Thin re-export facade — re-exports all cache symbols from their split modules.
// Existing import paths keep working unchanged.
export * from './cache/read-cache.mjs';
export * from './cache/scoped-cache.mjs';
export * from './cache/prefetch-cache.mjs';
export * from './cache/post-edit-marks.mjs';
