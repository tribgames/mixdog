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
import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';

after(() => closeUsageLedgers());

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
    assert.equal(requests[0].outputTokensPerSecond, null, 'no first-output time, no speed');
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
      opts.onStreamDelta('text');
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { content: 'x', model: 'gpt-5-mini-2026-01-01', usage: { inputTokens: 100, outputTokens: 400 } };
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
  assert.equal(
    Math.round(row.outputTokensPerSecond),
    Math.round(400 / ((row.durationMs - row.ttftMs) / 1000)),
    'speed runs from the first output, not the whole request'
  );
  assert.equal(read().length, 1);
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
  assert.equal(row.outputTokensPerSecond, null);
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
  assert.equal(row.outputTokensPerSecond, null);
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

test('statistics and quota views read the same tokens, cost and speed as before the request log', async (t) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const previous = join(here, `usage-accounting.previous-${process.pid}.mjs`);
  writeFileSync(
    previous,
    execFileSync('git', ['show', 'HEAD:src/runtime/shared/llm/usage-accounting.mjs'], { cwd: here, encoding: 'utf8' })
  );
  t.after(() => rmSync(previous, { force: true }));
  const { accountProviderSend: previousSend } = await import(pathToFileURL(previous).href);

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
  const read = async (send) => {
    useLedger(t);
    const ledger = getUsageLedger();
    for (const scenario of scenarios(send)) await scenario().catch(() => {});
    const now = Date.now();
    ledger.recordQuota([
      { provider, account: 'default', label: '5H', ts: now - 60_000, usedPct: 10, resetAt: now + 3_600_000 },
      { provider, account: 'default', label: '5H', ts: now, usedPct: 30, resetAt: now + 3_600_000 },
    ]);
    const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
    const { totals, providers } = await api.getUsageStats({ view: 'hour' });
    const quota = await api.getQuotaHistory({ provider, account: 'default', window: '5H' });
    // Speed divides by recorded wall time, which differs run to run: what
    // must hold is which records are timed.
    const timed = ledger.db.prepare('SELECT output,duration_ms FROM events WHERE duration_ms>0').all();
    const speed = (value) => Math.round(value);
    return {
      tokens: totals.tokens,
      costUsd: totals.costUsd,
      timed: timed.map((row) => row.output),
      speedFromTimed: [speed(providers[0].outputTokensPerSecond), speed(200 / (timed[0].duration_ms / 1000))],
      turns: totals.turns,
      quota: {
        summary: quota.summary,
        models: quota.models.map(({ outputTokensPerSecond, turns, ...row }) => row),
      },
    };
  };
  const before = await read(previousSend);
  const after = await read(accountProviderSend);
  assert.equal(after.tokens, before.tokens);
  assert.equal(after.tokens, 330 + 1200 + 440 + 550 + 660 + 770 + 880, 'every reported token once');
  assert.equal(after.costUsd, before.costUsd);
  assert.deepEqual(after.timed, [200], 'only the completed answer is timed, as before');
  assert.deepEqual(before.timed, [200]);
  assert.equal(after.speedFromTimed[0], after.speedFromTimed[1]);
  assert.equal(before.speedFromTimed[0], before.speedFromTimed[1]);
  // The only difference: the two failures that reported nothing are requests now.
  assert.equal(after.turns, before.turns + 2);
  assert.ok(after.quota.models.length, 'the quota window attributes the sends');
  assert.deepEqual(after.quota, before.quota);
});

test('a ledger this build touched is opened and written by the previous build', async (t) => {
  const here = dirname(fileURLToPath(import.meta.url));
  // The previous build's ledger module, beside this one so its imports resolve.
  const previous = join(here, `usage-ledger.previous-${process.pid}.mjs`);
  writeFileSync(
    previous,
    execFileSync('git', ['show', 'HEAD:src/runtime/shared/llm/usage-ledger.mjs'], { cwd: here, encoding: 'utf8' })
  );
  t.after(() => rmSync(previous, { force: true }));
  const { UsageLedger: PreviousLedger, makeUsageRecord: previousRecord } = await import(pathToFileURL(previous).href);

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
