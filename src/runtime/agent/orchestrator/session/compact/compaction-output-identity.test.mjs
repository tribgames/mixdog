// Compaction output identity over real-shaped transcripts.
//
// The EXPECTED fingerprints were captured from the implementation before the
// compaction performance work (header hashed once per fit, cached prompt
// lines, sliced estimate priming, per-message encoding comparison). Any change
// to the compacted messages, archive bytes, token numbers, summary prompts or
// trace byte counts breaks them. The trace numbers are also checked against
// an independent JSON.stringify of the transcripts.
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
  'compaction', 'transcript', 'archive', 'budget', 'token', 'session', 'daemon', 'estimate',
  'message', 'tool', 'result', 'header', 'summary', 'slice', 'stall', 'src/runtime/loop.mjs',
  '컴팩트', '세션', '토큰', '메시지', '요약', '도구', '결과', '예산', '😀', 'naïve',
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

function archiveFiles(sessionId) {
  const dir = join(dataDir, 'tool-results', sessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((file) => {
      const bytes = readFileSync(join(dir, file));
      return { file, bytes: bytes.length, sha256: sha(bytes) };
    });
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
  const beforeJson = JSON.stringify(session.messages);
  const result = await runSessionCompaction(session, {
    mode: 'manual',
    force: true,
    config: {},
    provider,
    model: session.model,
  });
  const afterJson = JSON.stringify(session.messages);
  const trace = await lastCompactTrace();
  assert.equal(trace.before_bytes, Buffer.byteLength(beforeJson, 'utf8'));
  assert.equal(trace.after_bytes, Buffer.byteLength(afterJson, 'utf8'));
  assert.equal(trace.compact_changed, beforeJson !== afterJson);
  const numbers = Object.fromEntries(
    Object.entries(result).filter(([, value]) => value === null || typeof value !== 'object')
  );
  const { lastCheckedAt: _c, lastChangedAt: _g, lastCompactAt: _a, ...record } = session.compaction;
  return {
    numbers,
    messages: session.messages.length,
    messagesSha: sha(normalize(afterJson)),
    recordSha: sha(normalize(JSON.stringify(record))),
    sends: prompts.length,
    promptsSha: sha(JSON.stringify(prompts)),
    archives: archiveFiles(session.id),
    traceBytes: [trace.before_bytes, trace.after_bytes],
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
const archive = (sha256, bytes) => ({ file: `${sha256}.txt`, bytes, sha256 });
const RULES_ARCHIVE = archive('58f93144f35b7b3c601e15c792d3b8ee2de67839fc96cd5b4786124f9a488c34', 1_277_537);

const EXPECTED = {
  rules: {
    numbers: numbersFor('rules', 200_000, 35_714, {
      beforeMessages: 357,
      afterMessages: 179,
      beforeTokens: 480_145,
      afterTokens: 43_179,
      beforeMessageTokens: 342_923,
      afterMessageTokens: 30_804,
      pressureTokens: 480_145,
    }),
    messages: 179,
    messagesSha: 'b3f808f028a275ecf90742a29b5b8870bd988353069ddbff2c55c1c5e57fc23b',
    recordSha: '72dc8946f16e18183692ad8d125ae6bc4af651094ee539c14f9b6d339f62ab8f',
    sends: 0,
    promptsSha: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    archives: [RULES_ARCHIVE],
    traceBytes: [1_203_122, 106_256],
  },
  repeat: {
    numbers: numbersFor('rules', 200_000, 35_714, {
      beforeMessages: 223,
      afterMessages: 212,
      beforeTokens: 80_601,
      afterTokens: 44_681,
      beforeMessageTokens: 57_534,
      afterMessageTokens: 31_877,
      pressureTokens: 80_601,
    }),
    messages: 212,
    messagesSha: '879e3bb3afde51c1213aa8e2c3c4fcd95d04e35b8e49af1309841bd9722a7e91',
    recordSha: 'ba86baf97e04340aa9ce5af282010daaefa5f61378a9d9534a4abf541d186d8a',
    sends: 0,
    promptsSha: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    archives: [RULES_ARCHIVE, archive('ad45d2fe4e26722cc043a70904c9995bdb37dcac2c486da4cead5e14ce4d3ef3', 219_631)],
    traceBytes: [202_309, 112_531],
  },
  summary: {
    numbers: numbersFor('session-local', 60_000, 10_714, {
      beforeMessages: 572,
      afterMessages: 18,
      beforeTokens: 266_587,
      afterTokens: 5_117,
      beforeMessageTokens: 190_381,
      afterMessageTokens: 3_617,
      pressureTokens: 266_587,
    }),
    messages: 18,
    messagesSha: '48c6dce17520387708d12c2501fbea4df1dce276f6d63c18ace42e5bf8a8ccd7',
    recordSha: '465a3542e1a4e7ca947752c00f3c52b88c39468ca496286543b78768e5ffdbc6',
    sends: 2,
    promptsSha: 'f47b552495036c5098cf3aaf74e3ccabda7a60424d8157e0783f225364d8e098',
    archives: [archive('bd4fed4e389f3f965b81f7d8b2bc43e178edc95943686e245c8592e161da93ae', 835_274)],
    traceBytes: [714_283, 14_172],
  },
  large: {
    numbers: numbersFor('session-local', 400_000, 71_428, {
      beforeMessages: 945,
      afterMessages: 24,
      beforeTokens: 1_351_475,
      afterTokens: 27_818,
      beforeMessageTokens: 965_301,
      afterMessageTokens: 19_832,
      pressureTokens: 1_351_475,
    }),
    messages: 24,
    messagesSha: '31824b1e5920830c2f24c97d35013ac4699a49686454cbc9b3be78ee2cbfbfda',
    recordSha: '27ec5ff17c4553473efc245b7c22f493842b6363aa7a5277f3a8f9ac56143aac',
    sends: 1,
    promptsSha: '48d26a7766c196e3365f6209046c1dc9a6b7b1b6451e76c2fb54f6d106ec9d59',
    archives: [archive('a2430042581139bf089a8b606009bc5ede869e4cec25d543f4053bb515c12312', 3_577_119)],
    traceBytes: [3_380_664, 70_185],
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
