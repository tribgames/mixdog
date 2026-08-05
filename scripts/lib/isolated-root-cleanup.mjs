// Isolated-root test hygiene. A session engine spawns its OWN memory runtime
// (Postgres + embeddings) under the root it was given, and a hard-killed daemon
// cannot reap it. Tests that use a throwaway root call this so a run can never
// leave a live cluster behind pointing at a deleted directory.
import { spawnSync } from 'node:child_process';

export function killProcessesUnder(root) {
  if (!root) return;
  if (process.platform === 'win32') {
    const escaped = String(root).replace(/'/g, "''");
    spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${escaped}*' } `
      + '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    ], { stdio: 'ignore' });
    return;
  }
  spawnSync('bash', ['-lc', `pkill -f ${JSON.stringify(root)} || true`], { stdio: 'ignore' });
}
