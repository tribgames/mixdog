import './usage-test-support.mjs';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { UsageLedger, closeUsageLedgers, getUsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { readUsageRequests, requestPageQuery } from './usage-ledger-requests.mjs';
import { accountProviderSend } from './usage-accounting.mjs';
import { noteAbandonedUsage } from './usage-context.mjs';
import { normalizeServedModelId, servedModelSubstituted, usageRequestStatus } from './usage-request-status.mjs';
import { createUsageStatsApi } from '../../../session-runtime/usage-stats-api.mjs';
import { createTitleCompletion } from '../../agent/orchestrator/agent-runtime/title-completion.mjs';
import { parseSSEStream } from '../../agent/orchestrator/providers/anthropic-sse.mjs';
import { createHttpSseResponseState } from '../../agent/orchestrator/providers/openai-http-sse-response-state.mjs';
import { _streamResponse } from '../../agent/orchestrator/providers/openai-ws-stream.mjs';
import { consumeCompatChatCompletionStream } from '../../agent/orchestrator/providers/openai-compat-stream.mjs';
import { EventEmitter } from 'node:events';
import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';

after(() => closeUsageLedgers());

// Older writers this ledger must stay compatible with, each at a fixed
// commit (never HEAD, which moves with every commit). ad4c2593e predates the
// request log (#300): no usage_requests table. e544d62a5 is the deployed #300
// build: it writes usage_requests with seven positional values and times
// only visible text, so its `ttft_ms` is never trusted.
const PRE_REQUEST_LOG_COMMIT = 'ad4c2593e';
const REQUEST_LOG_COMMIT = 'e544d62a5';

/** That commit's ledger module (and its request-log module, when it had
 *  one), beside this one so the rest of its imports resolve. */
async function previousLedgerModule(t, commit) {
  const here = dirname(fileURLToPath(import.meta.url));
  const show = (file) =>
    execFileSync('git', ['show', `${commit}:src/runtime/shared/llm/${file}`], { cwd: here, encoding: 'utf8' });
  const requestsName = `usage-ledger-requests.${commit}-${process.pid}.mjs`;
  const ledgerPath = join(here, `usage-ledger.${commit}-${process.pid}.mjs`);
  let ledger = show('usage-ledger.mjs');
  if (ledger.includes("'./usage-ledger-requests.mjs'")) {
    writeFileSync(join(here, requestsName), show('usage-ledger-requests.mjs'));
    t.after(() => rmSync(join(here, requestsName), { force: true }));
    ledger = ledger.replace("'./usage-ledger-requests.mjs'", `'./${requestsName}'`);
  }
  writeFileSync(ledgerPath, ledger);
  t.after(() => rmSync(ledgerPath, { force: true }));
  return import(pathToFileURL(ledgerPath).href);
}
const completedResponse = (outputTokens) => ({
  id: 'r',
  model: 'gpt-5',
  status: 'completed',
  output: [],
  usage: { input_tokens: 1, output_tokens: outputTokens },
});

const everything = (db, extra = {}) => readUsageRequests(db, { fromMs: 0, toMs: Date.now() + 1000, ...extra });

function useLedger(t) {
  const path = join(makeTempDirSync('request-log'), 'ledger.sqlite');
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
  });
  return (extra) => {
    const ledger = new UsageLedger(path);
    try {
      return everything(ledger.db, extra).requests;
    } finally {
      ledger.close();
    }
  };
}

