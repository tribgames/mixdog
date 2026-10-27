// A mid-turn model switch saved, then a crash before the live turn was
// checkpointed again: the reloaded session resumes with the turn's completed
// tool work (never re-run) and without the previous provider's native state.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';

import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';
const root = makeTempDirSync('route-switch');
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { createTurnCheckpointRecorder, recoverTurnCheckpoint, settleTurnCheckpointWrites } = await import(
  './turn-checkpoint.mjs'
);
const { createTurnInterruptionTracker } = await import('./turn-interruption.mjs');

const prompt = 'read a.txt and summarize';

function runTurnUntilSwitch(sessionId) {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
  ];
  const outgoing = [
    ...history,
    { role: 'user', content: prompt },
    {
      role: 'assistant',
      content: 'reading',
      toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' }, thoughtSignature: 'gemini-sig' }],
      reasoningItems: [{ id: 'rs_1', encrypted_content: 'openai-enc' }],
      thinkingBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'anthropic-sig' }],
    },
    { role: 'tool', toolCallId: 'call_1', content: 'file body' },
  ];
  const recorder = createTurnCheckpointRecorder({
    sessionId,
    generation: 2,
    turnToken: `tok-${sessionId}`,
    startedAt: 1000,
  });
  // The prompt anchors at turn start; the tool round lands before the next
  // request fails and the route switches.
  recorder.record({
    currentUserContent: prompt,
    turnOutgoing: outgoing.slice(0, history.length + 1),
    interruption: createTurnInterruptionTracker(),
  });
  recorder.record({
    currentUserContent: prompt,
    turnOutgoing: outgoing,
    interruption: createTurnInterruptionTracker(),
  });
  return { history, recorder };
}

// What the route switch saved: the new route, the committed history with the
// prompt, and the active-turn marker flagged as switched.
function savedSession(sessionId, history, { routeChanged }) {
  const record = {
    id: sessionId,
    generation: 2,
    provider: 'anthropic',
    model: 'claude-opus-4-1',
    routeFallbackIndex: 1,
    messages: [...history, { role: 'user', content: prompt }],
    activeTurnCheckpoint: { version: 1, turnToken: `tok-${sessionId}`, startedAt: 1000, routeChanged },
    updatedAt: Date.now(),
  };
  // A disk round trip, as a process restart reads it.
  return JSON.parse(JSON.stringify(record));
}

test('a crash after a saved mid-turn switch resumes the turn with its tool result and no foreign state', async () => {
  const sessionId = 'sess-route-switch-crash';
  const { history } = runTurnUntilSwitch(sessionId);
  await settleTurnCheckpointWrites(sessionId);
  const session = savedSession(sessionId, history, { routeChanged: true });
  const recovery = recoverTurnCheckpoint(session);
  assert.equal(recovery.recovered, true);
  assert.equal(session.provider, 'anthropic');
  const calls = session.messages.flatMap((m) => (m.role === 'assistant' ? m.toolCalls || [] : []));
  const results = session.messages.filter((m) => m.role === 'tool');
  // The completed call is paired with its result exactly once: nothing is left
  // for the resumed turn to execute again.
  assert.deepEqual(
    calls.map((c) => c.id),
    ['call_1']
  );
  assert.deepEqual(
    results.map((m) => [m.toolCallId, m.content]),
    [['call_1', 'file body']]
  );
  assert.equal(session.messages.filter((m) => m.role === 'user' && m.content === prompt).length, 1);
  assert.doesNotMatch(JSON.stringify(session.messages), /gemini-sig|openai-enc|anthropic-sig/);
  assert.equal(session.activeTurnCheckpoint, undefined);
});

test('without a switch the recovered turn keeps its own provider state', async () => {
  const sessionId = 'sess-route-same';
  const { history } = runTurnUntilSwitch(sessionId);
  await settleTurnCheckpointWrites(sessionId);
  const session = savedSession(sessionId, history, { routeChanged: false });
  assert.equal(recoverTurnCheckpoint(session).recovered, true);
  assert.match(JSON.stringify(session.messages), /gemini-sig/);
});
