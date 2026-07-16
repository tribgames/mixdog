import { spawn } from 'node:child_process';

let activeShellSpawns = 0;

function isPowerShellSpawn(shell, shellArg) {
  return /pwsh|powershell/i.test(String(shell || '')) || shellArg === '-Command';
}

export async function spawnShellWithRetry({ shell, argv, spawnOptions, shellArg, cwd }) {
  const delays = [100, 300, 700];
  const isPowerShell = isPowerShellSpawn(shell, shellArg);
  activeShellSpawns++;
  try {
    let attempt = 0;
    for (;;) {
      try {
        const child = spawn(shell, argv, spawnOptions);
        let bufferedError = null;
        const guardError = (err) => { bufferedError = bufferedError || err; };
        child.on('error', guardError);
        try {
          await new Promise((resolveSpawn, rejectSpawn) => {
            const onSpawn = () => {
              child.removeListener('error', onError);
              resolveSpawn();
            };
            const onError = (err) => {
              child.removeListener('spawn', onSpawn);
              rejectSpawn(err);
            };
            child.once('spawn', onSpawn);
            child.once('error', onError);
          });
        } catch (err) {
          child.removeListener('error', guardError);
          throw err;
        }
        return {
          child,
          adoptErrorHandler(handler) {
            child.on('error', handler);
            child.removeListener('error', guardError);
            if (bufferedError) handler(bufferedError);
          },
        };
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