test('a version 2 ledger gains the request table and stays version 2; its rows read as completed', () => {
  const path = join(makeTempDirSync('request-log-v2'), 'ledger.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE usage_routes (id INTEGER PRIMARY KEY, signature TEXT NOT NULL UNIQUE);
    CREATE TABLE usage_sessions (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE);
    CREATE TABLE usage_events (
      id BLOB PRIMARY KEY, ts INTEGER NOT NULL, day INTEGER NOT NULL,
      route INTEGER NOT NULL REFERENCES usage_routes(id), session INTEGER NOT NULL REFERENCES usage_sessions(id),
      input REAL NOT NULL, output REAL NOT NULL, cache_read REAL NOT NULL, cache_write REAL NOT NULL,
      cost_usd REAL, duration_ms REAL NOT NULL) WITHOUT ROWID;
    CREATE INDEX usage_events_time ON usage_events(ts);
    INSERT INTO usage_routes VALUES (1, '["openai","gpt-5","api","lead","catalog",null,"live",0]');
    INSERT INTO usage_sessions VALUES (1, 'old-session');
    PRAGMA user_version=2;`);
  const insert = db.prepare('INSERT INTO usage_events VALUES (?,?,?,1,1,10,20,0,0,0.1,2000)');
  const utf8 = (id) => Buffer.concat([Buffer.from([1]), Buffer.from(id)]);
  insert.run(utf8('request-a'), 1000, 19700101);
  insert.run(utf8('request-a:abandoned:0'), 900, 19700101);
  db.close();

  const ledger = new UsageLedger(path);
  try {
    assert.equal(ledger.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(ledger.db.prepare('PRAGMA table_info(usage_events)').all().length, 11, 'the record shape is unchanged');
    const { requests, models } = everything(ledger.db);
    assert.equal(requests.length, 1, 'the abandoned attempt is not a request of its own');
    assert.equal(requests[0].status, 'completed');
    assert.equal(requests[0].attempts, 1);
    assert.equal(requests[0].ttftMs, null, 'no first-output time');
    assert.deepEqual(models, ['gpt-5']);
  } finally {
    ledger.close();
  }
});

test('status precedence: failed, then substituted, then retried', () => {
  assert.equal(usageRequestStatus({ failed: true, substituted: true, attempts: 3 }), 'failed');
  assert.equal(usageRequestStatus({ substituted: true, attempts: 3 }), 'substituted');
  assert.equal(usageRequestStatus({ attempts: 2 }), 'retried');
  assert.equal(usageRequestStatus({ attempts: 1 }), 'completed');
});

test('dated, prefixed and alias ids of the same model are not substitutions', () => {
  assert.equal(normalizeServedModelId('anthropic/claude-opus-4.8[1m]'), 'claude-opus-4.8');
  const same = (requestedModel, servedModel, provider = 'openai') =>
    !servedModelSubstituted({ provider, requestedModel, servedModel });
  assert.ok(same('claude-opus-5', 'claude-opus-5-20261001', 'anthropic'));
  assert.ok(same('gpt-5.6', 'gpt-5.6-2026-10-01'));
  assert.ok(same('claude-3-opus@20240229', 'claude-3-opus', 'anthropic'));
  assert.ok(same('claude-opus-4-8[1m]', 'claude-opus-4-8-20260101', 'anthropic'));
  assert.ok(same('openai/gpt-5', 'gpt-5'));
  assert.ok(same('claude-sonnet-5-latest', 'claude-sonnet-5-20261001', 'anthropic'));
  assert.ok(same('openrouter/auto', 'anthropic/claude-sonnet-5'));
  assert.ok(!same('gpt-5.1', 'gpt-5-1'), 'a dot is part of the id');
  assert.ok(!same('model-1234', 'model-5678'), 'other digits are part of the id');
  assert.ok(!same('deepseek-v4', 'deepseek-v3'));
  assert.ok(!same('gpt-5.6', 'gpt-5.6-luna'));
  assert.ok(!same('meta/llama-4:free', 'meta/llama-4'), 'a provider tag is kept');
  assert.ok(same('gemini-3-pro', 'gemini-3-flash', 'gemini'), 'Gemini never reports the served model');
  assert.ok(
    servedModelSubstituted({ provider: 'anthropic', requestedModel: 'm', servedModel: 'm', fallback: true }),
    'an Anthropic fallback block is a substitution'
  );
});

test('a send records its answering model, substitution, attempts and first-output time', async (t) => {
  const read = useLedger(t);
  const deltas = [];
  await accountProviderSend(
    'openai',
    {},
    async (opts) => {
      noteAbandonedUsage({ inputTokens: 5, outputTokens: 1 }, 'gpt-5');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const firstOutputAt = Date.now();
      opts.onStreamDelta('text');
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        content: 'x',
        model: 'gpt-5-mini-2026-01-01',
        usage: { inputTokens: 100, outputTokens: 400 },
        generationMs: Date.now() - firstOutputAt,
      };
    },
    'gpt-5',
    { sessionId: 's', onStreamDelta: (kind) => deltas.push(kind) }
  );
  assert.deepEqual(deltas, ['text'], 'the caller still sees its progress');
  const [row] = read();
  assert.equal(row.model, 'gpt-5-mini-2026-01-01');
  assert.equal(row.requestedModel, 'gpt-5');
  assert.equal(row.status, 'substituted', 'substitution outranks the retry');
  assert.equal(row.attempts, 2, 'the abandoned attempt is folded into its request');
  assert.ok(row.ttftMs >= 15 && row.ttftMs < row.durationMs);
  assert.equal(read().length, 1);
});

test('the first-output time excludes the write of an abandoned attempt that follows the stream', async (t) => {
  const read = useLedger(t);
  const ledger = getUsageLedger();
  const write = ledger.recordQueued.bind(ledger);
  ledger.recordQueued = async (row) => {
    if (String(row.id).includes(':abandoned:')) await new Promise((resolve) => setTimeout(resolve, 300));
    return write(row);
  };
  await accountProviderSend(
    'openai',
    {},
    async () => {
      noteAbandonedUsage({ inputTokens: 5, outputTokens: 1 }, 'gpt-5');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const firstOutputAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { content: 'x', usage: { inputTokens: 1, outputTokens: 4 }, generationMs: Date.now() - firstOutputAt };
    },
    'gpt-5',
    { sessionId: 's' }
  );
  const [row] = read();
  assert.ok(row.durationMs >= 350, 'the total duration still covers the accounting write');
  assert.ok(row.ttftMs < 200, `first output at ${row.ttftMs}ms, not after the abandoned write`);
});

test('a stream whose first output is silent thinking times generation from the thinking item', async (t) => {
  const read = useLedger(t);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const THINKING_MS = 200;
  const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  // Anthropic with thinking display "updates": the thinking block opens, then
  // nothing but its signature arrives once the thinking is done.
  const anthropic = async (opts) => {
    const encoder = new TextEncoder();
    const parts = [
      [0, frame({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1 } } })],
      [0, frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })],
      [THINKING_MS, frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } })],
      [0, frame({ type: 'content_block_stop', index: 0 })],
      [0, frame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'list', input: {} } })],
      [0, frame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } })],
      [0, frame({ type: 'content_block_stop', index: 1 })],
      [0, frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 400 } })],
      [0, frame({ type: 'message_stop' })],
    ];
    const body = new ReadableStream({
      async start(controller) {
        for (const [delay, text] of parts) {
          if (delay) await sleep(delay);
          controller.enqueue(encoder.encode(text));
        }
        controller.close();
      },
    });
    const result = await parseSSEStream(
      new Response(body, { status: 200 }),
      new AbortController().signal,
      () => {},
      opts.onStreamDelta,
      () => {},
      {},
      null,
      new Set(['list']),
      { onStreamItemStart: opts.onStreamItemStart }
    );
    return { ...result, usage: { inputTokens: 1, outputTokens: 400 } };
  };
  // Codex / Responses: the reasoning item opens, its summary and the answer
  // follow once the hidden reasoning is done.
  const responses = async (opts) => {
    const state = createHttpSseResponseState({
      body: { tools: [] },
      onStreamItemStart: opts.onStreamItemStart,
      meaningful: (kind) => opts.onStreamDelta(kind),
      lifecycle() {},
      onServerEvent() {},
      label: 'test',
    });
    state.handleEvent({ type: 'response.created', response: { id: 'r1', model: 'gpt-5' } });
    state.handleEvent({ type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs1', summary: [] } });
    await sleep(THINKING_MS);
    state.handleEvent({ type: 'response.reasoning_summary_text.delta', item_id: 'rs1', delta: 'Plan' });
    state.handleEvent({ type: 'response.output_item.added', item: { type: 'message', id: 'm1', content: [] } });
    state.handleEvent({ type: 'response.output_text.delta', item_id: 'm1', delta: 'ok' });
    state.handleEvent({ type: 'response.completed', response: completedResponse(400) });
    return state.finish({ useModel: 'gpt-5', poolKey: null, iteration: null, sseStartedAt: Date.now(), ttftMs: null });
  };
  for (const [provider, model, send] of [
    ['anthropic-oauth', 'claude-opus-5-5', anthropic],
    ['openai-oauth', 'gpt-5', responses],
  ]) {
    await accountProviderSend(provider, {}, send, model, { sessionId: provider, onStreamDelta: () => {} });
  }
  for (const row of read()) {
    assert.ok(
      row.durationMs - row.ttftMs >= THINKING_MS - 10,
      `${row.provider}: first output at the thinking item, so the thinking is generation time (${row.ttftMs}ms)`
    );
  }
});

test('a WebSocket retry whose abandoned attempt reported no usage is timed by the answering stream', async (t) => {
  const read = useLedger(t);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const ANSWER_MS = 120;
  const attempt = async (opts, { fail }) => {
    const socket = new EventEmitter();
    socket.readyState = 1;
    socket.close = () => {
      socket.readyState = 3;
    };
    socket.terminate = socket.close;
    const pending = _streamResponse({
      entry: { socket, ephemeral: true },
      externalSignal: null,
      onStreamDelta: opts.onStreamDelta,
      state: { sessionId: 'ws-retry' },
      logSuppressedReasoningDeltas: false,
    });
    const emit = (event) => socket.emit('message', Buffer.from(JSON.stringify(event)));
    emit({ type: 'response.created', response: { id: 'r', model: 'gpt-5' } });
    emit({ type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs' } });
    await sleep(ANSWER_MS);
    if (fail) {
      // The connection drops mid-reasoning: no terminal frame, no usage.
      socket.emit('error', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
      return pending;
    }
    emit({ type: 'response.completed', response: completedResponse(300) });
    return pending;
  };
  await accountProviderSend(
    'openai-oauth',
    {},
    async (opts) => {
      // The abandoned attempt and the reconnect backoff that follows it.
      await attempt(opts, { fail: true }).catch(() => {});
      opts.onStageChange?.('reconnecting', { attempt: 1, max: 3 });
      await sleep(150);
      return attempt(opts, { fail: false });
    },
    'gpt-5',
    { sessionId: 'ws', onStreamDelta: () => {} }
  );
  const [row] = read();
  const generationMs = row.durationMs - row.ttftMs;
  assert.ok(
    generationMs >= ANSWER_MS - 10 && generationMs < ANSWER_MS + 100,
    `only the answering stream's generation is timed (${generationMs}ms of ${row.durationMs}ms)`
  );
});

