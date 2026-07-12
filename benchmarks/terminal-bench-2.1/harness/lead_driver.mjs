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
//   MIXDOG_LEAD_FALLBACK OPTIONAL JSON route used once after a Lead refusal
//   MIXDOG_WORKFLOW  OPTIONAL workflow override; unset => use configured active
//   MIXDOG_PROMPT    the task instruction

import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';

const USAGE_LOG = '/logs/agent/usage.json';
const toolCallHighWater = new Map();
let usageMirrorInFlight = false;
let usageMirrorStopped = false;
let usageMirrorTimer = null;

const finiteTokenCount = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const sessionUsageRecord = (doc, file) => {
  const models = [];
  const addModel = (candidate) => {
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    if (value && !models.includes(value)) models.push(value);
  };
  addModel(doc?.model);
  for (const message of Array.isArray(doc?.messages) ? doc.messages : []) {
    addModel(message?.model);
  }
  const messages = Array.isArray(doc?.messages) ? doc.messages : [];
  let observedToolCalls = messages.filter((message) => message?.role === 'tool').length;
  if (!observedToolCalls) {
    observedToolCalls = messages.reduce(
      (total, message) => total + (
        Array.isArray(message?.toolCalls)
          ? message.toolCalls.length
          : finiteTokenCount(message?.toolCallsTotal)
      ),
      0,
    );
  }
  const sessionId = String(doc?.id || file.slice(0, -5));
  // Retained-message high-water mark; it may undercount after context compaction.
  const toolCallCountApprox = Math.max(toolCallHighWater.get(sessionId) || 0, observedToolCalls);
  toolCallHighWater.set(sessionId, toolCallCountApprox);
  return {
    sessionId,
    agentRole: String(doc?.agent || doc?.role || (doc?.owner === 'agent' ? 'agent' : 'lead')),
    models,
    inputTokens: finiteTokenCount(doc?.totalInputTokens),
    cacheTokens: finiteTokenCount(doc?.totalCachedReadTokens),
    outputTokens: finiteTokenCount(doc?.totalOutputTokens),
    toolCallCountApprox,
  };
};

const usageDocument = (sessions) => {
  const totals = sessions.reduce(
    (sum, session) => ({
      inputTokens: sum.inputTokens + session.inputTokens,
      cacheTokens: sum.cacheTokens + session.cacheTokens,
      outputTokens: sum.outputTokens + session.outputTokens,
      toolCallCountApprox: sum.toolCallCountApprox + session.toolCallCountApprox,
    }),
    { inputTokens: 0, cacheTokens: 0, outputTokens: 0, toolCallCountApprox: 0 },
  );
  return { schemaVersion: 1, sessions, totals };
};

// Synchronous I/O is reserved for explicit/final snapshots, where the write
// must complete before process.exit().
const mirrorUsageSync = () => {
  let tmp = '';
  try {
    const sessionsDir = (process.env.MIXDOG_DATA_DIR || '') + '/sessions';
    const sessions = [];
    for (const file of readdirSync(sessionsDir).filter((name) => name.endsWith('.json')).sort()) {
      try {
        const doc = JSON.parse(readFileSync(sessionsDir + '/' + file, 'utf8'));
        sessions.push(sessionUsageRecord(doc, file));
      } catch { /* partial/corrupt session write: skip until the next snapshot */ }
    }
    mkdirSync(dirname(USAGE_LOG), { recursive: true });
    tmp = `${USAGE_LOG}.tmp-${process.pid}-sync`;
    writeFileSync(tmp, JSON.stringify(usageDocument(sessions), null, 2) + '\n');
    renameSync(tmp, USAGE_LOG);
  } catch {
    if (tmp) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
  }
};

// Periodic snapshots stay off the driver event loop. A slow snapshot is simply
// skipped on the next tick rather than overlapping reads/writes.
const mirrorUsageAsync = async () => {
  if (usageMirrorStopped || usageMirrorInFlight) return;
  usageMirrorInFlight = true;
  let tmp = '';
  try {
    const sessionsDir = (process.env.MIXDOG_DATA_DIR || '') + '/sessions';
    const files = (await readdir(sessionsDir)).filter((name) => name.endsWith('.json')).sort();
    const sessions = [];
    for (const file of files) {
      try {
        const doc = JSON.parse(await readFile(sessionsDir + '/' + file, 'utf8'));
        sessions.push(sessionUsageRecord(doc, file));
      } catch { /* partial/corrupt session write: skip until the next snapshot */ }
    }
    await mkdir(dirname(USAGE_LOG), { recursive: true });
    tmp = `${USAGE_LOG}.tmp-${process.pid}-async`;
    await writeFile(tmp, JSON.stringify(usageDocument(sessions), null, 2) + '\n');
    if (usageMirrorStopped) {
      await unlink(tmp).catch(() => {});
      return;
    }
    // An already-issued rename may still land after the final sync write; that
    // accepted race yields only a valid snapshot at most one interval stale.
    await rename(tmp, USAGE_LOG);
  } catch {
    if (tmp) {
      try { await unlink(tmp); } catch { /* best-effort cleanup */ }
    }
  } finally {
    usageMirrorInFlight = false;
  }
};

