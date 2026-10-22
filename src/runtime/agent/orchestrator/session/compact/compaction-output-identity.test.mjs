// Compaction output identity over real-shaped transcripts.
//
// The EXPECTED fingerprints were captured from the implementation before the
// compaction performance work (header hashed once per fit, cached prompt
// lines, sliced estimate priming, per-message encoding comparison), then
// recaptured when Compact began keeping opaque replay only on the newest
// assistant message and when the context ack began carrying its source. Any change to the compacted messages, archive bytes,
// token numbers, summary prompts or trace byte counts breaks them. The trace
// numbers are also checked against an independent JSON.stringify of the
// transcripts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The compacted output embeds the execution-archive path (the recovery
// reminder names it), so its token counts, tool-history fitting, record and
// byte lengths depend on the data-dir string — not just its length: each
// separator is a structural character to the estimator and two bytes in
// JSON. An absolute temp path tied the pinned numbers to this machine's temp
// location. The data dir is therefore a fixed RELATIVE path (resolved under a
// unique temp working directory), the same string wherever the temp dir
// lives. Its shape — segment lengths, separators, one structural character
// in place of the drive colon, letters only — reproduces the path EXPECTED
// was captured with (C:\Users\<5>\AppData\Local\Temp\mixdog-compact-
// identity-<6>), so the pinned values are unchanged. The platform separator
// still enters the output: EXPECTED holds the win32 values.
const workDir = mkdtempSync(join(tmpdir(), 'mci-'));
const previousCwd = process.cwd();
process.chdir(workDir);
const dataDir = join('C=', 'Users', 'owner', 'AppData', 'Local', 'Temp', 'mixdog-compact-identity-pinned');
const tracePath = join(dataDir, 'agent-trace.jsonl');
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_AGENT_TRACE_PATH = tracePath;
delete process.env.MIXDOG_AGENT_TRACE_DISABLE;

const { runSessionCompaction } = await import('../manager/compaction-runner.mjs');
const { withoutStampedIds } = await import('../message-ids.test-support.mjs');
const contextUtils = await import('../context-utils.mjs');
const { drainAgentTrace } = await import('../../agent-trace-io.mjs');
const { SUMMARY_PREFIX } = await import('./constants.mjs');
const { withRuntimeUserContext } = await import('../runtime-user-context.mjs');

test.after(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
});

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'compaction',
  'transcript',
  'archive',
  'budget',
  'token',
  'session',
  'daemon',
  'estimate',
  'message',
  'tool',
  'result',
  'header',
  'summary',
  'slice',
  'stall',
  'src/runtime/loop.mjs',
  '컴팩트',
  '세션',
  '토큰',
  '메시지',
  '요약',
  '도구',
  '결과',
  '예산',
  '😀',
  'naïve',
];

function words(rand, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  return out.join(' ');
}

function resultBody(rand, chars) {
  const lines = [];
  let size = 0;
  for (let line = 0; size < chars; line += 1) {
    const text =
      rand() < 0.2
        ? `${String(line).padStart(4)}\t${'QUJD'.repeat(12 + Math.floor(rand() * 20))}`
        : `${String(line).padStart(4)}\t${words(rand, 6 + Math.floor(rand() * 10))}`;
    lines.push(text);
    size += text.length + 1;
  }
  return lines.join(rand() < 0.3 ? '\r\n' : '\n');
}

