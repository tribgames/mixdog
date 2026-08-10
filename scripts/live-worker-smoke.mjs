#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AGENT_TOOL, createStandaloneAgent } from '../src/standalone/agent-tool.mjs';
import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { initProviders } from '../src/runtime/agent/orchestrator/providers/registry.mjs';
import {
  closeSession,
  enqueuePendingMessage,
  getSession,
  getSessionLastProgressAt,
  getSessionRuntime,
  listSessions,
} from '../src/runtime/agent/orchestrator/session/manager.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-live-worker-'));
const dataDir = join(root, '.mixdog-data');
let activeAsks = 0;
let maxActiveAsks = 0;
let releaseBusyGate = null;
let busySafetyTimer = null;
let agentRunner = null;
let runnerClosed = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForBusyRelease() {
  return new Promise((resolve) => {
    const release = () => {
      if (busySafetyTimer) clearTimeout(busySafetyTimer);
      busySafetyTimer = null;
      if (releaseBusyGate === release) releaseBusyGate = null;
      resolve();
    };
    releaseBusyGate = release;
    busySafetyTimer = setTimeout(release, 10_000);
  });
}

function releaseBusyWorker() {
  const release = releaseBusyGate;
  releaseBusyGate = null;
  if (busySafetyTimer) clearTimeout(busySafetyTimer);
  busySafetyTimer = null;
  release?.();
}

function closeAgentRunner() {
  if (!agentRunner || runnerClosed) return;
  runnerClosed = true;
  agentRunner.closeAll('live-worker-smoke-end');
}

function taskId(text) {
  return String(text).match(/agent task: (\S+)/)?.[1] || null;
}

