// Regression: a failed durable save must reach the owner of the turn's cleanup, not become an unhandled rejection.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-finalize-save-failure-'));
mkdirSync(root, { recursive: true });
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { finalizePendingMessageDelivery } = await import('./pending-messages.mjs');

test('a failed durable save is reported by the delivery, also when no pending message is left to acknowledge', async (t) => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  const delivery = finalizePendingMessageDelivery({ id: 'sess_finalize_disk_full' }, [], Promise.reject(full), () => {});
  await assert.rejects(delivery, { code: 'ENOSPC' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});
