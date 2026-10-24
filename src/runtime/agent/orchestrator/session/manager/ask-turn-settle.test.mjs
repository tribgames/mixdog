import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Settlement of a finished ask: a reaction-only turn is a successful
// completion, a genuinely empty one is still "finished empty".
const root = mkdtempSync(join(tmpdir(), 'mixdog-ask-settle-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const { publishAskTurn } = await import('./ask-turn-settle.mjs');
const { _getRuntimeEntry } = await import('./runtime-liveness.mjs');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function settle(id, terminalResultPreview) {
  const session = { id, messages: [], provider: 'p', model: 'm' };
  const opened = { turn: { session, pendingEntries: [] }, runtime: {}, askGeneration: 0, turnToken: 't' };
  publishAskTurn({
    sessionId: id,
    opened,
    terminalResultPreview,
    askOpts: {},
    rawTranscriptMeta: { at: 1 },
    askStartedAt: Date.now(),
  });
  return _getRuntimeEntry(id);
}

test('a reaction-only turn settles as a completion, not "finished empty"', () => {
  const entry = settle('sess_settle_reaction', { content: '', reactionCompleted: true });
  assert.notEqual(entry.emptyFinal, true);
});

test('a turn with no content and no reaction still settles as finished empty', () => {
  const entry = settle('sess_settle_empty', { content: '' });
  assert.equal(entry.emptyFinal, true);
});