function transcript({ seed, turns, bigResults, priorSummary }) {
  const rand = rng(seed);
  const messages = [
    { role: 'system', content: '# Rules\n- keep going\n# Active Workflow\n- default', cacheTier: 'stable' },
    { role: 'user', content: '<system-reminder>\n# Workspace\ncwd C:/Project/demo\n</system-reminder>' },
    { role: 'assistant', content: '.' },
  ];
  if (priorSummary) {
    messages.push({
      role: 'user',
      content: `${SUMMARY_PREFIX}\nmessages=12 sha256=0123456789abcdef roles=user:6, assistant:6\n\n## Goal\n- earlier ${words(rand, 30)}`,
      meta: { source: 'compact-summary' },
    });
  }
  let call = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({
      role: 'user',
      content: `${words(rand, 20 + Math.floor(rand() * 60))}${turn % 5 === 0 ? '\r\nsecond line\r\n' : ''}`,
      meta: { source: 'user', submissionIds: [`sub-${seed}-${turn}`] },
    });
    const steps = 1 + Math.floor(rand() * 3);
    for (let step = 0; step < steps; step += 1) {
      const id = `toolu_${seed}_${call}`;
      call += 1;
      const args =
        rand() < 0.2
          ? { command: `curl -H "authorization: Bearer secret${call}" https://example.test`, token: 'abc' }
          : { path: `src/file-${call}.mjs`, pattern: words(rand, 3) };
      const name = ['read', 'grep', 'shell'][Math.floor(rand() * 3)];
      messages.push({
        role: 'assistant',
        content: rand() < 0.5 ? words(rand, 15) : '',
        createdAt: 1_700_000_000_000 + call,
        meta: { transcript: { agent: 'main', at: 1_700_000_000_000 + call, model: 'identity-model' } },
        toolCalls: [{ id, name, arguments: rand() < 0.3 ? JSON.stringify(args) : args }],
        providerReplay: {
          provider: 'anthropic-oauth',
          accountId: 'acct',
          version: 1,
          items: [
            { type: 'thinking', thinking: words(rand, 25), signature: `sig${'A'.repeat(40)}` },
            { type: 'text', text: words(rand, 8) },
            { type: 'tool_use', id, name, input: { name } },
          ],
        },
      });
      const body = resultBody(rand, bigResults && rand() < 0.3 ? 20_000 : 200 + Math.floor(rand() * 3_000));
      const result = {
        role: 'tool',
        toolCallId: id,
        toolKind: 'normal',
        content: rand() < 0.1 ? { content: [{ type: 'text', text: body }] } : body,
        toolTiming: { dispatchStartedAt: 1, executionStartedAt: 2, executionCompletedAt: 3 },
      };
      if (rand() < 0.25) result.uiDiff = '--- a\n+++ b\n@@\n-x\n+y';
      messages.push(result);
    }
    messages.push({ role: 'assistant', content: words(rand, 30 + Math.floor(rand() * 80)) });
  }
  const last = messages.findLastIndex((message) => message.role === 'user');
  messages[last] = withRuntimeUserContext(messages[last], {
    suffix: '\n\n<system-reminder>\n# Current Time\nLocal: 2026-09-23 16:21:44\n</system-reminder>',
  });
  return messages;
}

function summaryFor(call) {
  return [
    '## Goal',
    `- continue identity work (call ${call})`,
    '',
    '## Constraints & Preferences',
    ...Array.from({ length: 6 }, (_, i) => `- constraint ${i} ${'x'.repeat(i)}`),
    '',
    '## Progress',
    '### Done',
    ...Array.from({ length: 20 }, (_, i) => `- done ${i} src/file-${i}.mjs`),
    '',
    '### In Progress',
    '- (none)',
    '',
    '### Blocked',
    '- (none)',
    '',
    '## Key Decisions',
    ...Array.from({ length: 8 }, (_, i) => `- decision ${i}`),
    '',
    '## Next Steps',
    '- verify',
    '',
    '## Critical Context',
    ...Array.from({ length: 10 }, (_, i) => `- fact ${i} 세션 ${i}`),
    '',
    '## Relevant Files',
    ...Array.from({ length: 12 }, (_, i) => `- src/file-${i}.mjs: why`),
  ].join('\n');
}

const sha = (value) => createHash('sha256').update(value).digest('hex');
const normalize = (text) =>
  text.split(JSON.stringify(dataDir).slice(1, -1)).join('<DATA>').split(dataDir).join('<DATA>');

// Every archive file (dumps and the large messages they store once), pinned
// by count, total size and a digest of the sorted name/size/sha listing.
function archiveFiles(sessionId) {
  const dir = join(dataDir, 'tool-results', sessionId);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .map((file) => {
          const bytes = readFileSync(join(dir, file));
          return { file, bytes: bytes.length, sha256: sha(bytes) };
        })
    : [];
  return {
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    listingSha: sha(JSON.stringify(files)),
  };
}

