#!/usr/bin/env node
// Lead-delegation E2E probe (manual, real provider turns).
//
// Boots the REAL Lead session runtime (the TUI/desktop runtime, delegation
// enabled) and verifies the whole agent path from a model turn:
//   Lead model turn -> agent tool spawn -> routing rules resolve the worker
//   preset -> worker turn -> completion -> owner notification -> Lead reports
//   the worker's answer -> session-scoped agent status surface.
//
// Run: node scripts/agent-lead-e2e-probe.mjs [provider model]
// Uses the real user config/credentials (copied read-only) in an isolated
// MIXDOG_DATA_DIR so the live daemon/app state is never touched.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-lead-e2e-'));
// MIXDOG_LEAD_E2E_LIVE_DAEMON=1: keep the inherited runtime root (live daemon
// discovery) and opt into agent shard spread, so the spawned worker runs on
// the INSTALLED daemon's shard pool — the deployed remote-completion path.
const LIVE_DAEMON = process.env.MIXDOG_LEAD_E2E_LIVE_DAEMON === '1';
if (LIVE_DAEMON) process.env.MIXDOG_AGENT_SHARD_SPREAD = '1';
else process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_BOOT_CORE_MEMORY = '0';
process.env.MIXDOG_DAEMON_SKIP_MEMORY = '1';
process.env.MIXDOG_FEATURE_MEMORY = '0';
process.env.MIXDOG_FEATURE_WEB_SEARCH = '0';
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const REAL_DATA_DIR = join(homedir(), '.mixdog', 'data');
for (const file of [
  'mixdog-config.json',
  'grok-oauth.json',
  'grok-oauth-models.json',
  'openai-oauth.json',
  'openai-oauth-models.json',
  'anthropic-oauth-credentials.json',
  'anthropic-oauth-models.json',
]) {
  const from = join(REAL_DATA_DIR, file);
  if (existsSync(from)) copyFileSync(from, join(DATA_DIR, file));
}
// The user's active workflow may be Solo (delegatesAgents:false), which
// correctly removes the agent tool from the Lead surface. This probe verifies
// DELEGATION, so pin the isolated config to the delegating default workflow.
{
  const configPath = join(DATA_DIR, 'mixdog-config.json');
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    // The config file nests runtime settings under the `agent` key.
    const section = config.agent && typeof config.agent === 'object' ? config.agent : config;
    section.workflow = { ...(section.workflow || {}), active: 'default' };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}
process.env.MIXDOG_DATA_DIR = DATA_DIR;

const PROVIDER = process.argv[2] || 'grok-oauth';
const MODEL = process.argv[3] || 'grok-4.3';
const WORKER_AGENT = process.env.MIXDOG_LEAD_E2E_AGENT || 'worker';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
function check(ok, label, detail = '') {
  if (!ok) failures.push(label);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} - ${label}${detail ? ` (${detail})` : ''}\n`);
}

const { createMixdogSessionRuntime } = await import('../src/session-runtime/runtime-core.mjs');
let runtime = null;
try {
  runtime = await createMixdogSessionRuntime({
    provider: PROVIDER,
    model: MODEL,
    cwd: process.cwd(),
    toolMode: 'full',
    approvalMode: 'implicit',
    disallowDelegation: false,
  });
  const notifications = [];
  runtime.onNotification?.((event) => notifications.push(event));

  const toolEvents = [];
  const askOptions = {
    onAssistantToolCallObserved: (call) => toolEvents.push({ kind: 'call', name: call?.name || call?.tool || '?' }),
    onToolResult: (message) => toolEvents.push({
      kind: 'result',
      name: message?.name || message?.tool || '?',
      preview: String(message?.content ?? message?.output ?? '').slice(0, 200),
    }),
  };
  const ask1 = await runtime.ask(
    'Delegate one task via the agent tool. If `agent` is not directly callable, first call '
    + `load_tool with names=['agent'] to activate it. Then call agent with exactly type=spawn, agent=${WORKER_AGENT} and prompt `
    + "'Read package.json in the current repo and reply with exactly the value of its name field, one word, nothing else.' "
    + 'Do NOT set provider/model/effort (routing decides). Do not use read/grep/shell yourself. '
    + 'After the spawn tool call returns, reply with exactly: SPAWNED. '
    + 'Only if activating AND calling the agent tool both fail, reply exactly: AGENT_UNAVAILABLE',
    askOptions,
  );
  const spawnReply = String(ask1?.result?.content || '');
  process.stdout.write(`turn1 tools: ${JSON.stringify(toolEvents)}\n`);
  const agentToolUsed = toolEvents.some((event) => event.name === 'agent');
  check(agentToolUsed, 'Lead model turn actually invoked the agent tool', spawnReply.slice(0, 120));

  // Poll the SAME status surface the desktop top-right button consumes.
  let sawWorkerRow = null;
  let terminalJob = null;
  let scope = null;
  const deadline = Date.now() + 120_000;
  let lastStatus = null;
  while (Date.now() < deadline && !terminalJob) {
    const status = runtime.agentStatus?.() || {};
    lastStatus = status;
    scope = status.agentScope || scope;
    const workers = status.agentWorkers || [];
    if (!sawWorkerRow && workers.length > 0) sawWorkerRow = workers[0];
    terminalJob = (status.agentJobs || []).find(
      (job) => /completed|failed|cancelled/i.test(String(job.status)),
    ) || null;
    if (!terminalJob) await sleep(300);
  }
  process.stdout.write(`final status surface: ${JSON.stringify({
    workers: lastStatus?.agentWorkers || [],
    jobs: lastStatus?.agentJobs || [],
  }).slice(0, 1_500)}\n`);
  check(Boolean(sawWorkerRow), 'worker visible on the session agent status surface',
    sawWorkerRow ? `tag=${sawWorkerRow.tag} stage=${sawWorkerRow.stage}` : 'never appeared');
  check(Boolean(terminalJob), 'agent job reached a terminal state');
  check(terminalJob?.status === 'completed', 'agent job completed without error',
    `status=${terminalJob?.status} error=${terminalJob?.error || 'none'}`);
  check(Boolean(terminalJob?.provider && terminalJob?.model), 'routing rules resolved the worker route',
    `agent=${terminalJob?.agent} route=${terminalJob?.provider}/${terminalJob?.model} preset=${terminalJob?.preset || '-'}`);
  check(scope?.sessionId === runtime.id, 'agent status surface is scoped to the owner session',
    `scope=${JSON.stringify(scope)} lead=${runtime.id}`);
  await sleep(500);
  check(notifications.length > 0, 'owner received the completion notification',
    `count=${notifications.length}`);

  // Mirror the surface's notification injection into the next Lead turn.
  const notifText = notifications.map((event) => {
    try { return typeof event === 'string' ? event : JSON.stringify(event); } catch { return String(event); }
  }).join('\n').slice(0, 4_000);
  const ask2 = await runtime.ask(
    `Agent completion notification:\n${notifText}\n\n`
    + 'Reply with exactly: WORKER_SAID=<the worker\'s one-word answer from the notification>',
    {},
  );
  const finalReply = String(ask2?.result?.content || '');
  check(/WORKER_SAID=\s*mixdog/i.test(finalReply), 'Lead surfaced the worker result',
    finalReply.slice(0, 160));

  process.stdout.write(`verdict: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.join('; ')})`}\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  try { await runtime?.stop?.('lead-e2e-probe-exit'); } catch { /* teardown */ }
  try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* temp */ }
}
process.exit(process.exitCode || 0);