// Test/diagnostic entry point avoids booting the installed runtime.
if (process.env.MIXDOG_USAGE_SUMMARY_ONLY === '1') {
  mirrorUsageSync();
  process.exit(0);
}

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
const parseFallbackRoute = (raw) => {
  if (!raw) return null;
  try {
    const route = JSON.parse(raw);
    if (
      !route
      || typeof route !== 'object'
      || Array.isArray(route)
      || Object.keys(route).sort().join(',') !== 'effort,fast,model,provider'
      || typeof route.provider !== 'string'
      || !route.provider.trim()
      || typeof route.model !== 'string'
      || !route.model.trim()
      || !['low', 'medium', 'high', 'xhigh', 'max'].includes(route.effort)
      || typeof route.fast !== 'boolean'
    ) return null;
    return route;
  } catch {
    return null;
  }
};
const fallbackRoute = parseFallbackRoute(process.env.MIXDOG_LEAD_FALLBACK);
// Refusal restart policy: if the primary Lead session terminates on an
// API-level refusal, relaunch one full Lead session on the configured fallback
// route. Without a valid fallback, or if that session also refuses, exit 86 so
// Harbor retries the task as a fresh trial with a full task budget.
// Driver loop deadline. Only a runaway-loop guard: the REAL per-task time
// limit is enforced by Harbor (AgentTimeoutError), so this can sit far above
// every task budget. The old fixed 30min cut long tasks (caffe-cifar-10)
// while their heavy-worker was still training.
const DEADLINE_MS = Number(process.env.MIXDOG_DRIVER_DEADLINE_MS ?? 180 * 60_000);
// One deadline owns the complete trial, including runtime creation, boot
// jitter, and the initial turn.
const RUN_DEADLINE = DEADLINE_MS >= 0 ? Date.now() + DEADLINE_MS : -1;
const assertRunDeadline = (stage) => {
  if (RUN_DEADLINE >= 0 && Date.now() >= RUN_DEADLINE) {
    throw new Error(`lead_driver: run deadline exceeded before ${stage}`);
  }
};
// Boot jitter: N concurrent trials all fire their FIRST ask in the same
// second, which bursts the provider into 429/retry loops (observed: trials
// dying at AgentTimeout with only boot noise logged). Spread the first ask.
const BOOT_JITTER_MS = Number(process.env.MIXDOG_BOOT_JITTER_MS ?? 30_000);
// Stall watchdog: if a turn shows NO progress signal (stream/tool activity)
// for STALL_MS, abort that turn and retry it in the SAME session instead of
// burning the whole Harbor budget inside a hung request.
const STALL_MS = Number(process.env.MIXDOG_STALL_MS || 6 * 60_000);
const MAX_STALL_RETRIES = Number(process.env.MIXDOG_STALL_RETRIES || 2);
usageMirrorTimer = setInterval(() => { void mirrorUsageAsync(); }, 30_000);
usageMirrorTimer.unref?.();
void mirrorUsageAsync();

