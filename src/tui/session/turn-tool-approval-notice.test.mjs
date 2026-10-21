import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataRoot = mkdtempSync(join(tmpdir(), 'turn-approval-notice-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const { setConnectorToolPermissionWriter } = await import('../../runtime/agent/orchestrator/mcp/agent-connectors.mjs');
const { ALLOW_NOT_SAVED_NOTICE, applyConnectorApproval } = await import(
  '../../runtime/agent/orchestrator/session/loop/tool-exec/before-hook.mjs'
);
const { createNoticeSurface } = await import('./notice-surface.mjs');
const { toolHandlers } = await import('./turn.mjs');

// A bot whose connector tool asks before it runs.
mkdirSync(join(dataRoot, 'agents', 'mailer'), { recursive: true });
writeFileSync(join(dataRoot, 'agents', 'mailer', 'AGENT.md'), '---\nkind: bot\n---\nYou are mailer.\n');
writeFileSync(
  join(dataRoot, 'agents', 'mailer', 'agent.json'),
  JSON.stringify({ name: 'mailer', connectors: { off: [], tools: { alpha: { write_it: 'needs_approval' } } } })
);

function sessionSurface() {
  let state = { items: [], toasts: [], progressHint: null };
  const surface = createNoticeSurface({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      return true;
    },
    isDisposed: () => false,
    pushItem: (item) => {
      state = { ...state, items: [...state.items, item] };
    },
    replaceItems: (items) => items,
  });
  return { surface, state: () => state };
}

// The desktop's toast region draws only the host-level snapshot's toasts; a pane reads its own
// session lane (items), so the word to the person has to land in the session's transcript.
test('an always-allow that could not be saved leaves a notice row in the answering session', async () => {
  const { surface, state } = sessionSurface();
  const { notice } = toolHandlers({ isCurrentTurn: () => true, ...surface }).onToolApproval;
  assert.equal(typeof notice, 'function');
  setConnectorToolPermissionWriter(async () => {
    throw new Error('agent.json is not writable');
  });
  try {
    const hook = Object.assign(async () => ({ approved: true, response: 'approve', remember: 'agent' }), { notice });
    const outcome = await applyConnectorApproval(
      { name: 'mcp__alpha__write_it', args: {}, cwd: '/tmp' },
      { agentId: 'mailer', callerSessionId: 'sess_home_mailer', executeOpts: {}, toolApprovalHook: hook }
    );
    assert.equal(outcome, null, 'the call still runs once');
  } finally {
    setConnectorToolPermissionWriter(null);
  }
  const rows = state().items.filter((item) => item.kind === 'notice');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, ALLOW_NOT_SAVED_NOTICE);
  assert.equal(rows[0].tone, 'warn');
});