test('a provider whose stream may hide reasoning records no first-output time; a local one does', async (t) => {
  const read = useLedger(t);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A chat stream: its result times the first visible delta.
  const chat = async (opts) => {
    const chunks = async function* () {
      await sleep(20);
      yield { choices: [{ delta: { content: 'Hel' } }] };
      await sleep(150);
      yield { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] };
    };
    const assembled = await consumeCompatChatCompletionStream(chunks(), {
      label: 'chat',
      providerName: 'chat',
      onStreamDelta: opts.onStreamDelta,
      parseToolCalls: () => [],
    });
    return { ...assembled, usage: { inputTokens: 1, outputTokens: 300 } };
  };
  // A gateway may have reasoned, hidden, before that first delta.
  await accountProviderSend('openrouter', {}, chat, 'some/model', { sessionId: 'gateway', onStreamDelta: () => {} });
  // The local server streams every generated token, reasoning included.
  await accountProviderSend('mixdog-local', {}, chat, 'local', { sessionId: 'local', onStreamDelta: () => {} });
  const rows = Object.fromEntries(read().map((row) => [row.sessionId, row]));
  assert.equal(rows.gateway.ttftMs, null);
  assert.ok(rows.local.durationMs - rows.local.ttftMs >= 140, 'timed from the first delta');
});

test('only a provider re-send of the same send answers its requested model', async (t) => {
  const read = useLedger(t);
  const answer = (model) => async () => ({ content: 'x', model, usage: { inputTokens: 1, outputTokens: 1 } });
  await accountProviderSend(
    'anthropic-oauth',
    {},
    async (leadOpts) => {
      // An agent started by a tool dispatched while the lead's stream is live
      // runs inside the lead's async context, on its own model.
      await accountProviderSend('anthropic-oauth', {}, answer('claude-sonnet-5-5'), 'claude-sonnet-5-5', {
        sessionId: 'worker',
      });
      // The provider's own fallback re-send is built from the lead's options.
      return accountProviderSend('anthropic-oauth', {}, answer('claude-sonnet-5-5'), 'claude-sonnet-5-5', {
        ...leadOpts,
        _fallbackTriggered: true,
      });
    },
    'claude-opus-5-5',
    { sessionId: 'lead' }
  );
  const rows = Object.fromEntries(read().map((row) => [row.sessionId, row]));
  assert.deepEqual(Object.keys(rows).sort(), ['lead', 'worker']);
  assert.deepEqual([rows.worker.status, rows.worker.requestedModel], ['completed', 'claude-sonnet-5-5']);
  assert.deepEqual([rows.lead.status, rows.lead.requestedModel], ['substituted', 'claude-opus-5-5']);
});

