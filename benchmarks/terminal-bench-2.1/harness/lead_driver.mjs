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

  rt.onNotification(() => {
    queueMicrotask(() => {
      if (busy) { kickDeferred = true; return; }
      kickDeferred = true;
      if (wake) wake();
    });
    return false;
  });

  const askOnce = async (msg) => {
    busy = true;
    try {
      let t = '';
      const { result } = await rt.ask(msg, { onTextDelta: (c) => { t += c; } });
      return String(result?.text ?? t ?? '');
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

  text = await askOnce(prompt);
  const deadline = Date.now() + 30 * 60_000;
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
