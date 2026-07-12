#!/usr/bin/env node
// Focused smoke for the spawn tag-reuse priority added to agent-tool.mjs.
//
// Validates the unified 4-tier spawn dispatch when an explicit tag is pinned:
//   1) live + idle  -> spawn reuses the existing session (reused:true, send path)
//   2) live + busy  -> spawn queues the prompt instead of throwing
//   3) lingering terminal trace -> spawn reaps tag; dead-tag send auto-respawns
//   4) genuinely new tag -> a fresh spawn (no reused/respawned flag)
//
// No network: a fake askSession drives status transitions. Uses the REAL
// session manager so resolveTag / worker-index behavior is exercised end to end.
//
// Run: node scripts/agent-tag-reuse-smoke.mjs
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
process.env.MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS = '50';
// Terminal reap is intentionally no longer environment-configurable. Keep a
// conflicting value here so this smoke proves the Advanced provider override
// is the authority; shorten only the test clock, not the configured duration.
process.env.MIXDOG_AGENT_TERMINAL_REAP_MS = '1000';
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => nativeSetTimeout(callback, ms === 60_000 ? 1000 : ms, ...args);

const { createStandaloneAgent } = await import('../src/standalone/agent-tool.mjs');

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
let delayGeminiInit = false;
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
      providers: delayGeminiInit ? {
        'openai-oauth': { enabled: true },
        gemini: { enabled: true, apiKey: 'smoke-key' },
      } : { 'openai-oauth': { enabled: true } },
      autoClear: { providerIdleMs: { 'openai-oauth': 60_000 } },
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
const reg = {
  async initProviders(providers) {
    if (delayGeminiInit && providers?.gemini) await sleep(100);
    return await initProviders(providers);
  },
};
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
const peerCtx = { invocationSource: 'model-tool', cwd: root, clientHostPid: 0xCAFE };
const agent = createStandaloneAgent({ cfgMod, reg, mgr, dataDir, cwd: root, defaultMode: 'async' });
const peerAgent = createStandaloneAgent({ cfgMod, reg, mgr, dataDir, cwd: root, defaultMode: 'async' });

