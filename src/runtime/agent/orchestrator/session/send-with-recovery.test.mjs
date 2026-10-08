// Retry visibility for replayed sends. A stalled stream is retried as a fresh
// request; without these guarantees the replay reports plain
// 'requesting'/'streaming' and the whole retry window renders as ordinary
// thinking, which is exactly how a ~20-minute stall passed for normal work.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Trace writes resolve the data dir at import time; keep them in a temp root.
const root = mkdtempSync(join(tmpdir(), 'mixdog-send-recovery-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_TRANSPORT_RETRY_BACKOFF_MS = '0,0,0';
process.env.MIXDOG_CONNECTION_RETRY_BACKOFF_MS = '0,0,0,0';
process.env.MIXDOG_RECOVERY_RETRY_BACKOFF_MS = '0,0,0,0,0';
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { sendWithRecovery, TRANSPORT_RETRY_MAX } = await import('./send-with-recovery.mjs');
const { isConnectFailure, markProviderRecoveryExhausted } = await import('../providers/retry-classifier.mjs');
const { parseSSEStream } = await import('../providers/anthropic-sse.mjs');
const { applyRetryAction } = await import('./loop/send-phase.mjs');
const { resolveOutputLimit } = await import('./loop/no-tool-turn/output-limit.mjs');

function recordingOpts(extra = {}) {
  const stages = [];
  return {
    stages,
    opts: {
      onStageChange: (stage, detail) => {
        stages.push({ stage, attempt: detail?.attempt ?? null, message: detail?.message ?? null });
      },
      ...extra,
    },
  };
}

function providerEmitting(script) {
  return {
    send: async (_messages, _model, _tools, sendOpts) => {
      await script(sendOpts);
      return { content: 'ok' };
    },
  };
}

function cursorStreamAbort() {
  const error = new Error('Cursor stream was aborted');
  error.code = 'stream_aborted';
  error.cursorCode = 'stream_aborted';
  return error;
}

function committedToolHistory() {
  return [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call-complete',
          type: 'function',
          function: { name: 'read', arguments: '{"file_path":"done.txt"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call-complete', content: 'done' },
  ];
}

const baseCtx = {
  messages: [],
  model: 'test-model',
  sendTools: [],
  tools: [],
  sessionId: 'sess-retry-visibility',
  nextIteration: 1,
};

test('a replayed send reports reconnect progress instead of a plain request', async () => {
  const { stages, opts } = recordingOpts();
  const provider = providerEmitting((sendOpts) => sendOpts.onStageChange('requesting'));

  const result = await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 2 });

  assert.equal(result.action, 'proceed');
  assert.deepEqual(
    stages.map((entry) => entry.stage),
    ['reconnecting']
  );
  assert.equal(stages[0].attempt, 2);
  assert.equal(stages[0].message, `Reconnecting... 2/${TRANSPORT_RETRY_MAX}`);
});

test('the replacement stream ends the reconnect display on its first visible delta', async () => {
  const deltas = [];
  const { stages, opts } = recordingOpts({
    onStreamDelta: (kind) => {
      deltas.push(kind);
    },
  });
  const provider = providerEmitting((sendOpts) => {
    sendOpts.onStageChange('requesting');
    sendOpts.onStreamDelta('text');
    sendOpts.onStageChange('streaming');
  });

  await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 1 });

  assert.deepEqual(
    stages.map((entry) => entry.stage),
    ['reconnecting', 'streaming', 'streaming']
  );
  // The caller's own delta observer still runs underneath the wrapper.
  assert.deepEqual(deltas, ['text']);
});

test('transport-level acknowledgements alone do not end the reconnect display', async () => {
  const { stages, opts } = recordingOpts();
  const provider = providerEmitting((sendOpts) => {
    sendOpts.onStageChange('requesting');
    // Connection/ack progress is not visible model output.
    sendOpts.onStreamDelta('transport');
    sendOpts.onStageChange('streaming');
  });

  await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 3 });

  assert.deepEqual(
    stages.map((entry) => entry.stage),
    ['reconnecting', 'reconnecting']
  );
});