test('a request answered on a configured fallback hop lists the primary route it asked for', async (t) => {
  const read = useLedger(t);
  const answer = (model) => async () => ({ content: 'x', model, usage: { inputTokens: 1, outputTokens: 1 } });
  const primary = { provider: 'anthropic-oauth', model: 'claude-opus-5-5' };
  const hopped = (provider) => ({ provider, routeFallbackPrimary: primary, routeFallbackIndex: 2 });
  // A second hop still asks for the primary, not the hop it left.
  await accountProviderSend('openai', {}, answer('gpt-5'), 'gpt-5', { sessionId: 'hop', session: hopped('openai') });
  // The same model name on another provider is still a hop.
  await accountProviderSend('openrouter', {}, answer('claude-opus-5-5'), 'claude-opus-5-5', {
    sessionId: 'same-name',
    session: hopped('openrouter'),
  });
  // The hop's request failing is still asked of the primary route.
  await assert.rejects(
    accountProviderSend('openai', {}, async () => Promise.reject(new Error('down')), 'gpt-5', {
      sessionId: 'hop-failed',
      session: hopped('openai'),
    })
  );
  // A hop within one provider names no other provider.
  await accountProviderSend('anthropic-oauth', {}, answer('claude-sonnet-5-5'), 'claude-sonnet-5-5', {
    sessionId: 'same-provider-hop',
    session: hopped('anthropic-oauth'),
  });
  // Ordinary, same-provider-substituted and primary-route requests are unchanged.
  await accountProviderSend('openai', {}, answer('gpt-5'), 'gpt-5', { sessionId: 'plain', session: { provider: 'openai' } });
  await accountProviderSend('openai', {}, answer('gpt-5-mini'), 'gpt-5', { sessionId: 'swapped' });
  await accountProviderSend('anthropic-oauth', {}, answer(primary.model), primary.model, {
    sessionId: 'primary',
    session: hopped('anthropic-oauth'),
  });
  // A send that is not on the hop's route (another provider under the session) asks for itself.
  await accountProviderSend('gemini', {}, answer('gemini-3'), 'gemini-3', { sessionId: 'other', session: hopped('openai') });

  const rows = Object.fromEntries(read().map((row) => [row.sessionId, row]));
  const shape = (id) => [rows[id].status, rows[id].requestedProvider, rows[id].requestedModel, rows[id].provider];
  assert.deepEqual(shape('hop'), ['substituted', 'anthropic-oauth', 'claude-opus-5-5', 'openai']);
  assert.deepEqual(shape('same-name'), ['substituted', 'anthropic-oauth', 'claude-opus-5-5', 'openrouter']);
  assert.deepEqual(shape('hop-failed'), ['failed', 'anthropic-oauth', 'claude-opus-5-5', 'openai']);
  assert.deepEqual(shape('same-provider-hop'), ['substituted', '', 'claude-opus-5-5', 'anthropic-oauth']);
  assert.deepEqual(shape('plain'), ['completed', '', 'gpt-5', 'openai']);
  assert.deepEqual(shape('swapped'), ['substituted', '', 'gpt-5', 'openai']);
  assert.deepEqual(shape('primary'), ['completed', '', 'claude-opus-5-5', 'anthropic-oauth']);
  assert.deepEqual(shape('other'), ['completed', '', 'gemini-3', 'gemini']);
  // The filters still read the answering route and the status.
  assert.deepEqual(
    read({ status: 'substituted', model: 'gpt-5' }).map((row) => row.sessionId),
    ['hop']
  );
});

test('a retried send with a dated id of its model reads as retried', async (t) => {
  const read = useLedger(t);
  await accountProviderSend(
    'anthropic',
    {},
    async () => {
      noteAbandonedUsage({ inputTokens: 5 }, 'claude-opus-4-8');
      return { content: 'x', model: 'claude-opus-4-8-20260101', usage: { inputTokens: 10, outputTokens: 10 } };
    },
    'claude-opus-4-8',
    { sessionId: 's' }
  );
  const [row] = read();
  assert.equal(row.status, 'retried');
  assert.equal(row.ttftMs, null);
});

test('a failed send without usage is recorded as a failed request with zero tokens', async (t) => {
  const read = useLedger(t);
  await assert.rejects(
    accountProviderSend(
      'openai',
      {},
      async () => {
        throw new Error('boom');
      },
      'gpt-5',
      { sessionId: 's' }
    ),
    /boom/
  );
  const [row] = read();
  assert.equal(row.status, 'failed');
  assert.equal(row.tokens, 0);
  assert.deepEqual(read({ status: 'failed' }).length, 1);
  assert.deepEqual(read({ status: 'completed' }).length, 0);
});

test('a usage-less failure after a billed abandoned attempt is its own final attempt', async (t) => {
  const read = useLedger(t);
  await assert.rejects(
    accountProviderSend(
      'openai',
      {},
      async () => {
        noteAbandonedUsage({ inputTokens: 50, outputTokens: 5 }, 'gpt-5');
        throw new Error('second attempt failed');
      },
      'gpt-5',
      { sessionId: 's' }
    ),
    /second attempt failed/
  );
  const [row] = read();
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2);
  assert.equal(row.tokens, 0, 'the billed attempt stays its own (abandoned) record');
  assert.ok(row.durationMs >= 0);
});

test('a cancelled send keeps its noted attempt as an abandoned record and lists no request', async (t) => {
  const path = join(makeTempDirSync('request-log-cancel'), 'ledger.sqlite');
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
  });
  const controller = new AbortController();
  await assert.rejects(
    accountProviderSend(
      'openai',
      {},
      async () => {
        noteAbandonedUsage({ inputTokens: 50, outputTokens: 5 }, 'gpt-5');
        controller.abort(new Error('caller cancel'));
        throw controller.signal.reason;
      },
      'gpt-5',
      { sessionId: 's', signal: controller.signal }
    ),
    /caller cancel/
  );
  const ledger = new UsageLedger(path);
  try {
    assert.deepEqual(everything(ledger.db).requests, [], 'a cancel is not a listed request');
    const records = ledger.db.prepare('SELECT id,input,output FROM events').all();
    assert.equal(records.length, 1, 'the noted attempt is recorded once, as before');
    assert.match(records[0].id, /:abandoned:0$/);
    assert.equal(records[0].input + records[0].output, 55);
  } finally {
    ledger.close();
  }
});

