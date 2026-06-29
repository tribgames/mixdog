#!/usr/bin/env node
// Focused smoke for the spawn tag-reuse priority added to agent-tool.mjs.
//
// Validates the unified 4-tier spawn dispatch when an explicit tag is pinned:
//   1) live + idle  -> spawn reuses the existing session (reused:true, send path)
//   2) live + busy  -> spawn queues the prompt instead of throwing
//   3) lingering terminal trace (no live session) -> spawn/send error, no respawn
//   4) genuinely new tag -> a fresh spawn (no reused/respawned flag)
//
// No network: a fake askSession drives status transitions. Uses the REAL
// session manager so resolveTag / worker-index behavior is exercised end to end.
//
// Run: node scripts/agent-tag-reuse-smoke.mjs
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStandaloneAgent } from '../src/standalone/agent-tool.mjs';
import { initProviders } from '../src/runtime/agent/orchestrator/providers/registry.mjs';
import {
  closeSession,
  enqueuePendingMessage,
  getSession,
  getSessionLastProgressAt,
  getSessionRuntime,
  listSessions,
} from '../src/runtime/agent/orchestrator/session/manager.mjs';

process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';

const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-reuse-'));
const dataDir = join(root, '.mixdog-data');
mkdirSync(dataDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function taskId(text) { return String(text).match(/agent task: (\S+)/)?.[1] || null; }

const askLog = [];
let holdBusy = false;
async function fakeAskSession(sessionId, prompt) {
  const session = getSession(sessionId);
  if (session) { session.status = 'running'; session.lastStreamDeltaAt = Date.now(); }
  askLog.push({ sessionId, prompt });
  try {
    if (holdBusy && /stay busy/i.test(prompt)) {
      for (let i = 0; i < 40 && holdBusy; i += 1) await sleep(25);
    }
    return { content: `ack: ${String(prompt).split('\n').pop()}` };
  } finally {
    if (session) { session.status = 'idle'; session.lastUsedAt = new Date().toISOString(); session.lastStreamDeltaAt = Date.now(); }
  }
}

const cfgMod = {
  loadConfig() {
    return {
      providers: { 'openai-oauth': { enabled: true } },
      agents: {
        reviewer: { provider: 'openai-oauth', model: 'gpt-5.5', effort: 'low' },
        worker: { provider: 'openai-oauth', model: 'gpt-5.5', effort: 'low', fast: true },
      },
      presets: [
        { id: 'fake-reviewer', name: 'Fake Reviewer', provider: 'openai-oauth', model: 'gpt-5.5', tools: 'readonly', effort: 'low' },
        { id: 'fake-worker', name: 'Fake Worker', provider: 'openai-oauth', model: 'gpt-5.5', tools: 'full', effort: 'low', fast: true },
      ],
    };
  },
  resolveRuntimeSpec(preset, ctx) {
    return { lane: 'agent', scopeKey: `reuse:${ctx.agentId}`, provider: preset.provider, model: preset.model };
  },
};
const reg = { initProviders };
const mgr = {
  getSession,
  listSessions,
  closeSession,
  getSessionRuntime,
  enqueuePendingMessage,
  getSessionLastProgressAt,
  askSession: fakeAskSession,
};

const ctx = { invocationSource: 'model-tool', cwd: root, clientHostPid: 0xBEEF };
const agent = createStandaloneAgent({ cfgMod, reg, mgr, dataDir, cwd: root, defaultMode: 'async' });

async function waitJob(out, pattern, label, tries = 60) {
  const id = taskId(out);
  assert(id, `missing task id for ${label}: ${out}`);
  let last = '';
  for (let i = 0; i < tries; i += 1) {
    last = await agent.execute({ type: 'read', task_id: id }, ctx);
    if (pattern.test(last)) return last;
    if (/status: error/.test(last)) break;
    await sleep(40);
  }
  throw new Error(`${label} did not match ${pattern}: ${last}`);
}
function sessionForTag(tag) {
  return listSessions().find((s) => s?.agentTag === tag && !s.closed) || null;
}
async function waitSessionForTag(tag, label, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const s = sessionForTag(tag);
    if (s) return s;
    await sleep(25);
  }
  throw new Error(`${label}: live session for tag ${tag} never appeared`);
}