test('a first attempt keeps its own stages and restores the caller callbacks', async () => {
  const { stages, opts } = recordingOpts({ onStreamDelta: () => {} });
  const originalStage = opts.onStageChange;
  const originalDelta = opts.onStreamDelta;
  const provider = providerEmitting((sendOpts) => {
    sendOpts.onStageChange('requesting');
    sendOpts.onStreamDelta('text');
    sendOpts.onStageChange('streaming');
  });

  await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 0 });

  assert.deepEqual(
    stages.map((entry) => entry.stage),
    ['requesting', 'streaming']
  );
  assert.equal(opts.onStageChange, originalStage);
  assert.equal(opts.onStreamDelta, originalDelta);
});

test('a Cursor abort after committed tool history retries the empty continuation', async () => {
  const messages = committedToolHistory();
  const attempts = [];
  const { opts } = recordingOpts();
  const provider = {
    send: async (attemptMessages) => {
      attempts.push(attemptMessages);
      throw cursorStreamAbort();
    },
  };

  const result = await sendWithRecovery({
    ...baseCtx,
    provider,
    opts,
    messages,
    recoveryMessages: messages,
    transportRetriesUsed: 0,
  });

  assert.equal(result.action, 'retry_transport');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0], messages);
});

test('a Cursor abort retries a reasoning-only continuation after committed tool history', async () => {
  const messages = committedToolHistory();
  const abort = cursorStreamAbort();
  abort.emittedReasoning = true;
  const { opts } = recordingOpts();
  const provider = {
    send: async () => {
      throw abort;
    },
  };

  const result = await sendWithRecovery({
    ...baseCtx,
    provider,
    opts,
    messages,
    recoveryMessages: messages,
    transportRetriesUsed: 0,
  });

  assert.equal(result.action, 'retry_transport');
});

test('loop retry diagnostics retain the WebSocket close code and current HTTP status', async (t) => {
  const writes = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const details = [];
  const opts = {
    onStageChange: (stage, detail) => {
      if (stage === 'reconnecting') details.push(detail);
    },
  };
  const failure = Object.assign(new Error('transport failure'), {
    wsCloseCode: 1006,
    httpStatus: 503,
  });
  const result = await sendWithRecovery({
    ...baseCtx,
    opts,
    provider: {
      send: async () => {
        throw failure;
      },
    },
  });
  assert.equal(result.action, 'retry_transport');
  assert.equal(details.length, 1);
  assert.equal(details[0].wsCloseCode, 1006);
  assert.equal(details[0].httpStatus, 503);
  assert.ok(writes.some((line) => line.includes('wsCloseCode=1006') && line.includes('httpStatus=503')));
});

test('a Cursor abort retries visible text only after the owner retracts it', async () => {
  const abort = cursorStreamAbort();
  abort.partialContent = 'partial answer';
  abort.liveTextEmitted = true;
  const resets = [];
  const { opts } = recordingOpts({
    onTextDelta: () => {},
    onTextReset: async (detail) => {
      resets.push(detail);
      return true;
    },
  });
  const provider = {
    send: async (_messages, _model, _tools, sendOpts) => {
      sendOpts.onTextDelta(abort.partialContent);
      throw abort;
    },
  };

  const result = await sendWithRecovery({
    ...baseCtx,
    provider,
    opts,
    transportRetriesUsed: 0,
  });

  assert.equal(result.action, 'retry_transport');
  assert.deepEqual(resets, [
    {
      chars: abort.partialContent.length,
      reasoning: false,
      reason: 'loop-transport-retraction',
    },
  ]);
});

test('a dropped connection after visible text retries once the owner retracts it', async () => {
  const dropped = new TypeError('terminated');
  dropped.partialContent = 'partial answer';
  dropped.liveTextEmitted = true;
  dropped.pendingToolUse = true;
  const resets = [];
  const { opts } = recordingOpts({
    onTextDelta: () => {},
    onTextReset: async (detail) => {
      resets.push(detail);
      return true;
    },
  });
  const provider = {
    send: async (_messages, _model, _tools, sendOpts) => {
      sendOpts.onTextDelta(dropped.partialContent);
      throw dropped;
    },
  };

  const result = await sendWithRecovery({
    ...baseCtx,
    provider,
    opts,
    transportRetriesUsed: 0,
  });

  assert.equal(result.action, 'retry_transport');
  // A mid-response drop keeps the ordinary ladder, not the outage ladder.
  assert.equal(result.transportRetryMax, TRANSPORT_RETRY_MAX);
  assert.deepEqual(resets, [
    {
      chars: dropped.partialContent.length,
      reasoning: false,
      reason: 'loop-transport-retraction',
    },
  ]);
});

