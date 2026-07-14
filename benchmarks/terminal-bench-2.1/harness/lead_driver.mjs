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

import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
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
const BRIEF_AUDIT_LOG = process.env.MIXDOG_BRIEF_AUDIT_LOG || '/logs/agent/brief-audit.json';
const BRIEF_AUDIT_SCHEMA_VERSION = 1;
const BRIEF_ISSUE_CODES = Object.freeze([
  'task_omission',
  'verify_prescription',
  'legacy_role_lineage',
  'cross_role_task_reuse',
]);
const AGENT_ROLE_ALIASES = new Map([
  ['explorer', 'explore'],
  ['explore', 'explore'],
  ['maint', 'maintainer'],
  ['maintenance', 'maintainer'],
  ['memory', 'maintainer'],
  ['maintainer', 'maintainer'],
  ['worker', 'worker'],
  ['heavy', 'heavy-worker'],
  ['heavyworker', 'heavy-worker'],
  ['heavy-worker', 'heavy-worker'],
  ['review', 'reviewer'],
  ['reviewer', 'reviewer'],
  ['debug', 'debugger'],
  ['debugger', 'debugger'],
  ['web', 'web-researcher'],
  ['web-researcher', 'web-researcher'],
]);
const LEGACY_ROLE_TOKEN = '(?:lead|worker|heavy[- ]?worker|debug(?:ger)?|review(?:er)?|explor(?:e|er)|maint(?:ainer|enance)?|web(?:-researcher)?)';
const LEGACY_ROLE_LINEAGE_RE = new RegExp(
  `\\b${LEGACY_ROLE_TOKEN}\\b\\s*(?:→|->|=>|/|>)\\s*\\b${LEGACY_ROLE_TOKEN}\\b`,
  'i',
);
const toolCallHighWater = new Map();
let usageMirrorInFlight = false;
let usageMirrorStopped = false;
let usageMirrorTimer = null;

const briefText = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const briefHash = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');
const canonicalAgentRole = (value) => {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return AGENT_ROLE_ALIASES.get(key) || key;
};
const taskField = (value) => {
  const match = briefText(value).match(/(?:^|\n)Task:[ \t]*([^\n]*)(?:\n|$)/);
  return match && match[1].trim() ? match[1].trim() : '';
};
const hasVerifyField = (value) => /(?:^|\n)Verify:[^\n]*(?:\n|$)/.test(briefText(value));
const hasLegacyRoleLineage = (value) => LEGACY_ROLE_LINEAGE_RE.test(briefText(value));
const toolArguments = (call) => {
  const value = call?.input ?? call?.arguments;
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};
const resolveSpawnBrief = (args, callerCwd) => {
  // Keep this aligned with agent-tool resolvePrompt(): prompt wins over
  // message before trimming, while file contents remain byte-for-byte text.
  const prompt = String(args.prompt || args.message || '').trim();
  const file = String(args.file || '').trim();
  if (prompt && file) return null;
  if (prompt) return prompt;
  if (!file) return null;
  const baseCwd = resolve(String(callerCwd || '').trim() || process.cwd());
  const workerCwd = String(args.cwd || '').trim()
    ? resolve(baseCwd, String(args.cwd).trim())
    : baseCwd;
  return readFileSync(resolve(workerCwd, file), 'utf8');
};
const briefAuditCalls = [];
const captureBriefAuditCalls = (calls, callerCwd) => {
  for (const call of calls || []) {
    try {
      if (call?.name !== 'agent') continue;
      const args = toolArguments(call);
      if (String(args.type || 'spawn') !== 'spawn') continue;
      const callPrompt = resolveSpawnBrief(args, callerCwd);
      // Invalid, missing, and unreadable brief inputs never become worker
      // briefs; agent-tool will report those tool errors separately.
      if (callPrompt === null) continue;
      const task = taskField(callPrompt);
      const hasVerify = hasVerifyField(callPrompt);
      const issues = [];
      if (!task) issues.push('task_omission');
      if (hasVerify) issues.push('verify_prescription');
      if (hasLegacyRoleLineage(callPrompt)) issues.push('legacy_role_lineage');
      // Retain hashes and structural facts only. The runtime brief itself is
      // deliberately discarded before onToolCall returns.
      briefAuditCalls.push({
        role: canonicalAgentRole(args.agent),
        tag: String(args.tag || ''),
        callPromptSha256: briefHash(callPrompt),
        taskSha256: task ? briefHash(task) : null,
        hasTask: Boolean(task),
        hasVerify,
        issues,
      });
    } catch { /* brief auditing never changes trial execution */ }
  }
};

