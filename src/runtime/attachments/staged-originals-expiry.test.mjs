// Abandoned staged originals must expire on the daemon's own schedule: nothing
// else is staged after the first original, so only the timer armed by
// startAttachmentGc can remove it.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

const dataDir = makeTempDirSync('staged-originals-expiry');
process.env.MIXDOG_DATA_DIR = dataDir;

const { attachmentFilePath, startAttachmentGc } = await import('./store.mjs');
const { STAGED_ORIGINALS_TTL_MS, stageOriginalAttachment } = await import('./staged-originals.mjs');

// Real-time wait (setImmediate and performance.now stay unmocked) for the async prune's file I/O.
const settle = async (ms) => {
  const until = performance.now() + ms;
  while (performance.now() < until) await new Promise((resolve) => setImmediate(resolve));
};

test('daemon start expires an abandoned staged original within about the TTL with nothing else staged', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { attachmentRef } = await stageOriginalAttachment(Buffer.alloc(64, 7));
  const indexFile = join(dataDir, 'prompt-attachments', 'staged-originals.json');
  assert.equal(existsSync(attachmentFilePath(attachmentRef)), true);

  startAttachmentGc();
  await settle(50); // the dynamic import arms the prune timer

  // Stay clear of the 6-hourly census: only the staged-originals timer may act.
  const step = STAGED_ORIGINALS_TTL_MS / 4;
  for (let elapsed = 0; elapsed <= STAGED_ORIGINALS_TTL_MS + step; elapsed += step) {
    mock.timers.tick(step);
    await settle(50);
  }

  assert.equal(existsSync(attachmentFilePath(attachmentRef)), false, 'blob removed');
  assert.deepEqual(JSON.parse(readFileSync(indexFile, 'utf8')), [], 'entry removed');
});