test('a cancel carrying its response usage keeps the response-keyed record: re-recorded, it counts once, unlisted', async (t) => {
  const path = join(makeTempDirSync('request-log-cancel-response'), 'ledger.sqlite');
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
  });
  const cancelOnce = () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancel'));
    return assert.rejects(
      accountProviderSend(
        'openai',
        {},
        async () => {
          throw Object.assign(controller.signal.reason, {
            usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
            model: 'gpt-5',
            responseId: 'resp-1',
          });
        },
        'gpt-5',
        { sessionId: 's', signal: controller.signal }
      ),
      /caller cancel/
    );
  };
  await cancelOnce();
  await cancelOnce();
  const ledger = new UsageLedger(path);
  try {
    const records = ledger.db.prepare('SELECT id,input,output,cost_usd FROM events').all();
    assert.equal(records.length, 1, 'the same response is one record');
    assert.match(records[0].id, /^[0-9a-f]{64}$/, 'keyed by the response, as before');
    const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
    const { totals } = await api.getUsageStats({ view: 'hour' });
    assert.deepEqual([totals.tokens, totals.costUsd], [12, 0.01]);
    assert.deepEqual(everything(ledger.db).requests, [], 'a cancel is not a listed request');
    assert.deepEqual(everything(ledger.db).models, []);
  } finally {
    ledger.close();
  }
});

test('a cancelled send that reported nothing records nothing', async (t) => {
  const read = useLedger(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    accountProviderSend(
      'openai',
      {},
      async () => {
        throw new Error('cancelled');
      },
      'gpt-5',
      { sessionId: 's', signal: controller.signal }
    )
  );
  assert.equal(read().length, 0);
});

test('a failure that reported no usage is listed but adds no turn to session or day totals', async () => {
  const ledger = new UsageLedger(':memory:');
  try {
    const ts = Date.now() - 1000;
    const base = { provider: 'openai', model: 'gpt-5', sessionId: 's', sourceType: 'lead' };
    ledger.record([
      makeUsageRecord({ ...base, ts, inputTokens: 10, outputTokens: 5, costUsd: 0.01 }),
      makeUsageRecord({ ...base, ts: ts + 1, status: 'failed', inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    ]);
    assert.equal(everything(ledger.db).requests.length, 2, 'both are listed');
    const session = await ledger.sessionUsageAsync(['s']);
    assert.deepEqual([session.turns, session.costKnownTurns], [1, 1]);
    const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
    assert.equal((await api.getUsageStats({ view: 'hour' })).totals.turns, 1);
    assert.equal((await api.getUsageStats({ view: '7d' })).totals.turns, 1);
  } finally {
    ledger.close();
  }
});

test('a usage-less failure in another session adds no session to the statistics', async () => {
  const ledger = new UsageLedger(':memory:');
  try {
    const ts = Date.now() - 1000;
    const base = { provider: 'openai', model: 'gpt-5', sourceType: 'lead' };
    ledger.record([
      makeUsageRecord({ ...base, sessionId: 's', ts, inputTokens: 10, outputTokens: 2, costUsd: 0.01 }),
      makeUsageRecord({ ...base, sessionId: 's2', ts: ts + 1, status: 'failed', inputTokens: 0, outputTokens: 0 }),
    ]);
    const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
    for (const view of ['hour', '7d']) {
      assert.equal((await api.getUsageStats({ view })).totals.sessions, 1, view);
    }
  } finally {
    ledger.close();
  }
});

test('getUsageRequests with asOf keeps the first page\'s rolling 24-hour bounds', async () => {
  const ledger = new UsageLedger(':memory:');
  try {
    const now = Date.now();
    ledger.record([
      makeUsageRecord({ ts: now - 24 * 3_600_000 - 5000, provider: 'openai', model: 'gpt-5', sessionId: 's', sourceType: 'lead', inputTokens: 1 }),
    ]);
    const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
    assert.equal((await api.getUsageRequests({})).requests.length, 0, 'a fresh window has slid past the row');
    const pinned = await api.getUsageRequests({ asOf: now - 10_000 });
    assert.equal(pinned.generatedAt, now - 10_000);
    assert.equal(pinned.requests.length, 1, 'the pinned window still holds it');
    await assert.rejects(api.getUsageRequests({ asOf: Date.now() + 3_600_000 }), RangeError);
  } finally {
    ledger.close();
  }
});

test('getUsageRequests names an internal dispatch by its source type, even when its session file is gone', async () => {
  const ledger = new UsageLedger(':memory:');
  after(() => ledger.close());
  const now = Date.now();
  const sources = [
    ['memory', 'memory-cycle'],
    ['web', 'native-web-search'],
    ['warm', 'cache-warm'],
    ['run', 'exec'],
    ['nightly', 'schedule'],
    ['hook', 'webhook'],
    ['dev', 'lead'],
    ['other', 'some-new-runner'],
  ];
  ledger.record(
    sources.map(([sessionId, sourceType], index) =>
      makeUsageRecord({
        id: `s${index}`,
        ts: now - (index + 1) * 60_000,
        provider: 'openai',
        model: 'gpt-5',
        sessionId,
        sourceType,
        inputTokens: 1,
      })
    )
  );
  const metadata = {
    // Stored as a real memory-cycle dispatch is: an agent-owned session.
    memory: {
      title: 'Length target: about 2000 characters',
      sourceType: 'memory-cycle',
      owner: 'agent',
      agent: 'maintenance',
    },
    nightly: { title: 'Nightly report', sourceType: 'schedule' },
    dev: { title: 'Dev session' },
  };
  const api = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {},
    sessionMetadata: async (id) => metadata[id] ?? null,
  });
  const { requests } = await api.getUsageRequests({});
  assert.deepEqual(
    requests.map((row) => [row.internalKind, row.sessionTitle]),
    [
      ['memory-cycle', ''],
      ['native-web-search', ''],
      ['cache-warm', ''],
      ['exec', ''],
      ['', 'Nightly report'],
      ['', ''],
      ['', 'Dev session'],
      ['', ''],
    ]
  );
  assert.ok(requests.every((row) => !('sourceType' in row)), 'the route detail stays inside the API');
});

