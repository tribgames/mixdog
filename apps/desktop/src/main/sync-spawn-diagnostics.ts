import { join } from 'node:path';

const SLOW_SYNC_SPAWN_MS = 150;
const SPAWN_NAMES = ['spawnSync', 'execSync', 'execFileSync'] as const;

/** Perf triage (MIXDOG_DESKTOP_PERF=1): any synchronous child process spawned
 *  on the MAIN thread freezes the event loop (timers, IPC, transitions) for its
 *  full runtime while showing near-zero CPU. Attributes every long sync spawn
 *  to its caller in `desktop-perf.log` under the profile directory. */
export function installSyncSpawnDiagnostics(userDataPath: () => string): void {
  void (async () => {
    // ESM namespace exports are read-only; patch the mutable CJS exports object.
    // Two awaited imports defer the patching past the startup turn that requested it.
    const { createRequire } = await import('node:module');
    const { appendFile } = await import('node:fs/promises');
    const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
    let writeQueue: Promise<void> = Promise.resolve();
    const wrap = <K extends (typeof SPAWN_NAMES)[number]>(name: K) => {
      const original = (cp as Record<K, (...values: unknown[]) => unknown>)[name];
      const wrapped = (...values: unknown[]) => {
        const started = Date.now();
        try {
          return original(...values);
        } finally {
          const ms = Date.now() - started;
          if (ms >= SLOW_SYNC_SPAWN_MS) {
            const caller = (new Error().stack || '')
              .split('\n')
              .slice(2, 5)
              .map((line) => line.trim())
              .join(' <- ');
            const entry = `${new Date().toISOString()} main-sync-spawn ${name} ms=${ms} cmd=${String(values[0] ?? '')} by=${caller}\n`;
            writeQueue = writeQueue
              .then(() => appendFile(join(userDataPath(), 'desktop-perf.log'), entry))
              .catch(() => {
                /* diagnostics only */
              });
          }
        }
      };
      try {
        (cp as Record<K, (...values: unknown[]) => unknown>)[name] = wrapped;
        return true;
      } catch {
        // Electron/Vite can expose a read-only ESM namespace here even through
        // createRequire. Diagnostics must never reject desktop startup.
        return false;
      }
    };
    const installed = SPAWN_NAMES.map(wrap).some(Boolean);
    if (!installed) console.warn('Mixdog desktop sync-spawn diagnostics disabled: exports are read-only.');
  })().catch((error) => {
    console.warn('Mixdog desktop sync-spawn diagnostics disabled:', error instanceof Error ? error.name : 'Error');
  });
}
