// A staged working-folder change (system prompt untouched, tail notice
// pending) is applied by the next compaction: the compacted transcript breaks
// the prompt cache anyway, so the system prompt re-roots at the current
// folder there and the notice is no longer due.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runPreSendCompactPass } from './pre-send-compact.mjs';
import { runSessionCompaction } from './manager/compaction-runner.mjs';
import { refreshSessionWorkspaceContext, snapshotPendingWorkspaceNotice } from './manager/prompt-utils.mjs';

const SEP = '\n\n---\n\n';
const OLD_CORE = `# Role${SEP}# Instruction Files\n\n## C:/old/AGENTS.md\n\nold rule`;
const OLD_ENV = '- Cwd: C:/old — the active Project root; relative paths and shell commands resolve here.';
const NEXT = {
  cwd: 'C:/new',
  environmentContext: '- Cwd: C:/new — the active Project root; relative paths and shell commands resolve here.',
  instructionFilesContext: '# Instruction Files\n\n## C:/new/AGENTS.md\n\nnew rule',
};
const NEW_CORE = `# Role${SEP}${NEXT.instructionFilesContext}`;

function isolatedData(t) {
  const previous = process.env.MIXDOG_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'mixdog-workspace-reroot-'));
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

function stagedWorker(id) {
  const session = {
    id,
    owner: 'agent',
    provider: 'reroot-test',
    model: 'reroot-test',
    contextWindow: 40_000,
    compaction: {},
    lastProviderSendAt: Date.now() - 6 * 60_000,
    bp3EnvSplit: true,
    bp3CoreContext: OLD_CORE,
    bp3EnvironmentContext: OLD_ENV,
    messages: [
      { role: 'system', content: 'Preserve instructions.' },
      { role: 'system', content: OLD_CORE, cacheTier: 'tier3' },
      { role: 'system', content: OLD_ENV, cacheTier: 'env' },
      { role: 'user', content: 'Continue the approved task.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'read-1', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'read-1', content: 'Original recoverable output.\n'.repeat(4_000) },
    ],
  };
  const before = JSON.stringify(session.messages.slice(0, 3));
  refreshSessionWorkspaceContext(session, NEXT);
  assert.equal(JSON.stringify(session.messages.slice(0, 3)), before, 'staged: the system prompt is untouched');
  assert.match(snapshotPendingWorkspaceNotice(session).content, /now C:\/new\.[\s\S]*new rule/);
  return session;
}

function assertRerooted(messages) {
  const system = messages.filter((message) => message.role === 'system');
  assert.equal(system.find((message) => message.cacheTier === 'tier3').content, NEW_CORE);
  assert.equal(system.find((message) => message.cacheTier === 'env').content, NEXT.environmentContext);
}

test('a pre-send compaction re-roots the staged prompt in the turn transcript and the session', async (t) => {
  isolatedData(t);
  const session = stagedWorker('reroot-pre-send');
  const outgoing = session.messages.slice();
  const result = await runPreSendCompactPass({
    sessionRef: session,
    sessionId: session.id,
    messages: outgoing,
    requestTools: [],
    opts: { cacheStrategy: { messages: '5m' } },
  });
  assert.equal(result.compactChanged, true);
  assertRerooted(outgoing);
  assertRerooted(session.messages);
  assert.equal(session.bp3CoreContext, NEW_CORE);
  assert.equal(session.workspaceReroot, undefined);
  assert.equal(snapshotPendingWorkspaceNotice(session), null, 'the re-rooted prompt needs no notice');
});

test('a session compaction re-roots the staged prompt and drops the notice', async (t) => {
  isolatedData(t);
  const session = stagedWorker('reroot-manual');
  const result = await runSessionCompaction(session, { mode: 'manual', config: {} });
  assert.equal(result.changed, true);
  assertRerooted(session.messages);
  assert.equal(session.workspaceReroot, undefined);
  assert.equal(snapshotPendingWorkspaceNotice(session), null);
});