// Refusal detection: the session manager logs
// "[session] empty-final persisted sessionId=<sid> ... stopReason=refusal" to
// stderr when a session terminates on an API-level refusal. The runtime does
// not surface stopReason through ask(), so retain the terminated session IDs
// from the in-process stderr stream and match the returned lead session.
const refusalSessionIds = new Set();
const _origErrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, enc, cb) => {
  try {
    for (const match of String(chunk).matchAll(/\[session\] empty-final persisted sessionId=([^\s]+).*stopReason=refusal/g)) {
      refusalSessionIds.add(match[1]);
    }
  } catch { /* detector only */ }
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
  assertRunDeadline('primary session');
  let rt = null;
  let stallTimer = null;
  let lifecycleCompleted = false;
  try {
    rt = await createMixdogSessionRuntime({ provider: route.provider, model: route.model });
    if (workflow) {
      assertRunDeadline('workflow setup');
      await rt.setWorkflow(normalizeWorkflowId(workflow));
    }
    if (route.effort) {
      assertRunDeadline('effort setup');
      await rt.setEffort(route.effort);
    }
    if (route.fast !== undefined) {
      assertRunDeadline('fast-mode setup');
      await rt.setFast(route.fast);
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
  stallTimer = setInterval(() => {
    if (!busy || STALL_MS <= 0) return;
    if (Date.now() - lastProgressAt <= STALL_MS) return;
    stallAborted = true;
    lastProgressAt = Date.now();
    process.stderr.write(`lead_driver: stall watchdog abort (no progress ${STALL_MS}ms)\n`);
    try { rt.abort?.('driver-stall'); } catch { /* abort is best-effort */ }
  }, 15_000);
  stallTimer.unref?.();

  const askOnce = async (msg) => {
    assertRunDeadline('model ask');
    busy = true;
    lastProgressAt = Date.now();
    const touch = () => { lastProgressAt = Date.now(); };
    let deadlineAborted = false;
    let askDeadlineTimer = null;
    try {
      let t = '';
      const askPromise = rt.ask(msg, {
        onTextDelta: (c) => { t += c; touch(); },
        onReasoningDelta: touch,
        onStreamDelta: touch,
        onToolCall: touch,
        onToolResult: touch,
      });
      const resultPromise = RUN_DEADLINE < 0
        ? askPromise
        : Promise.race([
            askPromise,
            new Promise((_, reject) => {
              askDeadlineTimer = setTimeout(() => {
                deadlineAborted = true;
                const error = new Error(
                  `lead_driver: run deadline exceeded during model ask after ${DEADLINE_MS}ms`,
                );
                reject(error);
                try { rt.abort?.('driver-deadline'); } catch { /* best-effort */ }
              }, Math.max(0, RUN_DEADLINE - Date.now()));
            }),
          ]);
      const { result } = await resultPromise;
      const finalText = String(result?.text ?? '');
      const resolvedSid = rt.sessionId || rt.session?.id || '';
      if (resolvedSid && finalText.trim()) refusalSessionIds.delete(resolvedSid);
      return String(result?.text ?? t ?? '');
    } catch (err) {
      if (deadlineAborted) {
        throw new Error(
          `lead_driver: run deadline exceeded during model ask after ${DEADLINE_MS}ms`,
          { cause: err },
        );
      }
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
    } finally {
      if (askDeadlineTimer) clearTimeout(askDeadlineTimer);
      busy = false;
    }
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
  while (RUN_DEADLINE >= 0 && Date.now() < RUN_DEADLINE) {
    if (!kickDeferred) {
      for (;;) {
        const kicked = await new Promise((r) => {
          wake = () => r(true);
          const waitMs = RUN_DEADLINE < 0
            ? 10_000
            : Math.max(0, Math.min(10_000, RUN_DEADLINE - Date.now()));
          setTimeout(() => r(false), waitMs);
        });
        wake = null;
        if (kicked || kickDeferred) break;
        if (!anyWorkBusy()) break;
        if (Date.now() >= RUN_DEADLINE) break;
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
    lifecycleCompleted = true;
    return { text, sid };
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    if (rt) {
      if (!lifecycleCompleted) {
        try { rt.abort?.('bench-lifecycle-error'); } catch { /* best-effort */ }
      }
      try {
        await rt.close('bench-exit');
      } catch (closeError) {
        if (lifecycleCompleted) throw closeError;
        process.stderr.write(
          `lead_driver: runtime close after failure also failed: ${closeError?.message || closeError}\n`,
        );
      }
    }
  }
};

const sids = [];
let { text, sid } = await driveSession({ provider, model, effort });
sids.push(sid);

// Restart only when the PRIMARY lead session's ID has an API-level refusal
// marker. A sub-agent refusal has a different session ID and does not restart
// an otherwise-completed Lead run.
const refusalGateHit = refusalSessionIds.has(sid);
process.stdout.write(`refusal-gate: sid=${sid} refused=${refusalGateHit}\n`);
if (refusalGateHit) {
  process.stdout.write(`refusal-restart: lead session terminated on refusal (sess=${sid}); exiting 86 so Harbor retries a fresh trial\n`);
  if (!fallbackRoute) process.exit(86);

  process.stdout.write(
    `refusal-fallback: relaunching lead on ${fallbackRoute.provider}/${fallbackRoute.model} effort=${fallbackRoute.effort}\n`,
  );
  try {
    ({ text, sid } = await driveSession(fallbackRoute));
  } catch (error) {
    process.stderr.write(
      `lead_driver: refusal fallback failed; exiting 86: ${error?.message || error}\n`,
    );
    process.exit(86);
  }
  sids.push(sid);
  const fallbackRefusalGateHit = refusalSessionIds.has(sid);
  process.stdout.write(`refusal-gate: sid=${sid} refused=${fallbackRefusalGateHit}\n`);
  if (fallbackRefusalGateHit) {
    process.stdout.write(`refusal-restart: lead session terminated on refusal (sess=${sid}); exiting 86 so Harbor retries a fresh trial\n`);
    process.exit(86);
  }
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
usageMirrorStopped = true;
if (usageMirrorTimer) clearInterval(usageMirrorTimer);
mirrorUsageSync();
process.exit(0);
