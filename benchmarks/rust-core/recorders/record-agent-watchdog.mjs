#!/usr/bin/env node
// Golden twin of the agent progress watchdog's inputs, run on real Node:
//   * `readAgentFirstResponseTimeoutMs` (session-runtime/services/agent-tool/helpers.mjs) over
//     temp data dirs: user copy versus shipped, 0, negative, non-numeric, absent, a flat <id>.md,
//     a deleted agent and a store bot;
//   * the internal agents' `stallCap.idleSeconds` (`getHiddenAgent(name)`);
//   * `resolveAgentWatchdogPolicy(agent, overrides)` (agent-progress-watchdog.mjs) under several
//     environments (its thresholds are read from `process.env` when the module loads, so each
//     environment is recorded by a child process).
// The worlds, environments and override sets are inputs; every answer is Node's.
//
//   node benchmarks/rust-core/recorders/record-agent-watchdog.mjs [--tree <dir>]
//
// Output: native/core/fixtures/agent-watchdog/golden.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const AGENTS = ['worker', 'reviewer', 'heavy-worker', 'maintainer', 'explore-agent', 'cycle1-agent', 'title-agent', 'custom-agent', 'advisor'];
const ENVS = [
  {},
  { STALL_TIMEOUT_S: '1200' },
  { STALL_TIMEOUT_S: '100' },
  { STALL_TIMEOUT_S: 'abc' },
  { MIXDOG_AGENT_STALE_TIMEOUT_MS: '900000' },
  { MIXDOG_AGENT_STALE_TIMEOUT_MS: '0' },
  { MIXDOG_AGENT_STALE_TIMEOUT_MS: '-5' },
  { MIXDOG_AGENT_FIRST_RESPONSE_TIMEOUT_MS: '200000', MIXDOG_AGENT_FIRST_VISIBLE_TIMEOUT_MS: '300000' },
  { MIXDOG_PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS: '60000' },
  { MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS: '90000' },
];
const OVERRIDES = [
  {},
  { idleTimeoutMs: 0 },
  { idleTimeoutMs: 45000 },
  { firstResponseTimeoutMs: 5000, providerFirstByteTimeoutMs: 400000 },
  { firstResponseTimeoutMs: 0, providerFirstByteTimeoutMs: 400000 },
  { firstSemanticTimeoutMs: 100, providerFirstOutputTimeoutMs: 466000 },
  { providerFirstOutputTimeoutMs: 1000 },
];

const args = parseArgs();
const tree = resolveTree(args);

if (args.has('policy-child')) {
  // Child mode: the environment is already set; answer every (agent, overrides) case.
  const { getHiddenAgent } = await importFrom(tree, 'src/runtime/agent/orchestrator/internal-agents.mjs');
  const { resolveAgentWatchdogPolicy } = await importFrom(tree, 'src/runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs');
  const rows = [];
  for (const agent of AGENTS) {
    for (const overrides of OVERRIDES) {
      const policy = resolveAgentWatchdogPolicy(agent, overrides);
      rows.push({
        agent,
        hidden: getHiddenAgent(agent) !== null,
        stallCapIdleSeconds: getHiddenAgent(agent)?.stallCap?.idleSeconds ?? null,
        overrides,
        policy: { firstTransportMs: policy.firstTransportMs, firstSemanticMs: policy.firstSemanticMs, idleStaleMs: policy.idleStaleMs },
      });
    }
  }
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}

