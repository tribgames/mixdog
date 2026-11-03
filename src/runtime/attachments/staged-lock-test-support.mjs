// Test support: hold the staged-originals lock of `dataDir` from another
// process. Resolves once the lock is held; `release()` ends the holder.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function holdStagedLock(dataDir, holdMs) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./staged-lock-holder.test-helper.mjs', import.meta.url)), String(holdMs)], {
    env: { ...process.env, MIXDOG_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.once('data', () => resolve({ release: () => (child.kill(), exited) }));
    child.on('exit', () => reject(new Error('lock holder exited before holding the lock')));
  });
}