test('a background request on a session the user can open keeps its label and adds the kind', async () => {
  const ledger = new UsageLedger(':memory:');
  after(() => ledger.close());
  const now = Date.now();
  // A cache warm-up records under the real session id and its owner.
  ledger.record([
    makeUsageRecord({ id: 'w0', ts: now - 60_000, provider: 'openai', model: 'gpt-5', sessionId: 'reviewer', ownerSessionId: 'dev', sourceType: 'cache-warm', inputTokens: 1 }),
    makeUsageRecord({ id: 'w1', ts: now - 120_000, provider: 'openai', model: 'gpt-5', sessionId: 'dev', sourceType: 'cache-warm', inputTokens: 1 }),
    makeUsageRecord({ id: 'w2', ts: now - 180_000, provider: 'openai', model: 'gpt-5', sessionId: 'dev', sourceType: 'lead', inputTokens: 1 }),
  ]);
  const metadata = {
    dev: { title: 'Dev session', sourceType: 'lead' },
    reviewer: { title: 'agent', agent: 'reviewer', ownerSessionId: 'dev', sourceType: 'cli' },
  };
  const api = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {},
    sessionMetadata: async (id) => metadata[id] ?? null,
  });
  const { requests } = await api.getUsageRequests({});
  assert.deepEqual(
    requests.map((row) => [row.sessionTitle, row.agentRole, row.agent, row.internalKind, row.backgroundKind]),
    [
      ['Dev session', 'reviewer', true, '', 'cache-warm'],
      ['Dev session', '', false, '', 'cache-warm'],
      ['Dev session', '', false, '', ''],
    ]
  );
});

test('a title call is recorded under the session it titles and the request log names it a title call', async (t) => {
  useLedger(t);
  const generate = createTitleCompletion({
    loadConfig: () => ({ providers: {} }),
    resolveMaintenanceRoute: () => ({ provider: 'openai', model: 'gpt-5' }),
    initProviders: async () => {},
    getProvider: () => ({
      send: (messages, model, tools, opts) =>
        accountProviderSend(
          'openai',
          {},
          async () => ({ content: 'Parser refactor', model, usage: { inputTokens: 10, outputTokens: 3 } }),
          model,
          opts
        ),
    }),
  });
  assert.equal(await generate('Refactor the parser.', { sessionId: 'dev' }), 'Parser refactor');
  const metadata = { dev: { title: 'Dev session', sourceType: 'lead' } };
  const api = createUsageStatsApi({
    ledger: getUsageLedger,
    importHistory: async () => {},
    sessionMetadata: async (id) => metadata[id] ?? null,
  });
  const { requests } = await api.getUsageRequests({});
  assert.deepEqual(
    requests.map((row) => [row.sessionTitle, row.internalKind, row.backgroundKind]),
    [['Dev session', '', 'session-title']]
  );
});

test('getUsageRequests pages with a cursor, filters by status and model, and lists the period models', async () => {
  const ledger = new UsageLedger(':memory:');
  after(() => ledger.close());
  const now = Date.now();
  const rows = [];
  for (let index = 0; index < 7; index += 1) {
    rows.push(
      makeUsageRecord({
        id: `r${index}`,
        ts: now - (index + 1) * 60_000,
        provider: index % 2 ? 'anthropic' : 'openai',
        model: index % 2 ? 'claude-opus-4-8' : 'gpt-5',
        sessionId: index === 0 ? 'agent-session' : 'lead-session',
        ...(index === 0 ? { ownerSessionId: 'lead-session' } : {}),
        sourceType: 'lead',
        inputTokens: 10,
        outputTokens: 10,
        status: index === 2 ? 'failed' : 'completed',
      })
    );
  }
  // Older than the 24-hour view: in "all" only.
  rows.push(
    makeUsageRecord({ id: 'old', ts: now - 3 * 86_400_000, provider: 'xai', model: 'grok-4.20', sessionId: 'x', sourceType: 'lead', inputTokens: 1 })
  );
  ledger.record(rows);
  const metadata = {
    'lead-session': { title: 'Dev session' },
    'agent-session': { title: 'agent', agent: 'reviewer', ownerSessionId: 'lead-session' },
  };
  const api = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {},
    sessionMetadata: async (id) => metadata[id] ?? null,
  });

  const first = await api.getUsageRequests({ limit: 3 });
  assert.deepEqual(
    first.requests.map((row) => row.id),
    ['r0', 'r1', 'r2'].map((id) => Buffer.concat([Buffer.from([1]), Buffer.from(id)]).toString('hex'))
  );
  assert.deepEqual(first.models, ['claude-opus-4-8', 'gpt-5'], 'only models that answered in the period');
  assert.deepEqual(
    [first.requests[0].sessionTitle, first.requests[0].agentRole, first.requests[0].agent],
    ['Dev session', 'reviewer', true]
  );
  assert.deepEqual([first.requests[1].sessionTitle, first.requests[1].agent], ['Dev session', false]);
  const second = await api.getUsageRequests({ limit: 3, cursor: first.nextCursor });
  const third = await api.getUsageRequests({ limit: 3, cursor: second.nextCursor });
  assert.equal(second.requests.length, 3);
  assert.equal(third.requests.length, 1);
  assert.equal(third.nextCursor, null);
  assert.deepEqual((await api.getUsageRequests({ status: 'failed' })).requests.length, 1);
  const anthropic = await api.getUsageRequests({ model: 'claude-opus-4-8', limit: 2 });
  assert.ok(anthropic.requests.every((row) => row.model === 'claude-opus-4-8'));
  const anthropicRest = await api.getUsageRequests({ model: 'claude-opus-4-8', limit: 2, cursor: anthropic.nextCursor });
  assert.equal(anthropic.requests.length + anthropicRest.requests.length, 3);
  const all = await api.getUsageRequests({ view: 'year' });
  assert.equal(all.requests.length, 8);
  assert.deepEqual(all.models, ['claude-opus-4-8', 'gpt-5', 'grok-4.20']);
});

