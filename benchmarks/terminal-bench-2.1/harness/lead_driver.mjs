// Full Lead session driver for the Harbor mixdog adapter.
//
// Mirrors scripts/bench-run.mjs:60-145 (the `lead` runner): drives the real
// createMixdogSessionRuntime().ask() path — workflow routing + agent-tool
// fan-out — and reproduces the TUI auto-resume loop (empty pending-resume
// asks on each runtime notification kick; settle when the agent board is
// clear and no kick arrived during the last turn).
//
// Runs INSIDE the task container against the globally-installed package.
// Inputs arrive via env (so the task instruction never needs shell quoting):
//   MIXDOG_SRC       absolute path to <npm root -g>/mixdog/src
//   MIXDOG_PROVIDER  OPTIONAL provider override; unset => use configured route
//   MIXDOG_MODEL     OPTIONAL model override; unset => use configured route
//   MIXDOG_EFFORT    OPTIONAL effort override (low/medium/high/xhigh)
//   MIXDOG_WORKFLOW  OPTIONAL workflow override; unset => use configured active
//   MIXDOG_PROMPT    the task instruction
//   MIXDOG_REFUSAL_FALLBACK_MODEL     OPTIONAL fallback model when the primary
//                                     lead REFUSES at the API level (default
//                                     claude-opus-4-8; set empty to disable)
//   MIXDOG_REFUSAL_FALLBACK_PROVIDER  OPTIONAL fallback provider (default
//                                     anthropic-oauth)
//   MIXDOG_REFUSAL_FALLBACK_EFFORT    OPTIONAL fallback effort (default xhigh)

import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';

const SRC = process.env.MIXDOG_SRC;
if (!SRC) {
  process.stderr.write('lead_driver: MIXDOG_SRC not set\n');
  process.exit(2);
}
const modUrl = (rel) => pathToFileURL(SRC.replace(/[\\/]+$/, '') + '/' + rel).href;

const { createMixdogSessionRuntime } = await import(modUrl('mixdog-session-runtime.mjs'));
const { normalizeWorkflowId } = await import(modUrl('session-runtime/workflow.mjs'));

// Only override when explicitly provided. With both unset,
// createMixdogSessionRuntime() resolves the user's configured default route
// (workflowRoutes.lead / default preset) and active workflow + sub-agent
// routing from the copied mixdog-config.json.
const provider = process.env.MIXDOG_PROVIDER || undefined;
const model = process.env.MIXDOG_MODEL || undefined;
const effort = process.env.MIXDOG_EFFORT || '';
const workflow = process.env.MIXDOG_WORKFLOW || '';
const prompt = process.env.MIXDOG_PROMPT || '';
// Refusal fallback policy: a guardrail false-positive refusal (stopReason=
// refusal, zero tool calls) is retried once on an alternate configured route.
// This is a documented harness policy, not per-task tampering: the prompt and
// task are unchanged; only the model route differs.
const FB_MODEL = process.env.MIXDOG_REFUSAL_FALLBACK_MODEL !== undefined
  ? process.env.MIXDOG_REFUSAL_FALLBACK_MODEL
  : 'claude-opus-4-8';
const FB_PROVIDER = process.env.MIXDOG_REFUSAL_FALLBACK_PROVIDER || 'anthropic-oauth';
const FB_EFFORT = process.env.MIXDOG_REFUSAL_FALLBACK_EFFORT || 'xhigh';
// Driver loop deadline. Only a runaway-loop guard: the REAL per-task time
// limit is enforced by Harbor (AgentTimeoutError), so this can sit far above
// every task budget. The old fixed 30min cut long tasks (caffe-cifar-10)
// while their heavy-worker was still training.
const DEADLINE_MS = Number(process.env.MIXDOG_DRIVER_DEADLINE_MS || 180 * 60_000);
// Boot jitter: N concurrent trials all fire their FIRST ask in the same
// second, which bursts the provider into 429/retry loops (observed: trials
// dying at AgentTimeout with only boot noise logged). Spread the first ask.
const BOOT_JITTER_MS = Number(process.env.MIXDOG_BOOT_JITTER_MS ?? 30_000);
// Stall watchdog: if a turn shows NO progress signal (stream/tool activity)
// for STALL_MS, abort that turn and retry it in the SAME session instead of
// burning the whole Harbor budget inside a hung request.
const STALL_MS = Number(process.env.MIXDOG_STALL_MS || 6 * 60_000);
const MAX_STALL_RETRIES = Number(process.env.MIXDOG_STALL_RETRIES || 2);