test('a dropped connection after a dispatched tool call is not replayed', async () => {
  const dropped = new TypeError('terminated');
  dropped.partialContent = 'partial answer';
  dropped.liveTextEmitted = true;
  dropped.emittedToolCall = true;
  let resetAttempts = 0;
  const { opts } = recordingOpts({
    onTextDelta: () => {},
    onTextReset: async () => {
      resetAttempts += 1;
      return true;
    },
  });
  const provider = {
    send: async (_messages, _model, _tools, sendOpts) => {
      sendOpts.onTextDelta(dropped.partialContent);
      throw dropped;
    },
  };

  await assert.rejects(
    sendWithRecovery({
      ...baseCtx,
      provider,
      opts,
      transportRetriesUsed: 0,
    }),
    (error) => error === dropped
  );
  assert.equal(resetAttempts, 0);
});

test('a Cursor abort does not retry visible text when the owner rejects retraction', async () => {
  const abort = cursorStreamAbort();
  abort.partialContent = 'partial answer';
  abort.liveTextEmitted = true;
  let resetAttempts = 0;
  const { opts } = recordingOpts({
    onTextDelta: () => {},
    onTextReset: async () => {
      resetAttempts += 1;
      return false;
    },
  });
  const provider = {
    send: async (_messages, _model, _tools, sendOpts) => {
      sendOpts.onTextDelta(abort.partialContent);
      throw abort;
    },
  };

  await assert.rejects(
    sendWithRecovery({
      ...baseCtx,
      provider,
      opts,
      transportRetriesUsed: 0,
    }),
    (error) => error === abort
  );
  assert.equal(resetAttempts, 1);
});

test('an image rejection with nothing left to strip surfaces the original error, not a context overflow', async () => {
  const rejection = new Error('Could not process image');
  rejection.status = 400;
  const provider = {
    send: async () => {
      throw rejection;
    },
  };
  // The only image sits in an earlier turn, so the latest-turn strip removes
  // nothing.
  const messages = [
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    { role: 'assistant', content: 'seen' },
    { role: 'user', content: 'describe it again' },
  ];
  const { opts } = recordingOpts();

  await assert.rejects(
    sendWithRecovery({
      ...baseCtx,
      messages,
      provider,
      opts,
      sessionRef: { id: 'sess-image-strip', provider: 'anthropic', contextWindow: 200_000, compaction: { auto: true } },
      transportRetriesUsed: 0,
    }),
    (error) => error === rejection
  );
});

function unreachable() {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.example'), { code: 'ENOTFOUND' });
  return new TypeError('fetch failed', { cause });
}

test('only a connection that cannot be established counts as an unreachable network', () => {
  assert.equal(isConnectFailure(unreachable()), true);
  assert.equal(isConnectFailure(new TypeError('terminated')), false);
  assert.equal(isConnectFailure(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), false);
  assert.equal(isConnectFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED', httpStatus: 503 })), false);
});

test('a provider ladder spent on an unreachable network still gets the outage ladder', async () => {
  const outage = markProviderRecoveryExhausted(unreachable(), { owner: 'test-provider', attempts: 11 });
  const { opts } = recordingOpts();
  const result = await sendWithRecovery({
    ...baseCtx,
    provider: {
      send: async () => {
        throw outage;
      },
    },
    opts,
    transportRetriesUsed: 0,
  });
  assert.equal(result.action, 'retry_transport');
  assert.equal(result.transportRetryMax, 4);

  const dropped = markProviderRecoveryExhausted(new TypeError('terminated'), { owner: 'test-provider', attempts: 4 });
  await assert.rejects(
    sendWithRecovery({
      ...baseCtx,
      provider: {
        send: async () => {
          throw dropped;
        },
      },
      opts: recordingOpts().opts,
      transportRetriesUsed: 0,
    }),
    (error) => error === dropped
  );
});

test('a retraction removes exactly the relayed text even when the error carries no count', async () => {
  const dropped = new TypeError('terminated');
  dropped.liveTextEmitted = true;
  const resets = [];
  const { opts } = recordingOpts({
    onTextDelta: () => {},
    onTextReset: async (detail) => {
      resets.push(detail.chars);
      return true;
    },
  });
  const provider = {
    send: async (_messages, _model, _tools, sendOpts) => {
      sendOpts.onTextDelta('abc');
      sendOpts.onTextDelta('de');
      throw dropped;
    },
  };

  const result = await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 0 });

  assert.equal(result.action, 'retry_transport');
  assert.deepEqual(resets, [5]);
});