async function waitJob(out, pattern, label, tries = 60, context = ctx) {
  const id = taskId(out);
  assert(id, `missing task id for ${label}: ${out}`);
  let last = '';
  for (let i = 0; i < tries; i += 1) {
    last = await agent.execute({ type: 'read', task_id: id }, context);
    if (pattern.test(last)) return last;
    if (/status: error/.test(last)) break;
    await sleep(40);
  }
  throw new Error(`${label} did not match ${pattern}: ${last}`);
}
function sessionForTag(tag) {
  for (let i = askLog.length - 1; i >= 0; i -= 1) {
    const session = getSession(askLog[i].sessionId);
    if (session?.agentTag === tag && !session.closed) return session;
  }
  return null;
}
function addPeerTerminalRow(tag, sessionId) {
  const file = join(dataDir, 'agent-workers.json');
  const index = JSON.parse(readFileSync(file, 'utf8'));
  index.workers[sessionId] = {
    tag,
    sessionId,
    agent: 'worker',
    provider: 'openai-oauth',
    status: 'idle',
    stage: 'idle',
    updatedAt: new Date().toISOString(),
    clientHostPid: peerCtx.clientHostPid,
    cwd: root,
  };
  writeFileSync(file, JSON.stringify(index));
}
function addWorkerRow({
  tag,
  sessionId,
  clientHostPid = ctx.clientHostPid,
  status = 'idle',
  updatedAt = new Date().toISOString(),
  agentName = 'worker',
}) {
  const file = join(dataDir, 'agent-workers.json');
  const index = JSON.parse(readFileSync(file, 'utf8'));
  index.workers[sessionId] = {
    tag,
    sessionId,
    agent: agentName,
    provider: 'openai-oauth',
    status,
    stage: status,
    updatedAt,
    clientHostPid,
    cwd: root,
  };
  writeFileSync(file, JSON.stringify(index));
}
function addTombstones(rows) {
  const file = join(dataDir, 'agent-workers.json');
  const index = JSON.parse(readFileSync(file, 'utf8'));
  index.tombstones ||= {};
  for (const row of rows) index.tombstones[`${row.clientHostPid || 0}:${row.tag}`] = row;
  writeFileSync(file, JSON.stringify(index));
}
function tombstonesForTag(tag) {
  const index = JSON.parse(readFileSync(join(dataDir, 'agent-workers.json'), 'utf8'));
  return Object.values(index.tombstones || {}).filter((row) => row.tag === tag);
}
function hasWorkerRow(sessionId) {
  const index = JSON.parse(readFileSync(join(dataDir, 'agent-workers.json'), 'utf8'));
  return Boolean(index.workers?.[sessionId]);
}
function removeWorkerRow(sessionId) {
  const file = join(dataDir, 'agent-workers.json');
  const index = JSON.parse(readFileSync(file, 'utf8'));
  delete index.workers?.[sessionId];
  writeFileSync(file, JSON.stringify(index));
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
  const firstSession = await waitSessionForTag('reviewerA', 'first spawn');
  await waitJob(firstOut, /ack: first review pass/, 'first spawn');
  const sid = firstSession.id;
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

  // --- tier 3: terminal trace -> reap and reuse tag (spawn) or auto-respawn (send) ---
  closeSession(sid, 'smoke-session-closed-trace');
  addPeerTerminalRow('reviewerA', 'sess_peer_trace');
  const traceSpawnOut = await agent.execute({
    type: 'spawn', agent: 'reviewer', tag: 'reviewerA', prompt: 'trace reap respawn', cwd: root,
  }, ctx);
  assert(!/^Error:/.test(traceSpawnOut), `terminal-trace spawn must reap and reuse tag: ${traceSpawnOut}`);
  assert(/respawned: true/.test(traceSpawnOut), `terminal-trace spawn must flag lost context: ${traceSpawnOut}`);
  await waitJob(traceSpawnOut, /ack: trace reap respawn/, 'trace reap spawn');
  assert(hasWorkerRow('sess_peer_trace'), 'terminal-trace reap must preserve a peer terminal row with the same tag');
  removeWorkerRow('sess_peer_trace');
  const traceLive = await waitSessionForTag('reviewerA', 'trace reap spawn live');
  closeSession(traceLive.id, 'smoke-kill-for-send-respawn');
  const traceSendOut = await agent.execute({
    type: 'send', tag: 'reviewerA', message: 'auto-respawn follow-up', cwd: root,
  }, ctx);
  assert(!/^Error:/.test(traceSendOut), `dead-tag send must auto-respawn: ${traceSendOut}`);
  assert(/respawned: true/.test(traceSendOut), `send auto-respawn must flag respawned: ${traceSendOut}`);
  assert(!/reused: true/.test(traceSendOut), `dead-tag send must not be a live reuse: ${traceSendOut}`);
  await waitJob(traceSendOut, /ack: auto-respawn follow-up/, 'trace send respawn');

  // A local terminal timer must remove only its own same-tag trace; a peer
  // terminal may legitimately retain the identical tag at the same time.
  const timerPeerStart = await agent.execute({
    type: 'spawn', agent: 'worker', tag: 'timer-peer', prompt: 'timer peer seed', cwd: root,
  }, ctx);
  await waitJob(timerPeerStart, /ack: timer peer seed/, 'timer peer seed');
  const timerPeerSession = (await waitSessionForTag('timer-peer', 'timer peer seed')).id;
  addPeerTerminalRow('timer-peer', 'sess_peer_timer');
  await sleep(1200);
  assert(getSession(timerPeerSession)?.closed, 'terminal timer must reap its local session');
  assert(hasWorkerRow('sess_peer_timer'), 'terminal timer must preserve a peer row with the same tag');

  // Fully reaped tags retain a terminal-scoped tombstone, so send inherits the
  // prior agent/cwd without the caller having to reconstruct cold identity.
  const coldStart = await agent.execute({
    type: 'spawn', agent: 'worker', tag: 'cold-reaped', prompt: 'cold reap seed', cwd: root,
  }, ctx);
  await waitJob(coldStart, /ack: cold reap seed/, 'cold reap seed');
  const coldSessionId = (await waitSessionForTag('cold-reaped', 'cold reap seed')).id;
  await sleep(1700);
  assert(!sessionForTag('cold-reaped') && getSession(coldSessionId)?.closed, 'terminal reaper must remove the cold-reaped session');
  const coldSendOut = await agent.execute({
    type: 'send', tag: 'cold-reaped', message: 'cold reap replacement',
  }, ctx);
  assert(!/^Error:/.test(coldSendOut), `fully reaped tag must cold-respawn: ${coldSendOut}`);
  assert(/respawned: true/.test(coldSendOut), `fully reaped send must flag respawned: ${coldSendOut}`);
  await waitJob(coldSendOut, /ack: cold reap replacement/, 'cold reap replacement');

  // Explicit spawn consumes the same tombstone form and also reports that the
  // previous conversational context was lost.
  const coldSpawnSeed = await agent.execute({
    type: 'spawn', agent: 'reviewer', tag: 'cold-spawn-reaped', prompt: 'cold spawn seed', cwd: root,
  }, ctx);
  await waitJob(coldSpawnSeed, /ack: cold spawn seed/, 'cold spawn seed');
  const coldSpawnSessionId = (await waitSessionForTag('cold-spawn-reaped', 'cold spawn seed')).id;
  await sleep(1700);
  assert(getSession(coldSpawnSessionId)?.closed, 'terminal reaper must close the cold-spawn seed');
  const coldSpawnOut = await agent.execute({
    type: 'spawn', tag: 'cold-spawn-reaped', prompt: 'cold spawn replacement',
  }, ctx);
  assert(!/^Error:/.test(coldSpawnOut), `tombstoned tag spawn must respawn: ${coldSpawnOut}`);
  assert(/respawned: true/.test(coldSpawnOut), `tombstoned tag spawn must flag respawned: ${coldSpawnOut}`);
  await waitJob(coldSpawnOut, /ack: cold spawn replacement/, 'cold spawn replacement');

  // A stale running row with neither a live session nor a recent heartbeat is
  // transitioned to a tombstone instead of blocking this tag forever.
  addWorkerRow({
    tag: 'stale-running',
    sessionId: 'sess_stale_running',
    status: 'running',
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
  });
  const staleRunningOut = await agent.execute({
    type: 'spawn', tag: 'stale-running', prompt: 'stale running replacement',
  }, ctx);
  assert(!/^Error:/.test(staleRunningOut), `stale nonterminal row must transition: ${staleRunningOut}`);
  assert(/respawned: true/.test(staleRunningOut), `stale nonterminal transition must flag respawned: ${staleRunningOut}`);
  await waitJob(staleRunningOut, /ack: stale running replacement/, 'stale running replacement');

  // A raw session id, typo without retained evidence/identity, and a peer tag
  // must never turn into a local cold spawn.
  const rawSessionOut = await agent.execute({
    type: 'send', sessionId: 'sess_missing', agent: 'worker', message: 'must not spawn', cwd: root,
  }, ctx);
  assert(/^Error:/.test(rawSessionOut), `raw session id must remain an error: ${rawSessionOut}`);
  const typoOut = await agent.execute({
    type: 'send', tag: 'typo-no-evidence', message: 'must not spawn', cwd: root,
  }, ctx);
  assert(/^Error:/.test(typoOut), `unproven typo tag must remain an error: ${typoOut}`);
  const peerStart = await peerAgent.execute({
    type: 'spawn', agent: 'worker', tag: 'peer-owned', prompt: 'peer seed', cwd: root,
  }, peerCtx);
  await waitJob(peerStart, /ack: peer seed/, 'peer seed', 60, peerCtx);
  const peerOut = await agent.execute({
    type: 'send', agent: 'worker', tag: 'peer-owned', message: 'must not take peer tag', cwd: root,
  }, ctx);
  assert(/^Error:/.test(peerOut), `peer-terminal tag must remain an error: ${peerOut}`);

  // Let the peer session become a peer-owned tombstone. Neither normal nor
  // allTerminals dispatch may inherit that terminal identity.
  await sleep(1700);
  assert(tombstonesForTag('peer-owned').some((row) => row.clientHostPid === peerCtx.clientHostPid), 'peer-owned tombstone must exist');
  const peerTombstoneSend = await agent.execute({
    type: 'send', tag: 'peer-owned', message: 'must not absorb peer tombstone', allTerminals: true,
  }, ctx);
  assert(/^Error:/.test(peerTombstoneSend), `allTerminals send must reject peer tombstone: ${peerTombstoneSend}`);
  const peerTombstoneSpawn = await agent.execute({
    type: 'spawn', tag: 'peer-owned', prompt: 'must not inherit peer spawn', allTerminals: true,
  }, ctx);
  assert(/^Error:/.test(peerTombstoneSpawn), `allTerminals spawn must reject peer tombstone inheritance: ${peerTombstoneSpawn}`);

  // Local evidence wins when a peer tombstone with the same tag coexists.
  addTombstones([
    { tag: 'coowned', agent: 'reviewer', cwd: root, clientHostPid: ctx.clientHostPid, reapedAt: new Date().toISOString() },
    { tag: 'coowned', agent: 'worker', cwd: root, clientHostPid: peerCtx.clientHostPid, reapedAt: new Date().toISOString() },
  ]);
  const coownedOut = await agent.execute({
    type: 'send', tag: 'coowned', message: 'prefer local tombstone', allTerminals: true,
  }, ctx);
  assert(!/^Error:/.test(coownedOut), `local tombstone must beat coexisting peer: ${coownedOut}`);
  assert(/respawned: true/.test(coownedOut), `coexisting local tombstone must respawn: ${coownedOut}`);
  await waitJob(coownedOut, /ack: prefer local tombstone/, 'coowned local tombstone');

  // Fill the cap with future-dated entries, then let a real reap write one more.
  // The current write must survive clamping/pruning.
  const pruneSeed = await agent.execute({
    type: 'spawn', agent: 'worker', tag: 'prune-current', prompt: 'prune seed', cwd: root,
  }, ctx);
  await waitJob(pruneSeed, /ack: prune seed/, 'prune seed');
  addTombstones(Array.from({ length: 500 }, (_, i) => ({
    tag: `future-${i}`,
    agent: 'worker',
    cwd: root,
    clientHostPid: ctx.clientHostPid,
    reapedAt: new Date(Date.now() + 86_400_000 + i).toISOString(),
  })));
  await sleep(1700);
  assert(tombstonesForTag('prune-current').length === 1, 'prune cap must retain the tombstone written this call');

  // agent close clears the trace; same tag can spawn fresh again
  addPeerTerminalRow('reviewerA', 'sess_peer_close');
  await agent.execute({ type: 'close', tag: 'reviewerA' }, ctx);
  assert(hasWorkerRow('sess_peer_close'), 'explicit close must preserve a peer terminal row with the same tag');
  removeWorkerRow('sess_peer_close');
  const freshAfterClose = await agent.execute({
    type: 'spawn', agent: 'reviewer', tag: 'reviewerA', prompt: 'post-forget fresh', cwd: root,
  }, ctx);
  assert(!/^Error/.test(freshAfterClose), `post-forget spawn must work: ${freshAfterClose}`);
  await waitJob(freshAfterClose, /ack: post-forget fresh/, 'post-forget spawn');

  // A timed-out spawn prep can bind after its task is already terminal. Its
  // cleanup must remove only that late local session, preserving a peer row
  // and leaving the local tag free for a fresh spawn.
  delayGeminiInit = true;
  const prepOut = await agent.execute({
    type: 'spawn', agent: 'worker', tag: 'prep-peer', provider: 'gemini', model: 'gemini-smoke', prompt: 'late prep cleanup', cwd: root,
  }, ctx);
  assert(/agent task:/.test(prepOut), `prep-timeout spawn must return a task: ${prepOut}`);
  addPeerTerminalRow('prep-peer', 'sess_peer_prep');
  await sleep(200);
  delayGeminiInit = false;
  const prepStatus = await agent.execute({ type: 'read', task_id: taskId(prepOut) }, ctx);
  assert(/status: error|spawn prep timed out/i.test(prepStatus), `prep cleanup path must time out: ${prepStatus}`);
  assert(hasWorkerRow('sess_peer_prep'), 'spawn-prep cleanup must preserve a peer terminal row with the same tag');
  const freshPrep = await agent.execute({
    type: 'spawn', agent: 'worker', tag: 'prep-peer', prompt: 'fresh after prep cleanup', cwd: root,
  }, ctx);
  assert(!/^Error/.test(freshPrep), `fresh same-tag spawn must follow prep cleanup: ${freshPrep}`);
  await waitJob(freshPrep, /ack: fresh after prep cleanup/, 'fresh after prep cleanup');

  // A stale local tagAgents entry may make explicit close return forgotten:true,
  // but it must not erase a peer terminal's same-tag worker row.
  const staleStart = await agent.execute({
    type: 'spawn', agent: 'worker', tag: 'fallback-peer', prompt: 'stale fallback seed', cwd: root,
  }, ctx);
  await waitJob(staleStart, /ack: stale fallback seed/, 'stale fallback seed');
  const staleSessionId = (await waitSessionForTag('fallback-peer', 'stale fallback seed')).id;
  closeSession(staleSessionId, 'smoke-stale-close-fallback');
  removeWorkerRow(staleSessionId);
  addPeerTerminalRow('fallback-peer', 'sess_peer_fallback');
  const fallbackClose = await agent.execute({ type: 'close', tag: 'fallback-peer' }, ctx);
  assert(
    /forgotten: true|target "fallback-peer" not found/.test(fallbackClose),
    `stale close fallback must forget locally or report no local target: ${fallbackClose}`,
  );
  assert(hasWorkerRow('sess_peer_fallback'), 'stale close fallback must preserve a peer terminal row with the same tag');
  removeWorkerRow('sess_peer_fallback');
  const fallbackFresh = await agent.execute({
    type: 'spawn', agent: 'worker', tag: 'fallback-peer', prompt: 'fresh after stale fallback', cwd: root,
  }, ctx);
  assert(!/^Error/.test(fallbackFresh), `fresh same-tag spawn must follow stale close fallback: ${fallbackFresh}`);
  await waitJob(fallbackFresh, /ack: fresh after stale fallback/, 'fresh after stale fallback');

  process.stdout.write(`agent tag-reuse smoke passed (asks=${askLog.length})\n`);
}

try {
  await main();
} finally {
  try { agent.closeAll('agent-tag-reuse-smoke-end'); } catch {}
  globalThis.setTimeout = nativeSetTimeout;
  rmSync(root, { recursive: true, force: true });
}
