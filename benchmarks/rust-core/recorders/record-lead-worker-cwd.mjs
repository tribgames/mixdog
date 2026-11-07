#!/usr/bin/env node
// Golden twin of `updateLeadWorkerCwd` (`services/agent-tool/lead-worker-index.mjs:110`): what
// Node's real Lead pool index answers and leaves in `lead-workers.json` when the Lead's
// workspace moves. Each scenario starts a fresh data folder holding the seeded index file,
// constructs the real index (`createLeadWorkerIndex`, so its boot recovery runs), makes the calls
// in order and, after each, waits for the index's writer and records the return value and the
// rows now on disk (the text of each row, so key order is kept).
//
// Node's writer rewrites the whole document through `normalizeLeadRows`, so every row of a file
// comes out normalized, touched or not. A scenario therefore either seeds normalized rows, or
// seeds one row and only ever calls for it.
//
//   node benchmarks/rust-core/recorders/record-lead-worker-cwd.mjs --tree <dir>
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const FIXED_NOW = 1_700_000_000_000;
Date.now = () => FIXED_NOW;

const sandbox = mkdtempSync(join(tmpdir(), 'lead-worker-cwd-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
const tree = resolveTree(parseArgs());
const { createLeadWorkerIndex } = await importFrom(tree, 'src/session-runtime/services/agent-tool/lead-worker-index.mjs');

const idle = (id, extra = {}) => ({
  tag: `lead:${id}`,
  sessionId: id,
  ownerSessionId: id,
  agent: 'lead',
  provider: 'anthropic',
  model: 'opus',
  status: 'idle',
  stage: 'idle',
  updatedAt: '2023-11-14T22:13:20.000Z',
  reapAt: null,
  finishedAt: '2023-11-14T22:13:20.000Z',
  runtimePid: 4242,
  ...extra,
});

const SCENARIOS = [
  {
    name: 'moves-a-settled-row',
    seed: [idle('lead-a', { cwd: '/old' }), idle('lead-nocwd'), idle('lead-same', { cwd: '/same' }), idle('lead-other', { cwd: '/other' })],
    calls: [
      ['lead-a', '/new'],
      ['lead-a', '  /trimmed  '],
      ['lead-a', '/trimmed'],
      ['lead-nocwd', '/added'],
      ['lead-same', '/same'],
      ['lead-same', ' /same '],
      ['lead-same', '/same/'],
      ['  lead-a  ', '/through-a-padded-id'],
      ['lead-a', 'C:\\Users\\a b\\proj'],
      ['lead-a', '/ünïcode/✓'],
    ],
  },
  {
    name: 'nothing-to-move',
    seed: [idle('lead-a', { cwd: '/old' })],
    calls: [
      ['unknown', '/x'],
      ['', '/x'],
      ['   ', '/x'],
      ['lead-a', ''],
      ['lead-a', '   '],
      ['lead:lead-a', '/by-tag'],
    ],
  },
  {
    name: 'a-running-row-keeps-its-status',
    seed: [idle('lead-run', { cwd: '/old', status: 'running', stage: 'streaming', runtimePid: 0, turnStartedAt: '2023-11-14T22:13:20.000Z', updatedAt: new Date(FIXED_NOW).toISOString() })],
    calls: [['lead-run', '/moved']],
  },
  {
    name: 'a-row-with-a-reap-deadline-keeps-it',
    seed: [idle('lead-reap', { cwd: '/old', reapAt: '2023-11-14T22:23:20.000Z' })],
    calls: [['lead-reap', '/moved']],
  },
  {
    name: 'a-stored-row-is-normalized-by-the-write',
    seed: [{ sessionId: ' lead-raw ', agent: 'Lead', cwd: 5, extra: { kept: true } }],
    calls: [[' lead-raw ', '/moved']],
  },
  {
    name: 'a-stored-row-without-a-cwd-and-with-blank-fields',
    seed: [{ sessionId: 'lead-blank', status: '  ', stage: '', updatedAt: ' ', reapAt: '', provider: 'openai' }],
    calls: [['lead-blank', '/moved']],
  },
  {
    name: 'a-row-already-normalized-is-left-alone-on-the-same-cwd',
    seed: [{ sessionId: 'lead-raw2', cwd: '/same' }],
    calls: [['lead-raw2', '/same']],
  },
];

const recorded = [];
for (const scenario of SCENARIOS) {
  const dataDir = join(sandbox, `data-${scenario.name}`);
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'lead-workers.json');
  const workers = {};
  for (const row of scenario.seed) workers[String(row.sessionId).trim()] = row;
  writeFileSync(file, JSON.stringify({ version: 1, updatedAt: new Date(FIXED_NOW).toISOString(), workers }));
  const index = createLeadWorkerIndex({
    dataDir,
    cfgMod: { loadConfig: () => ({}) },
    workerRowFromSession: () => null,
    isSessionRunning: () => true,
  });
  const steps = [];
  for (const [id, cwd] of scenario.calls) {
    const returns = index.updateLeadWorkerCwd(id, cwd);
    await index.flushLeadWorkerIndexWrites();
    const rows = JSON.parse(readFileSync(file, 'utf8')).workers;
    steps.push({ args: [id, cwd], returns, rows: Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, JSON.stringify(row)])) });
  }
  index.dispose();
  recorded.push({ name: scenario.name, seed: scenario.seed.map((row) => JSON.stringify(row)), steps });
}

writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/lead-worker-cwd-twin.json`,
  `${JSON.stringify({ domain: 'lead-worker-cwd-twin', now: FIXED_NOW, recorder: 'benchmarks/rust-core/recorders/record-lead-worker-cwd.mjs', scenarios: recorded }, null, 1)}\n`
);
console.log(`recorded ${recorded.length} scenarios, ${recorded.reduce((n, s) => n + s.steps.length, 0)} calls`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