async function lastCompactTrace() {
  await drainAgentTrace();
  const rows = readFileSync(tracePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return rows.filter((row) => 'before_bytes' in row).at(-1);
}

async function compactFingerprint(session) {
  const prompts = [];
  const provider = {
    name: 'anthropic-oauth',
    async send(input) {
      prompts.push(normalize(input[1].content));
      return { content: summaryFor(prompts.length), usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  // A compaction stamps stable display ids on its input first
  // (message-ids.mjs). They are bookkeeping, not output: the pinned values
  // describe the transcript without them, and the trace numbers are checked
  // against the real (stamped) bytes.
  const plainBefore = JSON.stringify(withoutStampedIds(session.messages));
  // The compaction stamps these very message objects.
  const input = session.messages.slice();
  const result = await runSessionCompaction(session, {
    mode: 'manual',
    force: true,
    config: {},
    provider,
    model: session.model,
  });
  const afterJson = JSON.stringify(session.messages);
  const plainAfter = JSON.stringify(withoutStampedIds(session.messages));
  const trace = await lastCompactTrace();
  const stampedBefore = JSON.stringify(input);
  assert.equal(JSON.stringify(withoutStampedIds(input)), plainBefore);
  assert.equal(trace.before_bytes, Buffer.byteLength(stampedBefore, 'utf8'));
  assert.equal(trace.after_bytes, Buffer.byteLength(afterJson, 'utf8'));
  assert.equal(trace.compact_changed, stampedBefore !== afterJson);
  const idBytes = (stamped, plain) => Buffer.byteLength(stamped, 'utf8') - Buffer.byteLength(plain, 'utf8');
  const beforeIdBytes = idBytes(stampedBefore, plainBefore);
  const afterIdBytes = idBytes(afterJson, plainAfter);
  const numbers = Object.fromEntries(
    Object.entries(result).filter(
      // The dropped count/identities describe the display-only archive, not
      // compaction output.
      ([key, value]) =>
        key !== 'droppedMessages' && key !== 'droppedIdentities' && (value === null || typeof value !== 'object')
    )
  );
  // `archive` is the display-only compaction archive's bookkeeping, not
  // compaction output; the last* timing fields are wall-clock measurements.
  const {
    lastCheckedAt: _c,
    lastChangedAt: _g,
    lastCompactAt: _a,
    archive: _d,
    lastStartedAt: _s,
    lastCommittedAt: _m,
    lastDurationMs: _u,
    lastPipelineMs: _p,
    lastSummaryMs: _y,
    lastCommitMs: _o,
    lastCompactMode: _k,
    ...record
  } = session.compaction;
  return {
    numbers,
    messages: session.messages.length,
    messagesSha: sha(normalize(plainAfter)),
    recordSha: sha(normalize(JSON.stringify(record))),
    sends: prompts.length,
    promptsSha: sha(JSON.stringify(prompts)),
    archives: archiveFiles(session.id),
    traceBytes: [trace.before_bytes - beforeIdBytes, trace.after_bytes - afterIdBytes],
  };
}

function sessionFor(name, messages, { contextWindow, conversationThresholdTokens }) {
  return {
    id: `identity-${name}`,
    provider: 'anthropic-oauth',
    model: 'identity-model',
    owner: 'agent',
    contextWindow,
    compactBoundaryTokens: contextWindow,
    messages,
    tools: [{ name: 'read', description: 'Read files', inputSchema: { type: 'object' } }],
    compaction: { conversationThresholdTokens },
  };
}

const numbersFor = (handoffSource, window, target, values) => ({
  changed: true,
  reason: null,
  ...values,
  triggerTokens: window,
  bufferTokens: 0,
  bufferRatio: 0,
  boundaryTokens: window,
  budgetTokens: window,
  targetBudgetTokens: target,
  reserveTokens: 38,
  freshContext: true,
  freshContextError: null,
  handoffSource,
  ...(handoffSource === 'rules' ? { usage: null } : {}),
});
const archives = (files, bytes, listingSha) => ({ files, bytes, listingSha });

const EXPECTED = {
  rules: {
    numbers: numbersFor('rules', 200_000, 35_714, {
      beforeMessages: 357,
      afterMessages: 181,
      beforeTokens: 480_145,
      afterTokens: 43_072,
      beforeMessageTokens: 342_923,
      afterMessageTokens: 30_728,
      pressureTokens: 480_145,
    }),
    messages: 181,
    messagesSha: '60f0e65a427fdb2ea2f8ee646f11c61cc1c943fbf4443e6966583ba585737f49',
    recordSha: '9af03accb136319983b290a461281ce54bb69d92e8013876b3b5e416d4422904',
    sends: 0,
    promptsSha: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    archives: archives(37, 1_210_506, '64055b96698722b5663e1ff09a204d4b8b3d77854916106ea37048420cf95c09'),
    traceBytes: [1_203_122, 107_999],
  },
  repeat: {
    numbers: numbersFor('rules', 200_000, 35_714, {
      beforeMessages: 225,
      afterMessages: 216,
      beforeTokens: 80_494,
      afterTokens: 46_003,
      beforeMessageTokens: 57_458,
      afterMessageTokens: 32_821,
      pressureTokens: 80_494,
    }),
    messages: 216,
    messagesSha: '605e488d01506974cc178263255c300d49f27b7a614fc161aeef6f719251982c',
    recordSha: '459d7b38ae81793bf6ef10f2dd75fea2149c55e2f0d633029b33cc47ce02aa4a',
    sends: 0,
    promptsSha: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    archives: archives(40, 1_390_293, '4f3011bc5e97f153b9bfc99bc04285d88a9e796ebde825a75a336b35fd7c29ff'),
    traceBytes: [204_052, 117_069],
  },
  summary: {
    numbers: numbersFor('session-local', 60_000, 10_714, {
      beforeMessages: 572,
      afterMessages: 18,
      beforeTokens: 266_587,
      afterTokens: 4_600,
      beforeMessageTokens: 190_381,
      afterMessageTokens: 3_248,
      pressureTokens: 266_587,
    }),
    messages: 18,
    messagesSha: '7a3fd462b4dbd1e400b82903313f1576255c3878a012a0f455798f73ca458849',
    recordSha: '5ab36533b09e563dc54dadc23243f1944f55625e138b37dcfbd4966732dd07b5',
    sends: 2,
    // The summary input carries one bounded line per tool call.
    promptsSha: '8c859542e9cf4d900807bb0f1809f03a47ede3795bb4e0ae950ea4b90b2921ae',
    archives: archives(1, 712_408, '464b1d3a86d92f8da4a5ed4f643649b6affc8d52b86702c48bf9950288c28a02'),
    traceBytes: [714_283, 12_694],
  },
  large: {
    numbers: numbersFor('session-local', 400_000, 71_428, {
      beforeMessages: 945,
      afterMessages: 36,
      beforeTokens: 1_351_475,
      afterTokens: 28_785,
      beforeMessageTokens: 965_301,
      afterMessageTokens: 20_523,
      pressureTokens: 1_351_475,
    }),
    messages: 36,
    messagesSha: '20fbb536eb69b0eb7a4170e191c42fbec9657a6dba1e6904fac49fcad461c0ea',
    recordSha: '8ff0ce2f0652109ae6f9a443c3ff9e9738c0f54d24270fdd65c7633cc15f3181',
    sends: 1,
    promptsSha: '5f8570a037261e645d4d55d65efd99cefac1a98f0e068d1040dfe42fa41e7fb1',
    archives: archives(102, 3_402_411, '60bebec70ec783c2861c64afbd14a3f4dc03af2b38497aab7e7c221074c7e809'),
    traceBytes: [3_380_664, 72_692],
  },
};

// The pinned values were captured on win32: the data-dir separator is part of
// the compacted text (`\` is structural for the estimator and 2 JSON bytes).
// Other platforms need their own capture (MIXDOG_PRINT_COMPACT_IDENTITY=1).
test('compaction output is identical to the pre-optimization implementation', {
  skip: process.platform !== 'win32' && 'pinned values were captured on win32 only',
}, async () => {
  const actual = {};
  const rules = sessionFor('rules', transcript({ seed: 11, turns: 60, bigResults: true }), {
    contextWindow: 200_000,
    conversationThresholdTokens: 100_000_000,
  });
  actual.rules = await compactFingerprint(rules);
  // Repeat compaction over the compacted transcript plus new turns: shared
  // message objects on both sides of the encoding comparison, prior recovery.
  rules.messages = [...rules.messages, ...transcript({ seed: 12, turns: 8, bigResults: true }).slice(3)];
  actual.repeat = await compactFingerprint(rules);
  actual.summary = await compactFingerprint(
    sessionFor('summary', transcript({ seed: 21, turns: 90, bigResults: false, priorSummary: true }), {
      contextWindow: 60_000,
      conversationThresholdTokens: 1,
    })
  );
  actual.large = await compactFingerprint(
    sessionFor('large', transcript({ seed: 31, turns: 160, bigResults: true }), {
      contextWindow: 400_000,
      conversationThresholdTokens: 1,
    })
  );
  if (process.env.MIXDOG_PRINT_COMPACT_IDENTITY === '1') console.log(JSON.stringify(actual, null, 2));
  assert.deepEqual(actual, EXPECTED);
});

test('primed estimates equal cold estimates', async () => {
  const cold = transcript({ seed: 41, turns: 40, bigResults: true });
  const primed = structuredClone(cold);
  await contextUtils.primeMessageEstimates(primed);
  assert.equal(contextUtils.estimateMessagesTokens(primed), contextUtils.estimateMessagesTokens(structuredClone(cold)));
  assert.deepEqual(
    contextUtils.summarizeContextMessages(primed),
    contextUtils.summarizeContextMessages(structuredClone(cold))
  );
});
