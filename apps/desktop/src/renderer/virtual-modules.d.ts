// Build-time module of electron.vite.config.ts (scripts/chunk-prefetch.ts):
// per name, the built files a lazy module's first import needs.
declare module 'virtual:mixdog-chunk-prefetch' {
  export const chunkFiles: Readonly<Record<string, readonly string[]>>;
}
