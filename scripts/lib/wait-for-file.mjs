// Resolves when `path` exists: a directory watch armed before the first look, so the event is what ends the wait. The bound
// only names a file that never comes.
import { existsSync, watch } from 'node:fs';
import { dirname } from 'node:path';

export const waitForFile = (path, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    const finish = (error) => {
      watcher.close();
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const watcher = watch(dirname(path), () => existsSync(path) && finish());
    const timer = setTimeout(() => finish(new Error(`${path} did not appear within ${timeoutMs}ms`)), timeoutMs);
    if (existsSync(path)) finish();
  });