test('text a provider already retracted is not retracted again before the replay', async () => {
  const resets = [];
  const { opts } = recordingOpts({
    onTextDelta: () => {},
    onTextReset: async (detail) => {
      resets.push(detail.reason);
      return true;
    },
  });
  const provider = {
    send: async (_messages, _model, _tools, sendOpts) => {
      sendOpts.onTextDelta('hello');
      await sendOpts.onTextReset({ chars: 5, reasoning: false, reason: 'provider-fallback' });
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    },
  };

  const result = await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 0 });

  assert.equal(result.action, 'retry_transport');
  assert.deepEqual(resets, ['provider-fallback']);
});

test('an incomplete tool input is dropped and the dispatched calls continue', async () => {
  const done = { id: 'call-done', name: 'read', arguments: { file_path: 'a.txt' } };
  const placeholder = { id: '', name: '', arguments: {}, _pendingItemId: 'fc_unresolved' };
  const dropped = Object.assign(new TypeError('terminated'), {
    partialContent: '',
    partialToolCalls: [done, placeholder],
    pendingToolUse: true,
  });
  const { opts } = recordingOpts({ onToolCall: () => {} });
  const provider = {
    send: async (_messages, _model, _tools, sendOpts) => {
      sendOpts.onToolCall(done);
      throw dropped;
    },
  };

  const result = await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 0 });

  assert.equal(result.action, 'proceed');
  assert.deepEqual(result.response.toolCalls, [done]);
  assert.equal(result.response.partialToolRecovery, true);
  // The dropped call's split-call notice rides along for after the results.
  assert.equal(result.response.recoveryNotice.meta.source, 'stream-cut-recovery');
});

test('an incomplete tool input never continues with a complete call this send did not dispatch', async () => {
  const undispatched = Object.assign(new TypeError('terminated'), {
    partialContent: '',
    partialToolCalls: [{ id: 'call-done', name: 'read', arguments: {} }],
    pendingToolUse: true,
  });
  const provider = {
    send: async () => {
      throw undispatched;
    },
  };

  await assert.rejects(
    sendWithRecovery({ ...baseCtx, provider, opts: recordingOpts({ onToolCall: () => {} }).opts }),
    (error) => error === undispatched
  );
});

function droppingAnthropicStream(events, error) {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  let index = 0;
  return {
    body: {
      getReader() {
        return {
          read: () =>
            index < chunks.length ? Promise.resolve({ done: false, value: chunks[index++] }) : Promise.reject(error),
          cancel: () => Promise.resolve(),
          releaseLock() {},
        };
      },
    },
  };
}

test('an Anthropic stream cut after a dispatched tool call continues with that call', async () => {
  const cut = new TypeError('terminated');
  const events = [
    { type: 'message_start', message: { id: 'msg_cut', model: 'claude-fixture', usage: { input_tokens: 3 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_done', name: 'read', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.txt"}' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_open', name: 'edit', input: {} },
    },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_pa' } },
  ];
  const dispatched = [];
  const { opts } = recordingOpts({ onToolCall: (call) => dispatched.push(call.id) });
  const provider = {
    send: (_messages, _model, _tools, sendOpts) =>
      parseSSEStream(
        droppingAnthropicStream(events, cut),
        null,
        null,
        null,
        sendOpts.onToolCall,
        { attemptIndex: 0 },
        sendOpts.onTextDelta
      ),
  };

  const result = await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 0 });

  assert.equal(result.action, 'proceed');
  assert.deepEqual(
    result.response.toolCalls.map((call) => call.id),
    ['toolu_done']
  );
  assert.deepEqual(dispatched, ['toolu_done']);
  assert.equal(cut.pendingToolUse, true);
  assert.equal(result.response.recoveryNotice.meta.source, 'stream-cut-recovery');
});