const finalDir = join(FIXTURES_ROOT, 'agent-watchdog');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-agent-watchdog.mjs';
const sandbox = mkdtempSync(join(tmpdir(), 'agent-watchdog-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
const { readAgentFirstResponseTimeoutMs } = await importFrom(tree, 'src/session-runtime/services/agent-tool/helpers.mjs');
const { getHiddenAgent } = await importFrom(tree, 'src/runtime/agent/orchestrator/internal-agents.mjs');
const { evaluateAgentWatchdogAbort, isAgentProgressWatchdogAbortError, watchdogStoppedHandoff } = await importFrom(tree, 'src/runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs');

const fm = (line) => `---\n${line}\n---\nbody`;
const WORLDS = [
  {
    name: 'user-versus-shipped',
    shipped: {
      'agents/slow/AGENT.md': fm('firstResponseTimeoutMs: 900000'),
      'agents/both/AGENT.md': fm('firstResponseTimeoutMs: 111000'),
      'agents/flat-shipped.md': fm('firstResponseTimeoutMs: 222000'),
    },
    data: {
      'agents/slow/AGENT.md': fm('kind: bot'),
      'agents/both/AGENT.md': fm('firstResponseTimeoutMs: 5000'),
      'agents/flat-user.md': fm('firstResponseTimeoutMs: 333000'),
      'agents/mixed/AGENT.md': fm('firstResponseTimeoutMs: nope'),
    },
    shippedExtra: { 'agents/mixed/AGENT.md': fm('firstResponseTimeoutMs: 444000') },
    queries: ['slow', 'both', 'flat-shipped', 'flat-user', 'mixed', 'missing', ''],
  },
  {
    name: 'values',
    shipped: {
      'agents/zero/AGENT.md': fm('firstResponseTimeoutMs: 0'),
      'agents/negative/AGENT.md': fm('firstResponseTimeoutMs: -5'),
      'agents/fraction/AGENT.md': fm('firstResponseTimeoutMs: 1500.9'),
      'agents/quoted/AGENT.md': fm('firstResponseTimeoutMs: "2500"'),
      'agents/words/AGENT.md': fm('firstResponseTimeoutMs: soon'),
      'agents/empty/AGENT.md': fm('firstResponseTimeoutMs:'),
      'agents/absent/AGENT.md': fm('kind: bot'),
      'agents/padded/AGENT.md': fm('firstResponseTimeoutMs:   7000  '),
      'agents/crlf/AGENT.md': '---\r\nfirstResponseTimeoutMs: 8000\r\n---\r\nbody',
    },
    data: {},
    queries: ['zero', 'negative', 'fraction', 'quoted', 'words', 'empty', 'absent', 'padded', 'crlf'],
  },
  {
    name: 'deleted',
    shipped: { 'agents/gone/AGENT.md': fm('firstResponseTimeoutMs: 1000'), 'agents/kept/AGENT.md': fm('firstResponseTimeoutMs: 2000') },
    data: { 'agents/gone/.deleted': 'deleted', 'agents/kept/AGENT.md': fm('kind: bot') },
    queries: ['gone', 'kept'],
  },
  {
    name: 'store-bot',
    shipped: { 'agents/bot-one/AGENT.md': fm('firstResponseTimeoutMs: 1000') },
    data: {
      'bots/migration.json': JSON.stringify({ version: 1, bots: ['bot-one'] }),
      'bots/bot-one/AGENT.md': fm('firstResponseTimeoutMs: 6000'),
      'bots/bot-two/AGENT.md': fm('firstResponseTimeoutMs: 7000'),
    },
    queries: ['bot-one', 'bot-two'],
  },
];

function put(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(base, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const firstResponse = WORLDS.map((world) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-fr-'));
  const shipped = join(root, 'shipped');
  const data = join(root, 'data');
  mkdirSync(shipped, { recursive: true });
  mkdirSync(data, { recursive: true });
  const shippedFiles = { ...world.shipped, ...(world.shippedExtra ?? {}) };
  put(shipped, shippedFiles);
  put(data, world.data);
  try {
    return {
      name: world.name,
      shipped: shippedFiles,
      data: world.data,
      answers: Object.fromEntries(world.queries.map((id) => [id, readAgentFirstResponseTimeoutMs(id, data, shipped) ?? null])),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const hiddenNames = JSON.parse(readFileSync(join(tree, 'src/defaults/agents.json'), 'utf8')).agents.map((a) => a.agent);
const stallCaps = Object.fromEntries([...hiddenNames, 'worker', 'nope'].map((name) => [name, getHiddenAgent(name)?.stallCap?.idleSeconds ?? null]));

const script = fileURLToPath(import.meta.url);
const policies = ENVS.map((env) => {
  const out = execFileSync(process.execPath, [script, '--tree', tree, '--policy-child'], {
    env: { ...process.env, ...env, MIXDOG_DATA_DIR: sandbox, MIXDOG_HOME: sandbox },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { env, cases: JSON.parse(out) };
});

const MESSAGES = [
  'agent task stale (600000ms without stream/tool progress)',
  'agent first transport stale (120000ms)',
  'agent first semantic response stale (600000ms)',
  'agent first response stale (1ms)',
  'agent task stale(5ms)',
  'agent task stale',
  'agent progress checks failed: x',
  'This operation was aborted',
  '',
];
const abortTexts = MESSAGES.map((message) => ({ message, stall: isAgentProgressWatchdogAbortError({ message }) }));

const HANDOFFS = [
  { message: 'agent task stale (1ms without stream/tool progress)', partial: 'half', shellJobs: undefined },
  { message: 'm', partial: 'p', shellJobs: { stopped: ['a', 'b'], stopping: [] } },
  { message: 'm', partial: 'p', shellJobs: { stopped: [], stopping: ['c'] } },
  { message: 'm', partial: 'p', shellJobs: { stopped: ['a'], stopping: ['c', 'd'] } },
];
const handoffs = HANDOFFS.map((h) => ({ ...h, text: watchdogStoppedHandoff({ message: h.message }, h.partial, h.shellJobs) }));

// The sweep scenarios: a streaming run last heard from at t0, judged at several times.
const T0 = 1_000_000;
const evalPolicy = { firstTransportMs: 0, firstSemanticMs: 0, idleStaleMs: 60000 };
const streaming = { stage: 'streaming', lastProgressAt: T0, waitingForTransport: false, waitingForFirstSemantic: false };
const evaluations = [
  { snapshot: streaming, now: T0 + 60000, policy: evalPolicy },
  { snapshot: streaming, now: T0 + 61000, policy: evalPolicy },
  { snapshot: { ...streaming, awaitingUser: true }, now: T0 + 700000, policy: evalPolicy },
  { snapshot: { ...streaming, lastProgressAt: T0 + 50000 }, now: T0 + 110000, policy: evalPolicy },
  { snapshot: { ...streaming, lastProgressAt: T0 + 50000 }, now: T0 + 111000, policy: evalPolicy },
].map((c) => ({ ...c, message: evaluateAgentWatchdogAbort(c.snapshot, c.now, c.policy)?.message ?? null }));

writeJson(join(stage, 'golden.json'), { firstResponse, stallCaps, policies, abortTexts, handoffs, evaluations });
writeSetManifest(stage, { set: 'agent-watchdog', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
rmSync(sandbox, { recursive: true, force: true });
console.log(`recorded ${firstResponse.length} first-response worlds, ${Object.keys(stallCaps).length} stall caps, ${policies.length} environments`);
process.exit(0);