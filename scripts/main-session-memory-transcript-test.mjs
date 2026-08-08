import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTranscriptWriter } from '../src/runtime/shared/transcript-writer.mjs';

test('an empty main-session transcript is backfilled once for the memory watcher', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-main-transcript-'));
  try {
    const writer = createTranscriptWriter({
      mixdogHome: root,
      sessionId: 'desktop-main-session',
      cwd: join(root, 'project'),
      pid: process.pid,
    });
    const messages = [
      { role: 'system', content: 'system is not conversation memory' },
      { role: 'user', content: 'existing local prompt', ts: 100 },
      { role: 'assistant', content: [{ type: 'text', text: 'existing local reply' }], ts: 200 },
      { role: 'tool', content: 'tool output is not backfilled' },
    ];
    assert.equal(writer.ensureConversationBackfill(messages), true);
    const first = readFileSync(writer.transcriptPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(first.map((row) => row.type), ['user', 'assistant']);
    assert.deepEqual(first.map((row) => row.message.content[0].text), [
      'existing local prompt',
      'existing local reply',
    ]);

    assert.equal(writer.ensureConversationBackfill([
      ...messages,
      { role: 'user', content: 'must not duplicate through backfill' },
    ]), false);
    const second = readFileSync(writer.transcriptPath, 'utf8').trim().split('\n');
    assert.equal(second.length, 2, 'a non-empty transcript remains authoritative');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
