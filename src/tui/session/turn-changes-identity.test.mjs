// A turn's change-record key (checkpointId = the outer prompt id) must reach
// the live turndone row and survive persistence + restore on both the user row
// and the completion's turndone row.
import assert from 'node:assert/strict';
import test from 'node:test';
import { persistedUserTranscriptMetadata } from '../../runtime/shared/transcript-metadata.mjs';
import { attachAssistantTranscriptCompletion } from '../../runtime/agent/orchestrator/session/manager/ask-turn-settle.mjs';
import { createAskCallbacks } from '../../session-runtime/turn/turn-run/ask-callbacks.mjs';
import { restoreTranscriptItems } from './session-api-ext.mjs';
import { applyTurnRouteMetadata, turnDoneItem } from './turn.mjs';

test('admitted route updates shared stream metadata and submitted rows without replacing identity', () => {
  const transcriptMeta = { at: 10, messageId: 'message-1', provider: 'old', modelId: 'old', agent: 'Lead' };
  const routeMeta = { provider: 'old', modelId: 'old', agent: 'Lead' };
  const patches = [];
  applyTurnRouteMetadata(
    {
      turn: { transcriptMeta, routeMeta, submittedIds: ['prompt-1'] },
      patchItem: (id, patch) => patches.push({ id, patch }),
    },
    { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }
  );
  assert.equal(transcriptMeta.modelId, 'deepseek/deepseek-v4.1-flash');
  assert.equal(routeMeta.modelId, transcriptMeta.modelId);
  assert.equal(routeMeta.provider, 'openrouter');
  assert.equal(transcriptMeta.messageId, 'message-1');
  assert.equal(transcriptMeta.at, 10);
  assert.equal(transcriptMeta.agent, 'Lead');
  assert.equal(patches[0].id, 'prompt-1');
  assert.equal(patches[0].patch.modelId, transcriptMeta.modelId);
});

test('the runtime stamps the outer prompt id onto the caller transcript metadata in place', () => {
  const { askCallbacks } = createAskCallbacks({
    transcript: { appendAssistantText() {} },
    notifyFnForSession: () => null,
    scheduleSearchRuntimeWarmup: null,
    hooks: { emit() {} },
  });
  const meta = { at: 10, model: 'm' };
  const turn = { snapshot: { promise: null }, timing: {}, signal: null };
  const callbacks = askCallbacks(turn, { id: 's' }, { id: ' prompt-1 ', transcriptMeta: meta });
  assert.equal(callbacks.transcriptMeta, meta, 'the same object: the stream stamps assistantAt on it');
  assert.equal(meta.checkpointId, 'prompt-1');
  const unstamped = askCallbacks(turn, { id: 's' }, { transcriptMeta: { at: 1 } });
  assert.equal(Object.hasOwn(unstamped.transcriptMeta, 'checkpointId'), false);
});

test('checkpointId survives user persistence, completion persistence and restore', () => {
  const raw = { at: 10, model: 'Model', provider: 'p', checkpointId: 'prompt-1', completionVerb: 'Baked' };
  const messages = [
    { role: 'user', content: 'Change it.', meta: { transcript: persistedUserTranscriptMetadata(raw) } },
    { role: 'assistant', content: 'Changed.', meta: { transcript: { at: 20, model: 'Model' } } },
  ];
  assert.equal(messages[0].meta.transcript.checkpointId, 'prompt-1');
  assert.equal(
    attachAssistantTranscriptCompletion(
      messages,
      { status: 'done', verb: raw.completionVerb, elapsedMs: 5, checkpointId: raw.checkpointId },
      raw.at
    ),
    true
  );
  assert.equal(messages[1].meta.transcript.completion.checkpointId, 'prompt-1');
  const items = restoreTranscriptItems(JSON.parse(JSON.stringify(messages)), { sessionId: 'identity' });
  const user = items.find((item) => item.kind === 'user');
  const done = items.find((item) => item.kind === 'turndone');
  assert.equal(user.checkpointId, 'prompt-1');
  assert.equal(done.checkpointId, 'prompt-1');
  assert.equal(
    Object.hasOwn(
      items.find((item) => item.kind === 'assistant'),
      'checkpointId'
    ),
    false
  );
});

test('legacy records without a checkpoint restore without inventing one', () => {
  const messages = [
    { role: 'user', content: 'Old.', meta: { transcript: persistedUserTranscriptMetadata({ at: 1 }) } },
    {
      role: 'assistant',
      content: 'Old answer.',
      meta: { transcript: { at: 2, completion: { status: 'done', verb: 'Baked', elapsedMs: 1 } } },
    },
  ];
  const items = restoreTranscriptItems(messages, { sessionId: 'legacy' });
  for (const item of items) assert.equal(Object.hasOwn(item, 'checkpointId'), false);
});

test('the live turndone row carries the outer prompt id', () => {
  let nextId = 0;
  const ctx = (submittedIds) => ({
    turn: {
      startedAt: Date.now(),
      submittedIds,
      cancelled: false,
      failed: false,
      finishedNormally: true,
      completionVerb: 'Baked',
      routeMeta: {},
    },
    stream: {
      currentAssistantId: null,
      thinkingStartedAt: 0,
      accumulatedThinkingMs: 0,
      assistantText: '',
      currentAssistantText: '',
      thinkingText: '',
    },
    cards: { toolCards: [] },
    getState: () => ({ spinner: null }),
    nextId: () => ++nextId,
  });
  assert.equal(turnDoneItem(ctx(['prompt-7'])).checkpointId, 'prompt-7');
  assert.equal(Object.hasOwn(turnDoneItem(ctx([])), 'checkpointId'), false);
});
