import { performance } from 'node:perf_hooks';
import { createBootProfiler } from '../runtime/shared/boot-profile.mjs';

// Session-runtime boot profiler + instrumented dynamic import. `profiledImport`
// resolves relative specifiers against this module's directory
// (src/session-runtime/), which matches runtime-core.mjs, so callers keep
// passing the same specifiers.
export const bootProfile = createBootProfiler();

export async function profiledImport(label, spec, { optional = false } = {}) {
  const startedAt = performance.now();
  try {
    const mod = await import(spec);
    bootProfile(`import:${label}`, { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  } catch (error) {
    bootProfile(`import:${label}:failed`, {
      ms: (performance.now() - startedAt).toFixed(1),
      error: error?.message || String(error),
    });
    if (optional) return null;
    throw error;
  }
}