const briefAuditDocument = () => {
  const records = briefAuditCalls.map((record) => ({
    ...record,
    issues: [...record.issues],
  }));
  const rolesByTask = new Map();
  for (const record of records) {
    if (!record.taskSha256) continue;
    if (!rolesByTask.has(record.taskSha256)) rolesByTask.set(record.taskSha256, new Set());
    rolesByTask.get(record.taskSha256).add(record.role);
  }
  for (const record of records) {
    if (record.taskSha256 && rolesByTask.get(record.taskSha256)?.size > 1) {
      record.issues.push('cross_role_task_reuse');
    }
    record.issues.sort((a, b) => BRIEF_ISSUE_CODES.indexOf(a) - BRIEF_ISSUE_CODES.indexOf(b));
  }

  const issueCounts = Object.fromEntries(BRIEF_ISSUE_CODES.map((code) => [code, 0]));
  for (const record of records) {
    for (const code of record.issues) issueCounts[code] += 1;
  }
  return {
    schemaVersion: BRIEF_AUDIT_SCHEMA_VERSION,
    leadAgentCallCount: records.length,
    findingCount: Object.values(issueCounts).reduce((sum, count) => sum + count, 0),
    issueCounts,
    calls: records,
  };
};

const writeBriefAudit = () => {
  try {
    const audit = briefAuditDocument();
    mkdirSync(dirname(BRIEF_AUDIT_LOG), { recursive: true });
    const tmp = `${BRIEF_AUDIT_LOG}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(audit, null, 2) + '\n');
    renameSync(tmp, BRIEF_AUDIT_LOG);
    process.stdout.write(
      `brief-audit v${audit.schemaVersion} calls=${audit.leadAgentCallCount} findings=${audit.findingCount} `
      + BRIEF_ISSUE_CODES.map((code) => `${code}=${audit.issueCounts[code]}`).join(' ')
      + '\n',
    );
  } catch (error) {
    process.stdout.write(`brief-audit unavailable: ${error?.message || error}\n`);
  }
};

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
const contextUtilsUrl = process.env.MIXDOG_CONTEXT_UTILS_URL
  || modUrl('runtime/agent/orchestrator/session/context-utils.mjs');
const { estimateTokens } = await import(contextUtilsUrl);

// Only override when explicitly provided. With both unset,
// createMixdogSessionRuntime() resolves the user's configured default route
// (workflowRoutes.lead / default preset) and active workflow + sub-agent
// routing from the copied mixdog-config.json.
const provider = process.env.MIXDOG_PROVIDER || undefined;
const model = process.env.MIXDOG_MODEL || undefined;
const effort = process.env.MIXDOG_EFFORT || '';
const fast = process.env.MIXDOG_FAST === undefined
  ? undefined
  : process.env.MIXDOG_FAST === '1';
const workflow = process.env.MIXDOG_WORKFLOW || '';
const prompt = process.env.MIXDOG_PROMPT || '';
// Refusal-equivalent outcomes always leave this process with the Harbor retry
// code. The adapter, not this driver, selects the fallback on the next fresh
// trial attempt.
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
const STALL_POLL_MS = Number(process.env.MIXDOG_STALL_POLL_MS || 15_000);
const CLOSE_GRACE_MS = Number(
  process.env.MIXDOG_CLOSE_GRACE_MS
  ?? process.env.MIXDOG_STALL_CLOSE_GRACE_MS
  ?? 1_000,
);
usageMirrorTimer = setInterval(() => { void mirrorUsageAsync(); }, 30_000);
usageMirrorTimer.unref?.();
void mirrorUsageAsync();

// Refusal detection: the session manager logs
// "[session] empty-final persisted sessionId=<sid> ... stopReason=refusal" to
// stderr when a session terminates on an API-level refusal. The runtime does
// not surface stopReason through ask(), so retain the terminated session IDs
// from the in-process stderr stream and match the returned lead session.
const refusalSessionIds = new Set();
class RefusalEquivalentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefusalEquivalentError';
  }
}
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
  let rejectStalledAsk = null;

  rt.onNotification(() => {
    queueMicrotask(() => {
      if (busy) { kickDeferred = true; return; }
      kickDeferred = true;
      if (wake) wake();
    });
    return false;
  });

  // A driver-level stall invalidates this attempt. Harbor must recreate the
  // trial so fallback gets a fresh runtime and full task budget.
  stallTimer = setInterval(() => {
    if (!busy || STALL_MS <= 0) return;
    if (Date.now() - lastProgressAt <= STALL_MS) return;
    stallAborted = true;
    lastProgressAt = Date.now();
    process.stderr.write(`lead_driver: stall watchdog abort (no progress ${STALL_MS}ms)\n`);
    rejectStalledAsk?.(new RefusalEquivalentError(
      `lead_driver: stalled turn is refusal-equivalent (no progress ${STALL_MS}ms)`,
    ));
    try { rt.abort?.('driver-stall'); } catch { /* abort is best-effort */ }
  }, STALL_POLL_MS);
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
        onToolCall: (_iter, calls) => {
          captureBriefAuditCalls(calls, rt.cwd || rt.session?.cwd || process.cwd());
          touch();
        },
        onToolResult: touch,
      });
      const stallPromise = new Promise((_, reject) => {
        rejectStalledAsk = reject;
      });
      const resultPromise = RUN_DEADLINE < 0
        ? Promise.race([askPromise, stallPromise])
        : Promise.race([
            askPromise,
            stallPromise,
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
      if (stallAborted) {
        throw new RefusalEquivalentError(
          `lead_driver: stalled turn is refusal-equivalent (no progress ${STALL_MS}ms)`,
        );
      }
      throw err;
    } finally {
      if (askDeadlineTimer) clearTimeout(askDeadlineTimer);
      rejectStalledAsk = null;
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
  const throwIfLeadRefused = () => {
    const sid = rt.sessionId || rt.session?.id || '';
    if (sid && refusalSessionIds.has(sid)) {
      throw new RefusalEquivalentError(
        `lead_driver: lead session ${sid} terminated on API refusal`,
      );
    }
  };

  if (BOOT_JITTER_MS > 0) {
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * BOOT_JITTER_MS)));
  }
  text = await askOnce(prompt);
  throwIfLeadRefused();
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
        throwIfLeadRefused();
        if (kicked || kickDeferred) break;
        if (!anyWorkBusy()) break;
        if (Date.now() >= RUN_DEADLINE) break;
      }
      if (!kickDeferred && !anyWorkBusy()) break;
    }
    kickDeferred = false;
    const t = await askOnce('');
    throwIfLeadRefused();
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
      let closeGraceTimer;
      try {
        await Promise.race([
          Promise.resolve().then(() => rt.close('bench-exit')),
          new Promise((resolve) => {
            closeGraceTimer = setTimeout(resolve, Math.max(0, CLOSE_GRACE_MS));
          }),
        ]);
      } catch (closeError) {
        process.stderr.write(
          `lead_driver: runtime close failed (ignored): ${closeError?.message || closeError}\n`,
        );
      } finally {
        if (closeGraceTimer) clearTimeout(closeGraceTimer);
      }
    }
  }
};

const sids = [];
let text;
let sid;
try {
  ({ text, sid } = await driveSession({ provider, model, effort, fast }));
} catch (error) {
  // Runtime events already contain the complete audit evidence; no persistence
  // or close completion is required to emit the fallback artifact.
  writeBriefAudit();
  if (error instanceof RefusalEquivalentError) {
    process.stderr.write(`${error.message}; exiting 86 so Harbor retries a fresh trial\n`);
    usageMirrorStopped = true;
    if (usageMirrorTimer) clearInterval(usageMirrorTimer);
    mirrorUsageSync();
    process.exit(86);
  }
  throw error;
}
sids.push(sid);
writeBriefAudit();

// Only the Lead session's API marker counts; sub-agent refusals have other IDs.
// Tiny final public responses are refusal-equivalent based solely on the
// shared estimator applied to trimmed result.text, never aggregate usage.
const refusalGateHit = refusalSessionIds.has(sid);
const finalText = String(text ?? '').trim();
const finalTokens = estimateTokens(finalText);
const tinyFinalGateHit = finalTokens <= 1;
process.stdout.write(
  `refusal-gate: sid=${sid} refused=${refusalGateHit} finalTokens=${finalTokens} tinyFinal=${tinyFinalGateHit}\n`,
);
if (refusalGateHit || tinyFinalGateHit) {
  const reason = refusalGateHit ? 'API refusal' : 'tiny final public response';
  process.stdout.write(
    `refusal-restart: ${reason} (sess=${sid}); exiting 86 so Harbor retries a fresh trial\n`,
  );
  usageMirrorStopped = true;
  if (usageMirrorTimer) clearInterval(usageMirrorTimer);
  mirrorUsageSync();
  process.exit(86);
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
