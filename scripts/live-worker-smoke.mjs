#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BRIDGE_TOOL, createStandaloneBridge } from '../src/standalone/bridge-tool.mjs';
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobId(text) {
  return String(text).match(/bridge job: (\S+)/)?.[1] || null;
}

async function main() {
  const leadToolRules = readFileSync('src/rules/lead/00-tool-lead.md', 'utf8');
  const workflowRules = readFileSync('src/defaults/user-workflow.md', 'utf8');
  assert(/Use `bridge` to delegate actual scoped work/i.test(leadToolRules), 'lead rules must direct scoped work to bridge');
  assert(/parallelize independent files\/concerns/i.test(leadToolRules), 'lead rules must keep independent work parallel');
  assert(/Use bridge workers/i.test(workflowRules) && /parallelizes useful work/i.test(workflowRules), 'workflow rules must recommend bridge parallelism');
  assert(/always async/i.test(BRIDGE_TOOL.description || '') && /spawn distinct tags/i.test(BRIDGE_TOOL.description || ''), 'bridge tool description must expose async parallel tags');

  mkdirSync(dataDir, { recursive: true });
  await initProviders({ 'openai-oauth': { enabled: true } });
  writeFileSync(join(dataDir, 'user-workflow.json'), JSON.stringify({
    roles: [
      { name: 'worker', preset: 'fake-worker', permission: 'full', maxLoopIterations: 3, idleTimeoutMs: 5000 },
      { name: 'reviewer', preset: 'fake-reviewer', permission: 'read' },
      { name: 'debugger', preset: 'fake-debugger', permission: 'read' },
    ],
  }));
  writeFileSync(join(root, 'feature.txt'), 'alpha\nbeta\n', 'utf8');
  writeFileSync(join(root, 'notes.txt'), 'TODO investigate timeout\n', 'utf8');

  const cfgMod = {
    loadConfig() {
      return {
        providers: { 'openai-oauth': { enabled: true } },
        presets: [
          { id: 'fake-worker', name: 'Fake Worker', provider: 'openai-oauth', model: 'gpt-5.5', tools: 'full', effort: 'medium', fast: true },
          { id: 'fake-reviewer', name: 'Fake Reviewer', provider: 'openai-oauth', model: 'gpt-5.5', tools: 'readonly', effort: 'low' },
          { id: 'fake-debugger', name: 'Fake Debugger', provider: 'openai-oauth', model: 'gpt-5.5', tools: 'readonly', effort: 'low' },
        ],
      };
    },
    resolveRuntimeSpec(preset, ctx) {
      return { lane: 'bridge', scopeKey: `smoke:${ctx.agentId}`, provider: preset.provider, model: preset.model };
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
      if (/long busy/i.test(prompt)) await sleep(350);
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
        const out = await executeBuiltinTool('bash', {
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
      if (/debug/i.test(prompt)) {
        return { content: `debugger ${readFileSync(join(cwdOverride, 'notes.txt'), 'utf8').trim()}` };
      }
      return { content: `ack ${session?.role || 'worker'}` };
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
  const bridge = createStandaloneBridge({ cfgMod, reg, mgr, dataDir, cwd: root, defaultMode: 'async' });

  async function waitJob(out, pattern, label) {
    const id = jobId(out);
    assert(id, `missing job id for ${label}: ${out}`);
    let last = '';
    for (let i = 0; i < 40; i += 1) {
      last = await bridge.execute({ type: 'read', jobId: id }, { invocationSource: 'model-tool', cwd: root });
      if (pattern.test(last)) return last;
      if (/^Error[\s:[]/.test(last) || /status: error/.test(last)) break;
      await sleep(100);
    }
    throw new Error(`${label} did not finish with ${pattern}: ${last}`);
  }

  const spawnOut = await bridge.execute({
    type: 'spawn',
    role: 'worker',
    tag: 'impl1',
    cwd: root,
    prompt: 'write implementation: update feature.txt with apply_patch',
  }, { invocationSource: 'model-tool', cwd: root });
  await waitJob(spawnOut, /worker wrote feature/, 'worker write');

  const sendOut = await bridge.execute({
    type: 'send',
    tag: 'impl1',
    message: 'run verification: inspect feature.txt using bash',
  }, { invocationSource: 'model-tool', cwd: root });
  assert(/bridge job:/.test(sendOut), `completed worker send should be async job, got ${sendOut}`);
  await waitJob(sendOut, /beta from worker/, 'worker verify');

  const reviewOut = await bridge.execute({
    type: 'spawn',
    role: 'reviewer',
    tag: 'rev1',
    cwd: root,
    prompt: 'review feature.txt for the worker change',
  }, { invocationSource: 'model-tool', cwd: root });
  const debugOut = await bridge.execute({
    type: 'spawn',
    role: 'debugger',
    tag: 'dbg1',
    cwd: root,
    prompt: 'debug notes.txt timeout clue',
  }, { invocationSource: 'model-tool', cwd: root });
  await waitJob(reviewOut, /reviewer ok/, 'reviewer');
  await waitJob(debugOut, /debugger TODO/, 'debugger');

  const parallelSpawns = await Promise.all([
    bridge.execute({
      type: 'spawn',
      role: 'worker',
      tag: 'parWorker',
      cwd: root,
      prompt: 'parallel slow worker task',
    }, { invocationSource: 'model-tool', cwd: root }),
    bridge.execute({
      type: 'spawn',
      role: 'reviewer',
      tag: 'parReviewer',
      cwd: root,
      prompt: 'parallel slow review task',
    }, { invocationSource: 'model-tool', cwd: root }),
    bridge.execute({
      type: 'spawn',
      role: 'debugger',
      tag: 'parDebugger',
      cwd: root,
      prompt: 'parallel slow debug task',
    }, { invocationSource: 'model-tool', cwd: root }),
  ]);
  assert(parallelSpawns.every((out) => /bridge job:/.test(out)), `parallel spawns must return jobs: ${parallelSpawns.join('\n---\n')}`);
  await Promise.all([
    waitJob(parallelSpawns[0], /ack worker/, 'parallel worker'),
    waitJob(parallelSpawns[1], /reviewer ok/, 'parallel reviewer'),
    waitJob(parallelSpawns[2], /debugger TODO/, 'parallel debugger'),
  ]);
  assert(maxActiveAsks >= 2, `bridge workers did not overlap; maxActiveAsks=${maxActiveAsks}`);

  const busyOut = await bridge.execute({
    type: 'spawn',
    role: 'worker',
    tag: 'busy1',
    cwd: root,
    prompt: 'long busy worker task',
  }, { invocationSource: 'model-tool', cwd: root });
  const queued = await bridge.execute({
    type: 'send',
    tag: 'busy1',
    message: 'follow-up while still busy',
  }, { invocationSource: 'model-tool', cwd: root });
  assert(/bridge message queued/.test(queued), `busy send should queue, got ${queued}`);
  await waitJob(busyOut, /ack worker/, 'busy worker');

  const missing = await bridge.execute({ type: 'read', jobId: 'job_missing_live_smoke' }, { invocationSource: 'model-tool', cwd: root });
  assert(/^Error[\s:[]/.test(missing), 'missing bridge job should be Error result');
  assert(readFileSync(join(root, 'feature.txt'), 'utf8').includes('beta from worker'), 'final file missing worker edit');
  bridge.closeAll('live-worker-smoke-end');
  process.stdout.write('live worker smoke passed\n');
}

try {
  await main();
} finally {
  rmSync(root, { recursive: true, force: true });
}
