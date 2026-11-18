// Types for the vendored Node file core-src/runtime/shared/runtime-root.mjs, which has no declaration of its own.
declare module '*/runtime/shared/runtime-root.mjs' {
  export function resolveRuntimeRoot(): string;
  /** Creates the runtime root owner-only (as the core does at its start, which tolerates finding it there). */
  export function ensurePrivateRuntimeRoot(root?: string): string;
}
