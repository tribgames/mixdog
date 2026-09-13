import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createGoalRuntime } from './goal-runtime.mjs';

test('a title queued behind an accepted task write cannot commit after runtime close', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-title-close-'));
  const generated = Promise.withResolvers();
  const writeStarted = Promise.withResolvers();
  const writeGate = Promise.withResolvers();
  let writes = 0;
  let pending = null;
  const runtime = createGoalRuntime({
    dataDir,
    deadlineWarningMs: [],
    generateTitle: () => generated.promise,
    writeGoalRecord: async (path, record) => {
      writes += 1;
      if (writes === 2) {
        writeStarted.resolve();
        await writeGate.promise;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(record));
    },
  });
  try {
    const created = await runtime.control('session-title', {
      action: 'create', objective: 'Original objective',
    });
    pending = runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [{ text: 'Accepted task update', status: 'in_progress', kind: 'work' }],
    }, { sessionId: 'session-title' });
    await writeStarted.promise;
    generated.resolve('Generated title');
    await new Promise(setImmediate);
    let drained = false;
    const closed = Promise.resolve(runtime.close()).then(() => { drained = true; });
    await new Promise(setImmediate);
    assert.equal(drained, false, 'accepted persistence must finish before close resolves');
    writeGate.resolve();
    await Promise.all([pending, closed]);
    await new Promise(setImmediate);
    const stored = JSON.parse(readFileSync(join(dataDir, 'goals', 'session-title.json'), 'utf8')).goal;
    assert.equal(stored.title, created.goal.title);
    assert.equal(stored.tasks[0].text, 'Accepted task update');
    assert.equal(writes, 2);
  } finally {
    writeGate.resolve();
    await pending?.catch(() => {});
    await runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