async function main() {
  await initProviders({ 'openai-oauth': { enabled: true } });

  // --- tier 4: a genuinely new explicit tag spawns fresh (no reuse flag) ---
  const firstOut = await agent.execute({
    type: 'spawn', agent: 'reviewer', tag: 'reviewerA', prompt: 'first review pass', cwd: root,
  }, ctx);
  assert(/agent task:/.test(firstOut), `first spawn must return a task: ${firstOut}`);
  assert(!/reused: true/.test(firstOut) && !/respawned/.test(firstOut), `fresh tag must not be flagged reused/respawned: ${firstOut}`);
  await waitJob(firstOut, /ack: first review pass/, 'first spawn');
  const sid = (await waitSessionForTag('reviewerA', 'first spawn')).id;
  assert(sid, 'reviewerA session should remain live (idle) within the reap window');

  // --- tier 1 (the headline bug): re-spawn the SAME tag while idle+live ---
  const reuseOut = await agent.execute({
    type: 'spawn', agent: 'reviewer', tag: 'reviewerA', prompt: 'second review pass', cwd: root,
  }, ctx);
  assert(!/^Error/.test(reuseOut), `idle same-tag re-spawn must not error: ${reuseOut}`);
  assert(/reused: true/.test(reuseOut), `idle same-tag re-spawn must be flagged reused: ${reuseOut}`);
  await waitJob(reuseOut, /ack: second review pass/, 'reuse spawn');
  const sid2 = (await waitSessionForTag('reviewerA', 'reuse spawn')).id;
  assert(sid2 === sid, `reuse must continue the SAME session (context kept): ${sid} -> ${sid2}`);

  // --- tier 2: re-spawn the SAME tag while BUSY -> queue, do not throw ---
  holdBusy = true;
  const busyStart = await agent.execute({
    type: 'spawn', agent: 'worker', tag: 'workerB', prompt: 'stay busy please', cwd: root,
  }, ctx);
  const busySession = await waitSessionForTag('workerB', 'busy worker');
  for (let i = 0; i < 40; i += 1) {
    if (getSession(busySession.id)?.status === 'running') break;
    await sleep(25);
  }
  const queuedOut = await agent.execute({
    type: 'spawn', agent: 'worker', tag: 'workerB', prompt: 'stacked while busy', cwd: root,
  }, ctx);
  assert(/agent message queued/.test(queuedOut), `busy same-tag re-spawn must queue, got: ${queuedOut}`);
  assert(/reused: true/.test(queuedOut), `busy re-spawn queue should carry reused flag: ${queuedOut}`);
  holdBusy = false;
  await waitJob(busyStart, /ack: stay busy please/, 'busy worker finish');

  // --- tier 3: terminal trace only -> coldRespawn keeps the tag ---
  // --- tier 3: lingering trace without live session must not cold-respawn ---
  closeSession(sid, 'smoke-session-closed-trace');
  const traceSpawnOut = await agent.execute({
    type: 'spawn', agent: 'reviewer', tag: 'reviewerA', prompt: 'must not respawn', cwd: root,
  }, ctx);
  assert(/^Error:/.test(traceSpawnOut), `terminal-trace spawn must error, got: ${traceSpawnOut}`);
  assert(/finished or closed worker/i.test(traceSpawnOut), `spawn error should mention trace: ${traceSpawnOut}`);
  const traceSendOut = await agent.execute({
    type: 'send', tag: 'reviewerA', message: 'must not cold-respawn', cwd: root,
  }, ctx);
  assert(/^Error:/.test(traceSendOut), `terminal-trace send must error, got: ${traceSendOut}`);
  assert(/not found|closed/i.test(traceSendOut), `send should surface prepareSend failure: ${traceSendOut}`);

  // agent close clears the trace; same tag can spawn fresh again
  await agent.execute({ type: 'close', tag: 'reviewerA' }, ctx);
  const freshAfterClose = await agent.execute({
    type: 'spawn', agent: 'reviewer', tag: 'reviewerA', prompt: 'post-forget fresh', cwd: root,
  }, ctx);
  assert(!/^Error/.test(freshAfterClose), `post-forget spawn must work: ${freshAfterClose}`);
  await waitJob(freshAfterClose, /ack: post-forget fresh/, 'post-forget spawn');

  process.stdout.write(`agent tag-reuse smoke passed (asks=${askLog.length})\n`);
}

try {
  await main();
} finally {
  try { agent.closeAll('agent-tag-reuse-smoke-end'); } catch {}
  rmSync(root, { recursive: true, force: true });
}
