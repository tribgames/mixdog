import assert from 'node:assert/strict';
import test from 'node:test';

import { toolSurfaceExceedsContextError } from '../../runtime/agent/orchestrator/session/loop/context-overflow.mjs';
import { presentErrorText } from '../../runtime/shared/err-text.mjs';
import { failTurn, turnDoneItem } from './turn.mjs';
import { createTurnStream } from './turn-stream.mjs';

const overhead = {
  kind: 'fixed_overhead',
  contextWindowTokens: 8000,
  boundaryTokens: 7000,
  toolTokens: 9000,
  toolCount: 3,
  systemTokens: 500,
  configuredReserveTokens: 0,
  largestTools: [{ name: 'mcp__huge__configure', tokens: 5000 }],
};

function failedCtx(error) {
  let state = { spinner: null };
  const stream = createTurnStream({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    isCurrentTurn: () => true,
  });
  const ctx = {
    turn: { startedAt: Date.now(), submittedIds: [], completionVerb: 'Done', routeMeta: {} },
    stream,
    cards: { aggregates: { finalizeToolHeaders() {} }, toolCards: [] },
    getState: () => state,
    nextId: () => 1,
    pushNotice() {},
  };
  failTurn(ctx, error);
  return ctx;
}

test('a tool-surface overflow shows its message and every detail, not a compaction hint', () => {
  const error = toolSurfaceExceedsContextError({
    sessionId: 's1',
    sessionRef: { provider: 'anthropic', model: 'm' },
    overhead,
  });
  const ctx = failedCtx(error);
  const detail = ctx.turn.failureDetail;
  assert.match(detail, /^Tool definitions and system context leave no room .*\(TOOL_SURFACE_EXCEEDS_CONTEXT\)/);
  for (const part of [
    'context window 8,000 tokens',
    'tool definitions 9,000 tokens (3 tools)',
    'protected system context 500 tokens',
    'Compacting the conversation history cannot reduce these',
    'Use a model with a larger context window',
    'Largest tool definitions: mcp__huge__configure (5,000 tokens)',
  ]) {
    assert.ok(detail.includes(part), part);
  }
  assert.doesNotMatch(detail, /Context too large/i);
  assert.equal(turnDoneItem(ctx).status, 'failed');
  assert.equal(presentErrorText(error, { surface: 'turn' }), detail);
});
