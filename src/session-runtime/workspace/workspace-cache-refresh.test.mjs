import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { refreshWorkspacePrompt } from './transitions.mjs';
import {
  clearReadDedupSession,
  setReadCached,
  tryReadCached,
} from '../../runtime/agent/orchestrator/session/cache/read-cache.mjs';
import {
  setScopedToolCached,
  tryScopedToolCached,
} from '../../runtime/agent/orchestrator/session/cache/scoped-cache.mjs';
import { snapshotPendingWorkspaceNotice } from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';

test('workspace refresh drops session file/search observations without clearing another session or conversation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mixdog-workspace-cache-'));
  const ids = ['workspace-cache-moving', 'workspace-cache-staying'];
  try {
    writeFileSync(join(cwd, 'sample.txt'), 'original\n');
    const read = { cwd, args: { file_path: 'sample.txt' } };
    const search = { cwd, toolName: 'glob', args: { pattern: '*.txt' } };
    for (const sessionId of ids) {
      setReadCached({ ...read, sessionId, content: 'original\n' });
      setScopedToolCached({ ...search, sessionId, content: 'sample.txt' });
      assert.ok(tryReadCached({ ...read, sessionId }));
      assert.ok(tryScopedToolCached({ ...search, sessionId }));
    }
    const messages = [{ role: 'user', content: 'Continue the agreed task.' }];
    const session = { id: ids[0], cwd, messages, skipInstructionFiles: true };
    await refreshWorkspacePrompt(session, cwd);
    assert.equal(session.messages, messages);
    assert.equal(tryReadCached({ ...read, sessionId: ids[0] }), null);
    assert.equal(tryScopedToolCached({ ...search, sessionId: ids[0] }), null);
    assert.ok(tryReadCached({ ...read, sessionId: ids[1] }));
    assert.ok(tryScopedToolCached({ ...search, sessionId: ids[1] }));
    assert.match(snapshotPendingWorkspaceNotice(session).content, /re-read the files needed for the next edit/);
  } finally {
    ids.forEach(clearReadDedupSession);
    rmSync(cwd, { recursive: true, force: true });
  }
});