async function main() {
  const sharedToolRules = readFileSync('src/rules/shared/01-tool.md', 'utf8');
  const leadToolRules = readFileSync('src/rules/lead/lead-tool.md', 'utf8');
  const workflowRules = readFileSync('src/workflows/default/WORKFLOW.md', 'utf8');
  const soloRules = readFileSync('src/workflows/solo/WORKFLOW.md', 'utf8');
  const compact = (text) => text.toLowerCase().replace(/\s+/g, ' ');
  const hasAll = (text, ...terms) => terms.every((term) => text.includes(term));
  const shared = compact(sharedToolRules);
  const lead = compact(leadToolRules);
  const workflow = compact(workflowRules);
  const solo = compact(soloRules);
  const reviewSkipViolation = (text) => compact(text)
    .split(/[.!?]\s+|;|,\s+(?=(?:but|however|yet)\b)/)
    .some((clause) => {
      const hasReview = /\b(review|reviewer|verification)\b/.test(clause);
      const hasSkip = /\b(skip|skipping|skipped|skippable|omit|omits|omitting|omitted)\b/.test(clause) ||
        /\bwithout\s+(?:any\s+)?(?:a\s+)?(?:review|reviewer|verification)\b/.test(clause);
      const weakRequirement = /\b(?:optional|unnecessary|not required|need not)\b/.test(clause);
      const negated = /\b(?:never|(?:must|shall|may)\s+not|can(?:not|'t)|do\s+not|don't|not)\b[^;]{0,40}\b(?:skip|skipping|skipped|skippable|omit|omitting|omitted)\b/.test(clause) ||
        /\b(?:skip|skipping|skipped|skippable|omit|omitting|omitted)\b[^;]{0,40}\b(?:not allowed|forbidden|prohibited)\b/.test(clause) ||
        /\b(?:never|(?:must|shall|may)\s+not|can(?:not|'t)|do\s+not|don't|not)\b[^;]{0,40}\bwithout\s+(?:any\s+)?(?:a\s+)?(?:review|reviewer|verification)\b/.test(clause);
      const negatedWeakRequirement = /\b(?:not|never)\s+(?:optional|unnecessary)\b/.test(clause);
      const exception = /\b(?:unless|except(?:\s+when)?|only\s+if)\b/.test(clause);
      return hasReview && ((hasSkip && (!negated || exception)) ||
        (weakRequirement && (!negatedWeakRequirement || exception)));
    });
  for (const [phrase, expected] of [
    ['Never skip Reviewer verification', false],
    ['Reviewer verification must not be skipped', false],
    ['Must not proceed without review', false],
    ['Never skip risky review, but may skip simple review', true],
    ['Never skip review unless low-risk', true],
    ['Never skip review except when low-risk', true],
    ['Never skip review only if low-risk', true],
    ['May omit review', true],
    ['Proceed without review', true],
    ['Review is optional', true],
    ['Review is unnecessary', true],
    ['Review is not required', true],
    ['Review is skippable for low-risk work', true],
    ['Review is not optional', false],
    ['Review is not unnecessary', false],
  ]) assert(reviewSkipViolation(phrase) === expected, `review-skip detector case failed: ${phrase}`);
  const skipsReview = reviewSkipViolation(workflow);
  assert(hasAll(lead, 'use the current project'), 'lead tool rules must preserve Project ownership');
  assert(hasAll(shared, 'one `apply_patch` call carries all currently determined'), 'shared tool rules must keep the single apply_patch turn contract');
  assert(!/final verification/i.test(shared), 'shared tool rules must not presume a verification round');
  assert(!hasAll(shared, 'process/env, git, build/run/test→`shell`') && !/call `shell` only when/i.test(shared), 'shared tool rules must not prompt routine shell use');
  assert(!/write-role agents self-verify|benches|cross-scope verification/.test(lead), 'lead tool rules must not encourage routine shell verification');
  assert(hasAll(workflow, 'before the user explicitly approves the latest plan', 'no edits, no state mutation, no delegation'), 'default workflow must require latest-plan approval before work');
  assert(hasAll(workflow, 'on approval, delegate maximally', 'one agent per independent scope', 'all spawned in one turn', "only a scope that depends on another's output waits", 'split the plan into as many scopes as possible', 'disjoint file/module sets are independent', 'merge only on a true output dependency', 'prefer parallel scopes over sequential slices in one agent'), 'default workflow must delegate independent scopes maximally');
  assert(hasAll(workflow, 'a plan that yields only one scope buys no parallelism', 'lead executes it itself instead of wrapping a single agent'), 'default workflow must keep single-scope work with Lead');
  assert(hasAll(workflow, 'build, deploy, commit, and push happen only on an explicit user request', 'on direction change, pause and re-consult the user'), 'default workflow must require user authorization and re-consultation');
  assert(!skipsReview, 'default workflow must not permit delegated-review skips');
  assert(hasAll(solo, 'before the user explicitly approves the latest plan', 'read-only investigation and planning — no edits, no state mutation', 'a new or changed request resets planning; a scope change requires fresh approval'), 'Solo workflow must require latest-plan approval and reset it for request or scope changes');
  assert(hasAll(solo, 'on approval, lead executes all work itself', 'never spawn, send, or delegate to agents', 'complete in-scope fixes without reapproval'), 'Solo workflow must keep work with Lead, forbid delegation, and complete approved fixes');
  assert(hasAll(solo, 'build, deploy, commit, and push happen only on an explicit user request', 'on direction change, pause and re-consult the user'), 'Solo workflow must require user authorization and re-consultation');
  assert(/always start background tasks/i.test(AGENT_TOOL.description || '') && /distinct tags?/i.test(AGENT_TOOL.description || '') && /completion notification/i.test(AGENT_TOOL.description || ''), 'agent tool description must expose async parallel tags');

  mkdirSync(dataDir, { recursive: true });
  await initProviders({ 'openai-oauth': { enabled: true } });
  writeFileSync(join(root, 'feature.txt'), 'alpha\nbeta\n', 'utf8');
  writeFileSync(join(root, 'notes.txt'), 'TODO investigate timeout\n', 'utf8');

  const cfgMod = {
    loadConfig() {
      return {
        providers: { 'openai-oauth': { enabled: true } },
        agents: {
          worker: { provider: 'openai-oauth', model: 'gpt-5.5', effort: 'medium', fast: true },
          reviewer: { provider: 'openai-oauth', model: 'gpt-5.5', effort: 'low' },
          'heavy-worker': { provider: 'openai-oauth', model: 'gpt-5.5', effort: 'low' },
        },
        presets: [
          { id: 'fake-worker', name: 'Fake Worker', provider: 'openai-oauth', model: 'gpt-5.5', tools: 'full', effort: 'medium', fast: true },
          { id: 'fake-reviewer', name: 'Fake Reviewer', provider: 'openai-oauth', model: 'gpt-5.5', tools: 'readonly', effort: 'low' },
          { id: 'fake-heavy-worker', name: 'Fake Heavy Worker', provider: 'openai-oauth', model: 'gpt-5.5', tools: 'full', effort: 'low' },
        ],
      };
    },
    resolveRuntimeSpec(preset, ctx) {
      return { lane: 'agent', scopeKey: `smoke:${ctx.agentId}`, provider: preset.provider, model: preset.model };
    },
  };
  const reg = { initProviders };

  async function fakeAskSession(sessionId, prompt, _context, _onToolCall, cwdOverride) {
    const session = getSession(sessionId);
    if (session) {
      session.status = 'running';
      session.lastStreamDeltaAt = Date.now();
    }
    activeAsks += 1;
    maxActiveAsks = Math.max(maxActiveAsks, activeAsks);
    try {
      if (/parallel slow/i.test(prompt)) await sleep(600);
      if (/long busy/i.test(prompt)) await waitForBusyRelease();
      if (/write implementation/i.test(prompt)) {
        const out = await executePatchTool('apply_patch', {
          base_path: cwdOverride,
          patch: `*** Begin Patch
*** Update File: feature.txt
@@
 alpha
-beta
+beta from worker
*** End Patch
`,
        }, cwdOverride);
        return { content: `worker wrote feature\n${String(out).split(/\r?\n/)[0]}` };
      }
      if (/run verification/i.test(prompt)) {
        const out = await executeBuiltinTool('shell', {
          command: 'Get-Content feature.txt',
          cwd: cwdOverride,
          shell: 'powershell',
          timeout: 30_000,
        }, cwdOverride);
        return { content: `verification\n${out}` };
      }
      if (/review/i.test(prompt)) {
        const body = readFileSync(join(cwdOverride, 'feature.txt'), 'utf8');
        return { content: body.includes('worker') ? 'reviewer ok' : 'reviewer missing worker change' };
      }
      if (/timeout clue/i.test(prompt)) {
        return { content: `heavy-worker ${readFileSync(join(cwdOverride, 'notes.txt'), 'utf8').trim()}` };
      }
      return { content: `ack ${session?.agent || 'worker'}` };
    } finally {
      activeAsks -= 1;
      if (session) {
        session.status = 'idle';
        session.lastUsedAt = new Date().toISOString();
        session.lastStreamDeltaAt = Date.now();
      }
    }
  }

  const mgr = {
    getSession,
    listSessions,
    closeSession,
    getSessionRuntime,
    enqueuePendingMessage,
    getSessionLastProgressAt,
    askSession: fakeAskSession,
  };
  agentRunner = createStandaloneAgent({ cfgMod, reg, mgr, dataDir, cwd: root, defaultMode: 'async' });

  async function waitJob(out, pattern, label) {
    const id = taskId(out);
    assert(id, `missing task ID for ${label}: ${out}`);
    let last = '';
    for (let i = 0; i < 40; i += 1) {
      last = await agentRunner.execute({ type: 'read', task_id: id }, { invocationSource: 'model-tool', cwd: root });
      if (pattern.test(last)) return last;
      if (/^Error[\s:[]/.test(last) || /status: error/.test(last)) break;
      await sleep(100);
    }
    throw new Error(`${label} did not finish with ${pattern}: ${last}`);
  }

  async function waitAgentTag(tag, label) {
    for (let i = 0; i < 20; i += 1) {
      if (agentRunner.getStatus({ cwd: root }).workers
        .some((worker) => worker?.tag === tag && worker.status === 'running')) return;
      await sleep(25);
    }
    throw new Error(`${label} did not start agent tag ${tag}`);
  }

  const spawnOut = await agentRunner.execute({
    type: 'spawn',
    agent: 'worker',
    tag: 'impl1',
    cwd: root,
    prompt: 'write implementation: update feature.txt with apply_patch',
  }, { invocationSource: 'model-tool', cwd: root });
  await waitJob(spawnOut, /worker wrote feature/, 'worker write');

  const sendOut = await agentRunner.execute({
    type: 'send',
    tag: 'impl1',
    message: 'run verification: inspect feature.txt using bash',
  }, { invocationSource: 'model-tool', cwd: root });
  assert(/agent task:/.test(sendOut), `completed worker send should be async task, got ${sendOut}`);
  await waitJob(sendOut, /beta from worker/, 'worker verify');

  const reviewOut = await agentRunner.execute({
    type: 'spawn',
    agent: 'reviewer',
    tag: 'rev1',
    cwd: root,
    prompt: 'review feature.txt for the worker change',
  }, { invocationSource: 'model-tool', cwd: root });
  const heavyOut = await agentRunner.execute({
    type: 'spawn',
    agent: 'heavy-worker',
    tag: 'heavy1',
    cwd: root,
    prompt: 'inspect notes.txt timeout clue',
  }, { invocationSource: 'model-tool', cwd: root });
  await waitJob(reviewOut, /reviewer ok/, 'reviewer');
  await waitJob(heavyOut, /heavy-worker TODO/, 'heavy-worker');

  const parallelSpawns = await Promise.all([
    agentRunner.execute({
      type: 'spawn',
      agent: 'worker',
      tag: 'parWorker',
      cwd: root,
      prompt: 'parallel slow worker task',
    }, { invocationSource: 'model-tool', cwd: root }),
    agentRunner.execute({
      type: 'spawn',
      agent: 'reviewer',
      tag: 'parReviewer',
      cwd: root,
      prompt: 'parallel slow review task',
    }, { invocationSource: 'model-tool', cwd: root }),
    agentRunner.execute({
      type: 'spawn',
      agent: 'heavy-worker',
      tag: 'parHeavy',
      cwd: root,
      prompt: 'parallel slow heavy task',
    }, { invocationSource: 'model-tool', cwd: root }),
  ]);
  assert(parallelSpawns.every((out) => /agent task:/.test(out)), `parallel spawns must return tasks: ${parallelSpawns.join('\n---\n')}`);
  await Promise.all([
    waitJob(parallelSpawns[0], /ack worker/, 'parallel worker'),
    waitJob(parallelSpawns[1], /reviewer ok/, 'parallel reviewer'),
    waitJob(parallelSpawns[2], /ack heavy-worker/, 'parallel heavy-worker'),
  ]);
  assert(maxActiveAsks >= 2, `agents did not overlap; maxActiveAsks=${maxActiveAsks}`);

  const busyOut = await agentRunner.execute({
    type: 'spawn',
    agent: 'worker',
    tag: 'busy1',
    cwd: root,
    prompt: 'long busy worker task',
  }, { invocationSource: 'model-tool', cwd: root });
  await waitAgentTag('busy1', 'busy worker');
  const queued = await agentRunner.execute({
    type: 'send',
    tag: 'busy1',
    message: 'follow-up while still busy',
  }, { invocationSource: 'model-tool', cwd: root });
  assert(/agent message queued/.test(queued), `busy send should queue, got ${queued}`);
  releaseBusyWorker();
  await waitJob(busyOut, /ack worker/, 'busy worker');

  const missing = await agentRunner.execute({ type: 'read', task_id: 'task_missing_live_smoke' }, { invocationSource: 'model-tool', cwd: root });
  assert(/^Error[\s:[]/.test(missing), 'missing agent task should be Error result');
  assert(readFileSync(join(root, 'feature.txt'), 'utf8').includes('beta from worker'), 'final file missing worker edit');
  closeAgentRunner();
  process.stdout.write('live worker smoke passed\n');
}

try {
  await main();
} finally {
  try {
    releaseBusyWorker();
  } finally {
    try {
      closeAgentRunner();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
