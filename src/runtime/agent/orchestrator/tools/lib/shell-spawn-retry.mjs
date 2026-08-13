import { ensureNativeSpawnServer, tryNativeSpawn } from './native-spawn-client.mjs';

let activeShellSpawns = 0;

function isPowerShellSpawn(shell, shellArg) {
  return /pwsh|powershell/i.test(String(shell || '')) || shellArg === '-Command';
}

export async function spawnShellWithRetry({ shell, argv, spawnOptions, shellArg, cwd }) {
  const delays = [100, 300, 700];
  const isPowerShell = isPowerShellSpawn(shell, shellArg);
  activeShellSpawns++;
  try {
    await ensureNativeSpawnServer();
    let attempt = 0;
    for (;;) {
      try {
        const native = tryNativeSpawn({ shell, argv, spawnOptions, cwd });
        if (native) {
          await new Promise((resolveSpawn, rejectSpawn) => {
            const timer = setTimeout(() => {
              try { native.child.kill(); } catch {}
              rejectSpawn(Object.assign(new Error('native spawn timeout'), { code: 'ETIMEDOUT' }));
            }, 15_000);
            const onSpawn = () => {
              clearTimeout(timer);
              native.child.removeListener('error', onError);
              resolveSpawn();
            };
            const onError = (err) => {
              clearTimeout(timer);
              native.child.removeListener('spawn', onSpawn);
              rejectSpawn(err);
            };
            native.child.once('spawn', onSpawn);
            native.child.once('error', onError);
          });
          return native;
        }
        throw Object.assign(new Error('native spawn server unavailable'), {
          code: 'NATIVE_SPAWN_UNAVAILABLE',
        });
      } catch (err) {
        try {
          console.error('[shell-spawn-retry] ' + JSON.stringify({
            code: (err && err.code) || null,
            syscall: (err && err.syscall) || null,
            shell,
            cwd,
            activeSpawnCount: activeShellSpawns,
          }));
        } catch { /* logging must never mask the spawn error */ }
        const canRetry = err && err.code === 'EPERM'
          && process.platform === 'win32'
          && isPowerShell
          && attempt < delays.length;
        if (!canRetry) throw err;
        await new Promise((r) => setTimeout(r, delays[attempt++]));
      }
    }
  } finally {
    activeShellSpawns--;
  }
}