test('a provider still unavailable after its own retries parks on the recovery cycles while nothing was shown', async () => {
  const unavailable = () =>
    markProviderRecoveryExhausted(Object.assign(new Error('Service Unavailable'), { httpStatus: 503 }), {
      owner: 'test-provider',
      attempts: 5,
    });
  const down = unavailable();
  const result = await sendWithRecovery({
    ...baseCtx,
    provider: {
      send: async () => {
        throw down;
      },
    },
    opts: recordingOpts().opts,
    transportRetriesUsed: 0,
  });
  assert.equal(result.action, 'retry_transport');
  assert.equal(result.transportRetryMax, 5);

  // Text the user already saw is never replayed by the recovery cycles.
  const shown = unavailable();
  const { opts } = recordingOpts({ onTextDelta: () => {}, onTextReset: async () => true });
  await assert.rejects(
    sendWithRecovery({
      ...baseCtx,
      provider: {
        send: async (_messages, _model, _tools, sendOpts) => {
          sendOpts.onTextDelta('partial answer');
          throw shown;
        },
      },
      opts,
      transportRetriesUsed: 0,
    }),
    (error) => error === shown
  );
});

test('a server-advised wait replaces the ladder step', async () => {
  const busy = Object.assign(new Error('Service Unavailable'), {
    httpStatus: 503,
    headers: new Headers({ 'retry-after-ms': '3' }),
  });
  const details = [];
  const startedAt = Date.now();
  const result = await sendWithRecovery({
    ...baseCtx,
    provider: {
      send: async () => {
        throw busy;
      },
    },
    opts: {
      onStageChange: (stage, detail) => {
        if (stage === 'reconnecting') details.push(detail);
      },
    },
    transportRetriesUsed: 0,
  });
  assert.equal(result.action, 'retry_transport');
  assert.deepEqual(
    details.map((detail) => detail.waitMs),
    [3]
  );
  // A surface can count the wait down: when the next attempt starts, and why.
  assert.ok(details[0].retryAt >= startedAt + 3);
  assert.ok(details[0].reason.length > 0);
});

test('a turn that ended on a malformed tool call is re-asked', async () => {
  const malformed = Object.assign(new Error('Gemini response incomplete: finishReason=MALFORMED_FUNCTION_CALL'), {
    providerIncomplete: true,
    code: 'PROVIDER_INCOMPLETE',
    finishReason: 'MALFORMED_FUNCTION_CALL',
    partialContent: '',
  });
  const result = await sendWithRecovery({
    ...baseCtx,
    provider: {
      send: async () => {
        throw malformed;
      },
    },
    opts: recordingOpts().opts,
    transportRetriesUsed: 0,
  });
  assert.equal(result.action, 'retry_transport');
});

test('text the owner cannot withdraw is kept and continued instead of failing the turn', async () => {
  const cut = new TypeError('terminated');
  const result = await sendWithRecovery({
    ...baseCtx,
    provider: {
      send: async (_messages, _model, _tools, sendOpts) => {
        sendOpts.onTextDelta('The first half of the answer');
        throw cut;
      },
    },
    // A live text sink with no retraction channel.
    opts: { onTextDelta: () => {} },
    transportRetriesUsed: 0,
  });
  assert.equal(result.action, 'proceed');
  assert.equal(result.response.content, 'The first half of the answer');
  assert.equal(result.response.streamCut, true);

  // The loop resumes it through the output-limit ladder with a network notice.
  const messages = [];
  const verdict = resolveOutputLimit(result.response, {
    state: { maxOutputRecoveryCount: 0 },
    segments: { record() {}, commitIntermediate() {}, parts: [] },
    messages,
  });
  assert.equal(verdict.action, 'continue');
  assert.equal(messages[0].meta.source, 'stream-cut-recovery');
  assert.match(messages[0].content, /^\[mixdog-runtime\]/);
});