test('each request log page reads an index in time order and looks routes up by key', (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  const plan = (sql) =>
    ledger.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(sql.match(/\?/g) || []).map((_, index) => index))
      .map((row) => row.detail)
      .join(' | ');
  const pages = [
    ['all', requestPageQuery({ source: 'time', cursor: true }), 'usage_events_time'],
    ['completed', requestPageQuery({ source: 'time', cursor: true, completed: true }), 'usage_events_time'],
    ['failed', requestPageQuery({ source: 'status', cursor: true }), 'usage_requests_status_time'],
    ['failed + model', requestPageQuery({ source: 'status', cursor: true, routes: 2 }), 'usage_requests_status_time'],
    ['model route', requestPageQuery({ source: 'route', cursor: true }), 'usage_events_route_time'],
  ];
  for (const [name, sql, index] of pages) {
    const detail = plan(sql);
    t.diagnostic(`${name}: ${detail}`);
    assert.match(detail, new RegExp(index));
    assert.doesNotMatch(detail, /TEMP B-TREE|SCAN usage_routes|SCAN e\b|SCAN r\b/);
  }
  const lookup = plan(`SELECT id FROM usage_routes WHERE json_extract(signature,'$[1]')=?`);
  t.diagnostic(`model routes: ${lookup}`);
  assert.match(lookup, /usage_routes_model/);
});

test('statistics and quota views count every reported token once, time only the answer and list failed sends', async (t) => {
  const provider = 'anthropic-oauth';
  const model = 'claude-opus-4-8';
  const usage = (input, output) => ({ inputTokens: input, outputTokens: output });
  // Every failure shape the request log records differently from before.
  const scenarios = (send) => [
    // Retried success: one billed abandoned attempt, then the answer.
    () =>
      send(provider, {}, async () => {
        noteAbandonedUsage(usage(300, 30), model);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { content: 'x', model, usage: usage(1000, 200) };
      }, model, { sessionId: 'a' }),
    // A failure carrying its usage.
    () => send(provider, {}, async () => { throw Object.assign(new Error('e1'), { usage: usage(400, 40), model }); }, model, { sessionId: 'b' }),
    // A failure whose usage was noted as abandoned first.
    () =>
      send(provider, {}, async () => {
        const reported = usage(500, 50);
        noteAbandonedUsage(reported, model);
        throw Object.assign(new Error('e2'), { usage: reported, model });
      }, model, { sessionId: 'c' }),
    // A usage-less failure after a billed abandoned attempt.
    () =>
      send(provider, {}, async () => {
        noteAbandonedUsage(usage(600, 60), model);
        throw new Error('e3');
      }, model, { sessionId: 'd' }),
    // A usage-less failure.
    () => send(provider, {}, async () => { throw new Error('e4'); }, model, { sessionId: 'e' }),
    // A cancel whose attempt noted its usage as it stopped.
    () => {
      const controller = new AbortController();
      return send(provider, {}, async () => {
        noteAbandonedUsage(usage(700, 70), model);
        controller.abort(new Error('cancel'));
        throw controller.signal.reason;
      }, model, { sessionId: 'f', signal: controller.signal });
    },
    // A cancel whose error carries its response's usage, recorded twice.
    ...[0, 1].map(() => () => {
      const controller = new AbortController();
      controller.abort(new Error('cancel'));
      return send(provider, {}, async () => {
        throw Object.assign(controller.signal.reason, { usage: usage(800, 80), model, responseId: 'resp-cancel' });
      }, model, { sessionId: 'g', signal: controller.signal });
    }),
  ];
  useLedger(t);
  const ledger = getUsageLedger();
  for (const scenario of scenarios(accountProviderSend)) await scenario().catch(() => {});
  const now = Date.now();
  ledger.recordQuota([
    { provider, account: 'default', label: '5H', ts: now - 60_000, usedPct: 10, resetAt: now + 3_600_000 },
    { provider, account: 'default', label: '5H', ts: now, usedPct: 30, resetAt: now + 3_600_000 },
  ]);
  const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
  const { totals, providers } = await api.getUsageStats({ view: 'hour' });
  const quota = await api.getQuotaHistory({ provider, account: 'default', window: '5H' });

  // Every reported attempt once (the response-keyed cancel recorded twice is
  // one record). A failure that reported nothing is listed, not counted.
  const input = 300 + 1000 + 400 + 500 + 600 + 700 + 800;
  const output = 30 + 200 + 40 + 50 + 60 + 70 + 80;
  assert.equal(totals.tokens, input + output, 'every reported token once');
  assert.equal(totals.turns, 7, 'the 7 billed attempts; failures that reported nothing add no turn');
  // Priced at the model's own rates, per token, once.
  const rates = JSON.parse(ledger.db.prepare('SELECT signature FROM usage_routes LIMIT 1').get().signature)[5];
  const { inputCostPerM, outputCostPerM } = JSON.parse(rates);
  assert.ok(inputCostPerM > 0 && outputCostPerM > 0, 'the model is priced');
  const cost = (input * inputCostPerM + output * outputCostPerM) / 1e6;
  assert.ok(Math.abs(totals.costUsd - cost) < 1e-6, `cost ${totals.costUsd} is the tokens' price ${cost}`);

  // Only the completed answer is timed; its speed is output over its time.
  const timed = ledger.db.prepare('SELECT output,duration_ms FROM events WHERE duration_ms>0').all();
  assert.deepEqual(
    timed.map((row) => row.output),
    [200]
  );
  assert.equal(Math.round(providers[0].outputTokensPerSecond), Math.round(200 / (timed[0].duration_ms / 1000)));

  // The quota window attributes the same sends to the model.
  assert.equal(quota.models.length, 1, 'the quota window attributes the sends');
  const [quotaModel] = quota.models;
  assert.deepEqual(
    [quotaModel.model, quotaModel.turns, quotaModel.input, quotaModel.output, quotaModel.tokens],
    [model, 7, input, output, input + output]
  );
  assert.ok(Math.abs(quotaModel.costUsd - cost) < 1e-6);
  assert.equal(Math.round(quotaModel.outputTokensPerSecond), Math.round(providers[0].outputTokensPerSecond));

  // The request log lists the sends, failures included; cancels are not requests.
  const requests = everything(ledger.db).requests;
  assert.deepEqual(requests.map((row) => row.status).sort(), ['failed', 'failed', 'failed', 'failed', 'retried']);
});

