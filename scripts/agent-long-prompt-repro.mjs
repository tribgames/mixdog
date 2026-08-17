#!/usr/bin/env node
// Repro: worker spawn with a LONG prompt (> 800B attachment-externalization
// threshold) through the shard-spread daemon path. Isolated daemon/root.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-longprompt-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_DAEMON_SKIP_MEMORY = '1';
process.env.MIXDOG_BOOT_CORE_MEMORY = '0';
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_AGENT_SHARD_SPREAD = '1';
const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const REAL = join(homedir(), '.mixdog', 'data');
for (const file of ['mixdog-config.json', 'grok-oauth.json', 'grok-oauth-models.json']) {
  const from = join(REAL, file);
  if (existsSync(from)) copyFileSync(from, join(DATA_DIR, file));
}
process.env.MIXDOG_DATA_DIR = DATA_DIR;

const cfgMod = await import('../src/runtime/agent/orchestrator/config.mjs');
const reg = await import('../src/runtime/agent/orchestrator/providers/registry.mjs');
const mgr = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
const { createStandaloneAgent } = await import('../src/standalone/agent-tool.mjs');
const { ensureDaemon, shutdownDaemon } = await import('../src/standalone/session-client.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let agent = null;
let daemonDiscovery = null;
try {
  daemonDiscovery = await ensureDaemon({ cwd: REPO, log: () => {} });
  agent = createStandaloneAgent({ cfgMod, reg, mgr, dataDir: DATA_DIR, cwd: REPO });
  // Padding pushes the prompt over TEXT_REFERENCE_THRESHOLD_BYTES (800).
  const padding = 'Background context (ignore, filler): ' + 'lorem ipsum dolor sit amet. '.repeat(40);
  const prompt = `${padding}\nActual task: read package.json in the current repo and reply with exactly the value of its "name" field, one word, nothing else.`;
  process.stdout.write(`prompt bytes: ${Buffer.byteLength(prompt, 'utf8')}\n`);
  const out = await agent.execute({
    type: 'spawn', agent: 'worker', provider: 'grok-oauth', model: 'grok-4.3', effort: 'low',
    tag: 'longprompt-w0', cwd: REPO, prompt,
  }, { invocationSource: 'model-tool', cwd: REPO });
  const taskId = String(out).match(/agent task: (\S+)/)?.[1];
  if (!taskId) throw new Error(`spawn did not return a task id: ${String(out).slice(0, 300)}`);
  process.stdout.write(`spawned: ${taskId}\n`);
  let last = '';
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    last = await agent.execute({ type: 'read', task_id: taskId }, { invocationSource: 'model-tool', cwd: REPO });
    if (/status: (completed|failed|error|cancelled)/.test(last)) break;
    await sleep(500);
  }
  process.stdout.write(`${last.slice(0, 900)}\n`);
  const ok = /status: completed/.test(last) && /mixdog/i.test(last);
  process.stdout.write(`verdict: ${ok ? 'PASS' : 'FAIL'}\n`);
  if (!ok) {
    // Autopsy: shard-side turn timing + persisted worker session shape.
    const { readFileSync, readdirSync } = await import('node:fs');
    try {
      const log = readFileSync(join(DATA_DIR, 'daemon.log'), 'utf8').trim().split(/\r?\n/);
      for (const line of log.slice(-30)) process.stdout.write(`[daemon.log] ${line}\n`);
    } catch (error) { process.stdout.write(`daemon.log read failed: ${error?.message}\n`); }
    try {
      const dir = join(DATA_DIR, 'sessions');
      for (const file of readdirSync(dir)) {
        if (!file.startsWith('sess_daemon')) continue;
        const x = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        const s = x.session || x;
        process.stdout.write(`[worker-session] ${file} msgs=${(s.messages || []).length} roles=${(s.messages || []).map((m) => m.role).join(',')}\n`);
      }
    } catch (error) { process.stdout.write(`session dump failed: ${error?.message}\n`); }
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  try { agent?.closeAll('longprompt-end'); } catch {}
  try { await shutdownDaemon(daemonDiscovery); } catch {}
  await sleep(300);
  try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
process.exit(process.exitCode || 0);