test('a cut mid tool arguments replays with a split-call notice, even after the provider spent its retries', async () => {
  const cut = markProviderRecoveryExhausted(
    Object.assign(new TypeError('terminated'), { partialContent: '', pendingToolUse: true }),
    { owner: 'test-provider', attempts: 3 }
  );
  const resets = [];
  const { opts } = recordingOpts({
    onTextDelta: () => {},
    onTextReset: async (detail) => {
      resets.push(detail.chars);
      return true;
    },
  });
  const result = await sendWithRecovery({
    ...baseCtx,
    provider: {
      send: async (_messages, _model, _tools, sendOpts) => {
        sendOpts.onTextDelta('Writing the deck now.');
        throw cut;
      },
    },
    opts,
    transportRetriesUsed: 0,
  });
  assert.equal(result.action, 'retry_transport');
  assert.equal(result.notice.meta.source, 'stream-cut-recovery');
  assert.match(result.notice.content, /^\[mixdog-runtime\]/);
  assert.deepEqual(resets, ['Writing the deck now.'.length]);
});

test('the split-call notice joins the next request once', () => {
  const notice = { role: 'user', content: '[mixdog-runtime] split it', meta: { source: 'stream-cut-recovery' } };
  const state = {
    messages: [{ role: 'user', content: 'make the deck' }],
    transportRetriesUsed: 0,
    transportRetryMax: 0,
  };
  assert.equal(applyRetryAction(state, { action: 'retry_transport', transportRetryMax: 3, notice }), true);
  assert.equal(applyRetryAction(state, { action: 'retry_transport', transportRetryMax: 3, notice }), true);
  assert.deepEqual(
    state.messages.map((message) => message.meta?.source ?? null),
    [null, 'stream-cut-recovery']
  );
  assert.equal(state.transportRetriesUsed, 2);
});

test('a Cursor abort does not replay a tool dispatched by the failing send', async () => {
  const abort = cursorStreamAbort();
  const { opts } = recordingOpts({ onToolCall: () => {} });
  const provider = {
    send: async (_messages, _model, _tools, sendOpts) => {
      sendOpts.onToolCall({ id: 'call-side-effect', name: 'shell', arguments: '{}' });
      throw abort;
    },
  };

  await assert.rejects(
    sendWithRecovery({
      ...baseCtx,
      provider,
      opts,
      transportRetriesUsed: 0,
    }),
    (error) => error === abort
  );
});

function xaiStreamCrash() {
  const err = new Error('xAI Responses stream error: Internal error during token generation');
  err.providerWireError = true;
  err.providerErrorCode = 'invalid_request_error';
  err.providerError = { type: 'invalid_request_error', message: 'Internal error during token generation' };
  return err;
}

async function recoverWithLatestImage(providerName, error) {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
  ];
  const { opts } = recordingOpts();
  return await sendWithRecovery({
    ...baseCtx,
    messages,
    provider: { send: async () => { throw error; } },
    opts,
    sessionRef: { id: 'sess-image-strip-scope', provider: providerName, contextWindow: 200_000 },
    transportRetriesUsed: 0,
  });
}

test('a bare retryable stream error strips images only for Grok; others take normal transport retry', async () => {
  const grok = await recoverWithLatestImage('grok-oauth', xaiStreamCrash());
  assert.equal(grok.action, 'retry_image_strip');
  // Not an image-strip: the error is surfaced (or retried as transport), never stripped.
  const other = await recoverWithLatestImage('anthropic', xaiStreamCrash()).catch((error) => ({ action: 'threw', error }));
  assert.notEqual(other.action, 'retry_image_strip');
});

test('a confirmed image rejection still strips the image for any provider', async () => {
  const rejection = Object.assign(new Error('Could not process image'), { status: 400 });
  const result = await recoverWithLatestImage('anthropic', rejection);
  assert.equal(result.action, 'retry_image_strip');
});

test('an Anthropic image preparation failure is a confirmed rejection that strips and persists the image', async () => {
  const { AnthropicImagePreparationError } = await import('../providers/lib/anthropic-image-input.mjs');
  const result = await recoverWithLatestImage(
    'anthropic',
    new AnthropicImagePreparationError('messages.0', 'cannot decode', undefined, 'AAAA')
  );
  assert.equal(result.action, 'retry_image_strip');
  assert.equal(result.persist, true);
});

test('a sharp-unavailable runtime error never strips an image', async () => {
  const { AnthropicImageRuntimeError } = await import('../providers/lib/anthropic-image-input.mjs');
  const result = await recoverWithLatestImage('anthropic', new AnthropicImageRuntimeError('messages.0')).catch(
    (error) => ({ action: 'threw', error })
  );
  assert.notEqual(result.action, 'retry_image_strip');
});
