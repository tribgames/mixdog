import { performance } from 'node:perf_hooks';
import { envFlag } from './env.mjs';

// Boot-timing profiler + instrumented dynamic import. Extracted verbatim from
// mixdog-session-runtime.mjs during the facade split. `profiledImport` resolves
// relative specifiers against this module's directory (src/session-runtime/),
// which matches runtime-core.mjs, so callers keep passing the same specifiers.
const BOOT_PROFILE_ENABLED = envFlag('MIXDOG_BOOT_PROFILE');
const BOOT_PROFILE_START = globalThis.__mixdogBootProfileStart || (globalThis.__mixdogBootProfileStart = performance.now());

export function bootProfile(event, fields = {}) {
  if (!BOOT_PROFILE_ENABLED) return;
  const elapsedMs = performance.now() - BOOT_PROFILE_START;
  const parts = [`[mixdog-boot] +${elapsedMs.toFixed(1)}ms`, event];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`);
  }
  try { process.stderr.write(`${parts.join(' ')}\n`); } catch {}
}

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