// Refusal detection: the session manager logs
// "[session] empty-final persisted ... stopReason=refusal" to stderr when the
// LEAD session terminates on an API-level refusal (no tool calls, empty
// final). The runtime does not surface stopReason through ask(), so tap the
// in-process stderr stream for the marker.
let refusalSeen = false;
const _origErrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, enc, cb) => {
  try { if (String(chunk).includes('stopReason=refusal')) refusalSeen = true; } catch { /* detector only */ }
  return _origErrWrite(chunk, enc, cb);
};

// Background shell tasks (task tool) are NOT on the agent board, but the Lead
// often parks long builds/downloads there and expects to resume on completion.
// Treat a live running shell job as busy so we don't settle early. A job only
// counts when its recorded pid is still alive (guards against stale detail
// files from a previous killed run).
const shellJobsBusy = () => {
  try {
    const dir = (process.env.MIXDOG_DATA_DIR || '') + '/shell-jobs';
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(readFileSync(dir + '/' + f, 'utf8'));
        if (String(d?.status || '') !== 'running') continue;
        const pid = Number(d?.pid);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        try { process.kill(pid, 0); return true; } catch { /* dead pid: stale */ }
      } catch { /* unreadable detail file: ignore */ }
    }
  } catch { /* no shell-jobs dir yet */ }
  return false;
};

// Drive one full Lead session (create runtime -> auto-resume loop -> close).
// Mirrors the TUI auto-resume (engine/agent-job-feed.mjs): a runtime
// notification enqueues the model-visible completion into the session's
// pending queue; we then kick an EMPTY pending-resume ask via queueMicrotask
// (the pre-send drain pulls the pending messages). No polling / synthetic
// 'continue' / verdict heuristic: resume per kick, finish when no kick
// arrived during the last turn and the agent board is clear.
const driveSession = async (route) => {
  const rt = await createMixdogSessionRuntime({ provider: route.provider, model: route.model });
  if (workflow) {
    await rt.setWorkflow(normalizeWorkflowId(workflow));
  }
  if (route.effort) {
    await rt.setEffort(route.effort);
  }

  let text = '';
  let busy = false;
  let kickDeferred = false;
  let wake = null;
  let lastProgressAt = Date.now();
  let stallAborted = false;
  let stallRetries = 0;

  rt.onNotification(() => {
    queueMicrotask(() => {
      if (busy) { kickDeferred = true; return; }
      kickDeferred = true;
      if (wake) wake();
    });
    return false;
  });

  // Watchdog: abort the CURRENT turn when no progress arrived for STALL_MS.
  // askOnce() catches the abort and retries the same message (bounded).
  const stallTimer = setInterval(() => {
    if (!busy || STALL_MS <= 0) return;
    if (Date.now() - lastProgressAt <= STALL_MS) return;
    stallAborted = true;
    lastProgressAt = Date.now();
    process.stderr.write(`lead_driver: stall watchdog abort (no progress ${STALL_MS}ms)\n`);
    try { rt.abort?.('driver-stall'); } catch { /* abort is best-effort */ }
  }, 15_000);
  stallTimer.unref?.();

  const askOnce = async (msg) => {
    busy = true;
    lastProgressAt = Date.now();
    const touch = () => { lastProgressAt = Date.now(); };
    try {
      let t = '';
      const { result } = await rt.ask(msg, {
        onTextDelta: (c) => { t += c; touch(); },
        onReasoningDelta: touch,
        onStreamDelta: touch,
        onToolCall: touch,
        onToolResult: touch,
      });
      return String(result?.text ?? t ?? '');
    } catch (err) {
      // Stall-abort recovery: retry the SAME message in the same session; the
      // transcript keeps prior turns, so a retry resumes rather than restarts.
      if (stallAborted && stallRetries < MAX_STALL_RETRIES) {
        stallAborted = false;
        stallRetries += 1;
        busy = false;
        process.stderr.write(`lead_driver: retrying stalled turn (${stallRetries}/${MAX_STALL_RETRIES})\n`);
        return await askOnce(msg);
      }
      throw err;
    } finally { busy = false; }
  };

  const agentsBusy = () => {
    try {
      const st = rt.agentStatus?.() || {};
      const jobs = Array.isArray(st.agentJobs) ? st.agentJobs : [];
      return jobs.some((j) => /running|pending|spawn|queued/i.test(String(j?.status || j?.state || '')));
    } catch { return false; }
  };

  const anyWorkBusy = () => agentsBusy() || shellJobsBusy();

  if (BOOT_JITTER_MS > 0) {
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * BOOT_JITTER_MS)));
  }
  text = await askOnce(prompt);
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (!kickDeferred) {
      for (;;) {
        const kicked = await new Promise((r) => {
          wake = () => r(true);
          setTimeout(() => r(false), 10_000);
        });
        wake = null;
        if (kicked || kickDeferred) break;
        if (!anyWorkBusy()) break;
        if (Date.now() >= deadline) break;
      }
      if (!kickDeferred && !anyWorkBusy()) break;
    }
    kickDeferred = false;
    const t = await askOnce('');
    if (String(t || '').trim()) text = t;
  }

  const sid = rt.sessionId || rt.session?.id || '';
  // Delegation audit: the agent tool logs nothing to stderr, so dump the
  // worker index + agent board + session inventory before close. This is the
  // only host-visible evidence of whether the Lead delegated (agent-workers
  // rows / non-lead sessions) once the container is discarded.
  try {
    const dd = process.env.MIXDOG_DATA_DIR || '';
    let idx = '';
    try { idx = readFileSync(dd + '/agent-workers.json', 'utf8').trim(); } catch { idx = '<none>'; }
    process.stdout.write('delegation-audit agent-workers.json: ' + idx + '\n');
    let jobs = [];
    try { jobs = rt.agentStatus?.()?.agentJobs || []; } catch { /* best-effort */ }
    process.stdout.write('delegation-audit agent-board: ' + JSON.stringify(jobs) + '\n');
    let sess = [];
    try { sess = readdirSync(dd + '/sessions').filter((f) => f.endsWith('.json')); } catch { /* none */ }
    process.stdout.write('delegation-audit sessions(' + sess.length + '): ' + sess.join(',') + '\n');
    // Lead tool surface: prove whether the `agent` tool was model-visible.
    let toolNames = [];
    try {
      const sfile = dd + '/sessions/' + (rt.sessionId || rt.session?.id || '') + '.json';
      const sdoc = JSON.parse(readFileSync(sfile, 'utf8'));
      toolNames = (sdoc?.tools || rt.session?.tools || []).map((t) => t?.name || t).filter(Boolean);
    } catch { /* fall through */ }
    if (!toolNames.length) {
      try { toolNames = (rt.session?.tools || []).map((t) => t?.name || t).filter(Boolean); } catch { /* none */ }
    }
    process.stdout.write('delegation-audit lead-tools(' + toolNames.length + '): ' + toolNames.join(',') + '\n');
  } catch (e) {
    process.stdout.write('delegation-audit failed: ' + (e?.message || e) + '\n');
  }
  clearInterval(stallTimer);
  await rt.close('bench-exit');
  return { text, sid };
};

