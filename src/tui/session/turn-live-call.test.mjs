import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens } from '../../runtime/agent/orchestrator/session/token-estimate.mjs';
import {
  endLiveCall,
  LIVE_CALL_PUBLISH_MS,
  markLiveCallRequestStart,
  noteLiveCallText,
  startNextLiveCall,
  withdrawLiveCall,
} from './turn-live-call.mjs';

function harness(spinner = { active: true, mode: 'responding' }) {
  const state = { spinner };
  const published = [];
  return {
    turn: {},
    getState: () => state,
    set(patch) {
      Object.assign(state, patch);
      if ('spinner' in patch) published.push(patch.spinner?.liveCall ?? null);
    },
    state,
    published,
  };
}

test('a streaming call publishes its estimated tokens, throttled, from its first token', () => {
  const ctx = harness();
  noteLiveCallText(ctx, 'Hello ', 1000);
  assert.deepEqual(ctx.state.spinner.liveCall, { startedAt: 1000, outputTokens: estimateTokens('Hello '), at: 1000 });
  // Inside the window nothing is published; the text still counts.
  noteLiveCallText(ctx, 'there, ', 1000 + LIVE_CALL_PUBLISH_MS - 1);
  assert.equal(ctx.published.length, 1);
  noteLiveCallText(ctx, 'friend.', 1000 + LIVE_CALL_PUBLISH_MS);
  assert.equal(ctx.published.length, 2);
  assert.deepEqual(ctx.state.spinner.liveCall, {
    startedAt: 1000,
    outputTokens: estimateTokens('Hello there, friend.'),
    at: 1000 + LIVE_CALL_PUBLISH_MS,
  });
  // The rest of the spinner is untouched.
  assert.equal(ctx.state.spinner.mode, 'responding');
});

test('the call ends with its usage delta; the next call starts its own clock', () => {
  const ctx = harness();
  noteLiveCallText(ctx, 'first call', 1000);
  startNextLiveCall(ctx);
  assert.equal(ctx.state.spinner.liveCall, null);
  noteLiveCallText(ctx, 'second', 9000);
  assert.deepEqual(ctx.state.spinner.liveCall, { startedAt: 9000, outputTokens: estimateTokens('second'), at: 9000 });
  // Ending with nothing live publishes nothing.
  startNextLiveCall(ctx);
  const count = ctx.published.length;
  startNextLiveCall(ctx);
  assert.equal(ctx.published.length, count);
});

test('the live clock starts at the request start, the first-token wait included, and restarts per call', () => {
  const ctx = harness();
  markLiveCallRequestStart(ctx, 500);
  noteLiveCallText(ctx, 'Hello ', 3000);
  assert.equal(ctx.state.spinner.liveCall.startedAt, 500);
  assert.equal(ctx.state.spinner.liveCall.at, 3000);
  // A text reset inside the same request keeps its clock.
  endLiveCall(ctx);
  noteLiveCallText(ctx, 'retry', 4000);
  assert.equal(ctx.state.spinner.liveCall.startedAt, 500);
  // The usage delta ends the call; the next one waits for its own request start.
  startNextLiveCall(ctx);
  noteLiveCallText(ctx, 'unmarked', 9000);
  assert.equal(ctx.state.spinner.liveCall.startedAt, 9000);
  startNextLiveCall(ctx);
  markLiveCallRequestStart(ctx, 12_000);
  noteLiveCallText(ctx, 'next', 14_000);
  assert.equal(ctx.state.spinner.liveCall.startedAt, 12_000);
});

test('a call that turns to a tool call withdraws until its usage delta', () => {
  const ctx = harness();
  noteLiveCallText(ctx, 'I will edit the file. ', 1000);
  withdrawLiveCall(ctx);
  assert.equal(ctx.state.spinner.liveCall, null);
  noteLiveCallText(ctx, 'late text', 5000);
  assert.equal(ctx.state.spinner.liveCall, null, 'tool arguments are not counted, so no rate is claimed');
  startNextLiveCall(ctx);
  noteLiveCallText(ctx, 'next', 6000);
  assert.equal(ctx.state.spinner.liveCall.startedAt, 6000);
});

test('a text reset restarts the call; no spinner or empty chunks publish nothing', () => {
  const ctx = harness();
  noteLiveCallText(ctx, 'abandoned attempt', 1000);
  endLiveCall(ctx);
  noteLiveCallText(ctx, 'retry', 4000);
  assert.equal(ctx.state.spinner.liveCall.startedAt, 4000);
  noteLiveCallText(ctx, '', 9000);
  assert.equal(ctx.state.spinner.liveCall.at, 4000);
  const bare = harness(null);
  noteLiveCallText(bare, 'text', 1000);
  assert.equal(bare.published.length, 0);
});