test('a ledger this build touched is opened and written by the previous build', async (t) => {
  const { UsageLedger: PreviousLedger, makeUsageRecord: previousRecord } = await previousLedgerModule(
    t,
    PRE_REQUEST_LOG_COMMIT
  );

  const path = join(makeTempDirSync('request-log-downgrade'), 'ledger.sqlite');
  const current = new UsageLedger(path);
  const ts = Date.now() - 1000;
  current.record([
    makeUsageRecord({ id: 'new', ts, provider: 'openai', model: 'gpt-5', sessionId: 's', sourceType: 'lead', inputTokens: 5, status: 'failed', ttftMs: 3 }),
  ]);
  current.close();

  const older = new PreviousLedger(path);
  try {
    assert.equal(
      older.record([previousRecord({ id: 'old', ts: ts + 1, provider: 'openai', model: 'gpt-5', sessionId: 's', sourceType: 'lead', inputTokens: 7 })]),
      1
    );
    assert.equal(older.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
  } finally {
    older.close();
  }
  const reopened = new UsageLedger(path);
  try {
    const { requests } = everything(reopened.db);
    assert.deepEqual(
      requests.map((row) => [row.tokens, row.status]),
      [
        [7, 'completed'],
        [5, 'failed'],
      ],
      "the previous build's record reads as completed"
    );
  } finally {
    reopened.close();
  }
});

test('the deployed request-log build opens and writes a ledger holding fallback-hop requests', async (t) => {
  const { UsageLedger: DeployedLedger, makeUsageRecord: deployedRecord } = await previousLedgerModule(
    t,
    REQUEST_LOG_COMMIT
  );
  const path = join(makeTempDirSync('request-log-hop'), 'ledger.sqlite');
  const ts = Date.now() - 1000;
  const fields = { provider: 'openai', model: 'gpt-5', sessionId: 's', sourceType: 'lead' };
  const current = new UsageLedger(path);
  current.record([
    makeUsageRecord({
      ...fields,
      id: 'hop',
      ts,
      outputTokens: 5,
      requestedProvider: 'anthropic-oauth',
      requestedModel: 'claude-opus-5-5',
      status: 'substituted',
    }),
  ]);
  current.close();

  const deployed = new DeployedLedger(path);
  try {
    assert.equal(
      deployed.record([
        deployedRecord({ ...fields, id: 'older', ts: ts + 1, outputTokens: 7, requestedModel: 'gpt-5-mini', status: 'substituted' }),
      ]),
      1
    );
  } finally {
    deployed.close();
  }

  const reopened = new UsageLedger(path);
  try {
    const rows = everything(reopened.db).requests;
    assert.deepEqual(
      rows.map((row) => [row.output, row.status, row.requestedModel, row.requestedProvider]),
      [
        [7, 'substituted', 'gpt-5-mini', ''],
        [5, 'substituted', 'claude-opus-5-5', 'anthropic-oauth'],
      ]
    );
  } finally {
    reopened.close();
  }
});

test('the deployed request-log build still writes this ledger, and only this build’s first-output times count', async (t) => {
  const { UsageLedger: DeployedLedger, makeUsageRecord: deployedRecord } = await previousLedgerModule(
    t,
    REQUEST_LOG_COMMIT
  );
  const path = join(makeTempDirSync('request-log-deployed'), 'ledger.sqlite');
  const ts = Date.now() - 1000;
  const fields = { provider: 'anthropic-oauth', model: 'claude-opus-5-5', sessionId: 's', sourceType: 'lead' };
  const current = new UsageLedger(path);
  current.record([
    makeUsageRecord({ ...fields, id: 'trusted', ts, outputTokens: 500, durationMs: 6000, ttftMs: 1000 }),
  ]);
  current.close();

  // The deployed build opens the changed schema and writes with its own
  // insert shape, a first-output time measured from visible text included.
  const deployed = new DeployedLedger(path);
  try {
    assert.equal(
      deployed.record([
        deployedRecord({ ...fields, id: 'deployed', ts: ts + 1, outputTokens: 408, durationMs: 4524, ttftMs: 4517 }),
        deployedRecord({ ...fields, id: 'deployed-failed', ts: ts + 2, inputTokens: 1, status: 'failed', ttftMs: 3 }),
      ]),
      2
    );
  } finally {
    deployed.close();
  }

  const reopened = new UsageLedger(path);
  try {
    const rows = everything(reopened.db).requests;
    const byTokens = Object.fromEntries(rows.map((row) => [row.output || row.status, row]));
    assert.equal(rows.length, 3);
    assert.equal(byTokens[500].ttftMs, 1000, 'this build’s row');
    assert.equal(byTokens[408].ttftMs, null, 'the deployed build’s first-output time is never trusted');
    assert.equal(byTokens.failed.status, 'failed', 'its request facts still read');
  } finally {
    reopened.close();
  }
});
