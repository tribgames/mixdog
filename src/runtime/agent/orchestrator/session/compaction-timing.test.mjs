import '../../../shared/llm/usage-test-support.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UsageLedger, closeUsageLedgers } from '../../../shared/llm/usage-ledger.mjs';
import { wrapProviderAdmission } from '../providers/admission-scheduler.mjs';
import { runSessionCompaction } from './manager/compaction-runner.mjs';
import { captureSideQuestionRequest, forgetSideQuestion } from './side-question-store.mjs';
import { runPreSendCompactPass } from './pre-send-compact.mjs';

const summary = [
  '## Goal',
  '- continue the task',
  '## Constraints & Preferences',
  '- keep source records',
  '## Progress',
  '### Done',
  '- old work completed',
  '### In Progress',
  '- current task',
  '### Blocked',
  '- (none)',
  '## Key Decisions',
  '- preserve the original record',
  '## Next Steps',
  '- continue',
  '## Critical Context',
  '- retained fact',
  '## Relevant Files',
  '- working.mjs',
].join('\n');

function fixture() {
  const session = {
    id: 'timing-fixture',
    provider: 'openai',
    model: 'main-model',
    compaction: { conversationThresholdTokens: 1 },
    contextWindow: 100_000,
    tools: [],
    messages: [
      { role: 'system', content: 'immutable system rules' },
      { role: 'user', content: 'older request' },
      ...Array.from({ length: 40 }, (_, i) => ({
        role: 'assistant',
        content: `TIMING_SOURCE_${i}`.padEnd(1600, '.'),
      })),
      { role: 'user', content: 'latest request' },
    ],
  };
  const provider = wrapProviderAdmission(
    {
      name: 'openai',
      async send() {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          content: summary,
          model: 'summary-model',
          usage: { inputTokens: 1000, outputTokens: 50, cachedTokens: 0 },
        };
      },
    },
    'openai'
  );
  return { session, provider };
}

function useLedger(t) {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-compaction-usage-')), 'ledger.sqlite');
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    closeUsageLedgers();
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
  });
  return () => {
    const ledger = new UsageLedger(path);
    try {
      return ledger.db.prepare('SELECT * FROM events').all();
    } finally {
      ledger.close();
    }
  };
}

test('a compaction persists its timing, logs one line and records the summary call in the usage ledger', async (t) => {
  const readRows = useLedger(t);
  const lines = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true;
  };
  const { session, provider } = fixture();
  const before = Date.now();
  let result;
  try {
    result = await runSessionCompaction(session, { config: {}, provider, mode: 'manual', archive: false });
  } finally {
    process.stderr.write = originalWrite;
  }
  const after = Date.now();
  assert.equal(result.changed, true);

  const c = session.compaction;
  assert.ok(c.lastStartedAt >= before && c.lastStartedAt <= c.lastCommittedAt && c.lastCommittedAt <= after);
  assert.equal(c.lastDurationMs, c.lastCommittedAt - c.lastStartedAt);
  assert.ok(c.lastSummaryMs >= 10, `summary ms ${c.lastSummaryMs}`);
  assert.ok(c.lastDurationMs >= c.lastSummaryMs);
  assert.ok(c.lastCommitMs >= 0 && c.lastCommitMs <= c.lastDurationMs);
  // No cached request to fork: the isolated summary on the conversation's model.
  assert.equal(c.lastCompactMode, 'conversation-summary:isolated:session');
  assert.equal(c.lastHandoffSource, 'session-local');

  const logged = lines.filter((line) => line.startsWith('compaction session='));
  assert.equal(logged.length, 1);
  assert.match(
    logged[0],
    new RegExp(
      `^compaction session=timing-fixture source=session-local model=main-model mode=isolated:session total=${c.lastDurationMs}ms ` +
        `summary=${c.lastSummaryMs}ms commit=${c.lastCommitMs}ms in=\\d+ out=\\d+\\n$`
    )
  );

  const rows = readRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 'timing-fixture');
  assert.equal(rows[0].source_type, 'compaction');
});

test('a warm-cache fork is recorded as compaction usage; a background session keeps its own source', async (t) => {
  const readRows = useLedger(t);
  for (const sourceType of [undefined, 'background']) {
    const { session, provider } = fixture();
    session.id = `timing-fork-${sourceType || 'foreground'}`;
    session.sourceType = sourceType;
    t.after(() => forgetSideQuestion(session.id));
    // The session's last request, just settled: the cache is warm.
    captureSideQuestionRequest({
      sessionId: session.id,
      sessionRef: session,
      provider,
      model: 'main-model',
      messages: session.messages.slice(),
      tools: [],
      opts: { sessionId: session.id, session: { id: session.id, sourceType } },
    }).settle({ content: 'ok' });
    const result = await runSessionCompaction(session, { config: {}, provider, mode: 'manual', archive: false });
    assert.equal(result.changed, true);
    assert.equal(session.compaction.lastCompactMode, 'conversation-summary:fork:session');
  }
  assert.deepEqual(
    readRows().map((row) => [row.session_id, row.source_type]),
    [
      ['timing-fork-foreground', 'compaction'],
      ['timing-fork-background', 'background'],
    ]
  );
});

test("the next turn's pre-send check keeps the last compaction's timing", async (t) => {
  useLedger(t);
  const { session, provider } = fixture();
  session.id = 'timing-next-turn';
  const result = await runSessionCompaction(session, { config: {}, provider, mode: 'manual', archive: false });
  assert.equal(result.changed, true);
  const timingKeys = [
    'lastStartedAt',
    'lastCommittedAt',
    'lastDurationMs',
    'lastPipelineMs',
    'lastSummaryMs',
    'lastCommitMs',
    'lastCompactMode',
  ];
  const timing = Object.fromEntries(timingKeys.map((key) => [key, session.compaction[key]]));
  assert.equal(typeof timing.lastDurationMs, 'number');

  // The next normal turn: a small transcript, no compaction due.
  session.messages.push({ role: 'user', content: 'next request' });
  const pass = await runPreSendCompactPass({
    compactionConfig: {},
    provider,
    messages: session.messages,
    model: session.model,
    requestTools: [],
    sessionRef: session,
    sessionId: session.id,
    opts: {},
    signal: null,
    iterations: 1,
    lastUsage: null,
    firstTurnUsage: null,
    providerState: null,
    reactiveOverflowRetryPending: false,
    loopUsageMetricsTurnId: () => 'next-turn',
    loopUsageMetricsEpoch: () => 0,
  });
  assert.equal(pass.compactChanged, false);
  assert.equal(session.compaction.lastStage, 'pre_send_check');
  assert.deepEqual(Object.fromEntries(timingKeys.map((key) => [key, session.compaction[key]])), timing);
});

test('a rules-only compaction records no summary time and no summary model', async (t) => {
  useLedger(t);
  const { session, provider } = fixture();
  session.compaction = {};
  session.messages = session.messages.slice(0, 2).concat(session.messages.slice(-1));
  const result = await runSessionCompaction(session, { config: {}, provider, mode: 'manual', archive: false });
  assert.ok(result);
  const c = session.compaction;
  assert.equal(c.lastSummaryMs, null);
  assert.equal(c.lastCompactMode, 'rules');
  assert.equal(c.lastHandoffSource, 'rules');
  assert.equal(typeof c.lastDurationMs, 'number');
});
