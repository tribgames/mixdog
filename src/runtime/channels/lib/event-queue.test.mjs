import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const previousDataDir = process.env.MIXDOG_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-event-queue-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { EventQueue } = await import('./event-queue.mjs');
after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

test('a batch tick injects low-priority events grouped by name and leaves other events queued', () => {
  const queue = new EventQueue({}, '');
  const injected = [];
  queue.setInjectHandler((chatId, name, content, options) => injected.push({ chatId, name, content, options }));
  queue.enqueue({ name: 'ci', priority: 'low', prompt: 'first' });
  queue.enqueue({ name: 'ci', priority: 'low', prompt: 'second' });
  queue.enqueue({ name: 'deploy', priority: 'low', prompt: 'solo' });
  queue.enqueue({ name: 'urgent', priority: 'normal', prompt: 'later' });

  queue.processBatch();

  assert.deepEqual(
    injected.map(({ name, options }) => [name, options.instruction]),
    [
      ['event:ci', 'Batch of 2 events:\n\n--- Event 1 ---\nfirst\n\n--- Event 2 ---\nsecond'],
      ['event:deploy', 'solo'],
    ]
  );
  const queued = readdirSync(join(dataDir, 'events', 'queue'));
  assert.equal(queued.length, 1);
  const processed = readdirSync(join(dataDir, 'events', 'processed'));
  assert.equal(processed.filter((name) => name.startsWith('batched-')).length, 3);
  assert.equal(existsSync(join(dataDir, 'events', 'in-progress')), true);
  assert.equal(readdirSync(join(dataDir, 'events', 'in-progress')).length, 0);
});