const sids = [];
let { text, sid } = await driveSession({ provider, model, effort });
sids.push(sid);

// Guardrail false-positive fallback: only when the PRIMARY lead refused at
// the API level AND produced no usable output (refusal marker + empty final
// text). A sub-agent refusal inside an otherwise-completed run does not
// trigger a rerun. Skipped when the fallback route is the primary route or
// explicitly disabled (MIXDOG_REFUSAL_FALLBACK_MODEL=).
if (refusalSeen && !String(text || '').trim() && FB_MODEL && FB_MODEL !== model) {
  process.stdout.write(`refusal-fallback: primary route refused (sess=${sid}); retrying with ${FB_PROVIDER}/${FB_MODEL} effort=${FB_EFFORT}\n`);
  refusalSeen = false;
  const retry = await driveSession({ provider: FB_PROVIDER, model: FB_MODEL, effort: FB_EFFORT });
  text = retry.text;
  sid = retry.sid;
  sids.push(retry.sid);
}

// Sanity: extract the model(s) the runtime actually used from the session
// transcript so the trial log proves the CONFIGURED route applied (lead =
// anthropic-oauth/claude-fable-5) rather than any -m override.
try {
  const models = [];
  for (const s of sids) {
    const sfile = (process.env.MIXDOG_DATA_DIR || '') + '/sessions/' + s + '.json';
    const raw = readFileSync(sfile, 'utf8');
    for (const m of raw.matchAll(/"model"\s*:\s*"([^"]+)"/g)) {
      if (!models.includes(m[1])) models.push(m[1]);
    }
  }
  process.stdout.write('models: ' + JSON.stringify(models) + '\n');
} catch (e) {
  process.stdout.write('models: <unavailable> ' + (e?.message || e) + '\n');
}
process.stdout.write('sessionId: ' + sid + '\n');
process.stdout.write(text + '\n');
process.exit(0);
