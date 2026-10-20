import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-prompt-history-'));
const { writeRetryDelayMs, appendPromptHistory } = await import('./prompt-history-store.mjs');

test('a NUL history file is kept aside and history keeps working', async () => {
  const dir = join(process.env.MIXDOG_DATA_DIR, 'tui-prompt-history');
  const cwd = join(process.env.MIXDOG_DATA_DIR, 'proj');
  assert.deepEqual(appendPromptHistory(cwd, 'first'), ['first']);
  const stored = () => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []);
  for (let i = 0; i < 100 && stored().length === 0; i += 1) await new Promise((r) => setTimeout(r, 30));
  assert.equal(stored().length, 1, 'the write-behind flush landed');
  const file = join(dir, stored()[0]);
  const damaged = Buffer.alloc(64);
  writeFileSync(file, damaged);
  // A fresh process image has no in-memory copy and must read the file.
  const fresh = await import(`./prompt-history-store.mjs?damaged=${Date.now()}`);
  assert.deepEqual(fresh.loadPromptHistory(cwd), []);
  assert.ok(
    readdirSync(dir).some((name) => name.includes('.corrupt-') && readFileSync(join(dir, name)).equals(damaged))
  );
  assert.deepEqual(fresh.appendPromptHistory(cwd, 'second'), ['second']);
});

test('a failing history flush backs off exponentially and caps instead of retrying every window', () => {
  const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(writeRetryDelayMs);
  assert.deepEqual(delays.slice(0, 3), [500, 1000, 2000]);
  for (let i = 1; i < delays.length; i += 1) assert.ok(delays[i] >= delays[i - 1], 'never shrinks');
  assert.equal(delays.at(-1), 30_000);
  assert.ok(delays.every((delay) => delay <= 30_000));
});
