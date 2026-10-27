import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cleanupBackgroundTasks,
  completeBackgroundTask,
  registerBackgroundTask,
} from '../../../../src/runtime/shared/background-tasks.mjs';
import { modelVisibleToolCompletionMessage } from '../../../../src/runtime/shared/tool-execution-contract.mjs';
import { toolActivityBackgroundTask } from './transcript-tool-result.ts';

// A long agent report: the notification a card is built from keeps the whole
// report; only the model-visible copy is bounded.
test('a desktop completion card shows the full report while the model gets the preview', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-card-full-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const notifications = [];
  const report = [
    'Status: partial',
    ...Array.from({ length: 400 }, (_, i) => `Evidence line ${i} ${'e'.repeat(40)}`),
    'Open: card-tail',
  ].join('\n');
  try {
    registerBackgroundTask({
      taskId: 'task_agent_card',
      surface: 'agent',
      label: 'worker',
      meta: { tag: 'worker' },
      context: { callerSessionId: 'sess_card', notifyFn: (text, meta) => notifications.push({ text, meta }) },
    });
    completeBackgroundTask('task_agent_card', { result: { content: report } });
    const { text, meta } = notifications[0];
    const card = toolActivityBackgroundTask(text);
    assert.ok(card.body.includes('Evidence line 200 '), 'the omitted middle is on the card');
    assert.ok(card.body.includes('Evidence line 399 '));
    assert.ok(card.body.includes('Open: card-tail'));
    assert.ok(!card.body.includes('chars omitted'));
    const model = modelVisibleToolCompletionMessage(text, meta);
    assert.ok(model.length < text.length / 2 && !model.includes('Evidence line 200 '));
  } finally {
    cleanupBackgroundTasks({ force: true });
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
