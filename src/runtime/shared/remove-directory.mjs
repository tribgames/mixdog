import { rm } from 'node:fs/promises';

export const REMOVE_RETRY_MS = 100;
const REMOVE_ATTEMPTS = 6;
const RETRYABLE_REMOVE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

/**
 * Removes a private scratch folder. A process that just exited can still hold
 * its files for a moment on Windows, so a busy folder is retried briefly; a
 * failure that persists is logged (never swallowed) and does not throw.
 */
export async function removeDirectoryWithRetry(
  dir,
  { remove = rm, log = (line) => process.stderr.write(line), retryMs = REMOVE_RETRY_MS } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await remove(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= REMOVE_ATTEMPTS || !RETRYABLE_REMOVE_CODES.has(error?.code)) {
        log(`scratch folder ${dir} could not be removed: ${error?.message || error}\n`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs * attempt));
    }
  }
}
