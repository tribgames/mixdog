/**
 * src/ui/statusline-agents.mjs — agent worker/job normalization for the L2 line.
 *
 * Extracted verbatim from statusline.mjs: normalize/merge REPL agent workers &
 * bridge jobs into a statusline payload, classify running vs hidden-maintenance
 * workers, and enumerate active hidden agents from live session runtimes. No
 * behavior change.
 */
import { forEachSessionRuntime } from '../runtime/agent/orchestrator/session/manager.mjs';
import { listHiddenAgentNames } from '../runtime/agent/orchestrator/internal-agents.mjs';
import { classifyToolCategory } from '../runtime/shared/tool-surface.mjs';
import { num, GRN, R, B } from './statusline-format.mjs';

const DEFAULT_HIDDEN_STATUSLINE_AGENTS = Object.freeze(['explorer', 'cycle1-agent', 'cycle2-agent', 'cycle3-agent', 'scheduler-task', 'webhook-handler']);
let _hiddenStatuslineAgents = null;

function normalizeAgentWorkerForStatusline(worker = {}) {
  const tag = String(worker.tag || worker.agent || worker.name || '').trim();
  if (!tag) return null;
  const statusText = String(worker.stage || worker.status || '').toLowerCase();
  const status = isTerminalBridgeStatus(statusText) ? 'idle' : 'running';
  return {
    tag,
    status,
    startedAtMs: timeMs(worker.startedAt || worker.startTime || worker.createdAt),
    agent: worker.agent || null,
    stage: worker.stage || worker.status || null,
    sessionId: worker.sessionId || null,
    provider: worker.provider || null,
    model: worker.model || null,
  };
}

function normalizeAgentJobForStatusline(job = {}) {
  const statusText = String(job.status || job.stage || '').toLowerCase();
  if (!statusText) return null;
  const taskId = String(job.task_id || job.taskId || '').trim();
  const tag = String(job.tag || job.agent || job.type || taskId || '').trim();
  if (!tag && !taskId) return null;
  const startedAtMs = timeMs(job.startedAt);
  const finishedAtMs = timeMs(job.finishedAt);
  if (isTerminalBridgeStatus(statusText) && finishedAtMs > 0) {
    return {
      tag,
      taskId,
      status: 'finished',
      finalStatus: statusText,
      startedAtMs,
      finishedAtMs,
      agent: job.agent || null,
      stage: job.stage || job.workerStatus || job.status || null,
      sessionId: job.sessionId || null,
      provider: job.provider || null,
      model: job.model || null,
    };
  }
  if (!/running/.test(statusText)) return null;
  return {
    tag,
    taskId,
    status: 'running',
    startedAtMs,
    agent: job.agent || null,
    stage: job.stage || job.workerStatus || job.status || null,
    sessionId: job.sessionId || null,
    provider: job.provider || null,
    model: job.model || null,
  };
}

export function agentStatuslinePayload(agentWorkers = [], agentJobs = []) {
  const byTag = new Map();
  const finishedJobs = [];
  for (const worker of Array.isArray(agentWorkers) ? agentWorkers : []) {
    const row = normalizeAgentWorkerForStatusline(worker);
    if (row) byTag.set(row.tag, row);
  }
  for (const job of Array.isArray(agentJobs) ? agentJobs : []) {
    const row = normalizeAgentJobForStatusline(job);
    if (!row) continue;
    if (row.status === 'finished') {
      finishedJobs.push(row);
      continue;
    }
    const prev = byTag.get(row.tag);
    byTag.set(row.tag, { ...(prev || {}), ...row, status: 'running' });
  }
  const workers = [...byTag.values()];
  return {
    workers,
    finishedJobs: finishedJobs.sort((a, b) => (b.finishedAtMs || 0) - (a.finishedAtMs || 0)),
    sessions: {
      roles: workers.filter((w) => w.status !== 'idle').map((w) => w.tag),
      workers,
    },
  };
}

export function classifyAgentWorkers(workers = []) {
  const maintenance = [];
  const runningWorkers = [];
  const seenMaintenance = new Set();
  const seenRunning = new Set();
  for (const w of Array.isArray(workers) ? workers : []) {
    const tag = String(w?.tag || '').trim();
    if (!tag) continue;
    const maint = hiddenWorkerLabel(w);
    if (maint) {
      if (w.status !== 'idle' && !seenMaintenance.has(maint)) {
        seenMaintenance.add(maint);
        maintenance.push(`${GRN}↻${R} ${B}${maint}${R}`);
      }
      continue;
    }
    if (w.status !== 'idle' && !seenRunning.has(tag)) {
      seenRunning.add(tag);
      runningWorkers.push(w);
    }
  }
  return { maintenance, runningWorkers };
}

function hiddenWorkerLabel(worker = {}) {
  const agent = String(worker?.agent || '').trim();
  const tag = String(worker?.tag || '').trim();
  return maintenanceLabel(agent) || (!agent ? maintenanceLabel(tag) : '');
}

function hiddenStatuslineAgents() {
  if (_hiddenStatuslineAgents) return _hiddenStatuslineAgents;
  const agents = new Set(DEFAULT_HIDDEN_STATUSLINE_AGENTS);
  try {
    for (const agent of listHiddenAgentNames()) {
      const clean = String(agent || '').trim();
      if (clean) agents.add(clean);
    }
  } catch {}
  _hiddenStatuslineAgents = agents;
  return agents;
}

function isActiveHiddenStatus(statusText) {
  return /^(connecting|requesting|streaming|tool_running|running)$/i.test(String(statusText || '').trim());
}

export function activeHiddenAgentWorkers({ sessionId = '', clientHostPid = 0 } = {}) {
  const agents = hiddenStatuslineAgents();
  const ownerPid = positiveInt(clientHostPid);
  const ownerSessionId = String(sessionId || '').trim();
  const rows = [];
  try {
    for (const [runtimeSessionId, entry] of forEachSessionRuntime() || []) {
      if (!entry || entry.closed === true) continue;
      const session = entry.session || null;
      if (!session || session.closed === true) continue;
      const agent = String(session?.agent || '').trim();
      if (!agent || !agents.has(agent)) continue;
      const id = session?.id || runtimeSessionId || null;
      if (ownerSessionId && id === ownerSessionId) continue;
      const sessionOwnerId = String(session?.ownerSessionId || '').trim();
      if (sessionOwnerId && ownerSessionId && sessionOwnerId !== ownerSessionId) continue;
      const pid = positiveInt(session?.clientHostPid);
      if (ownerPid && pid && pid !== ownerPid) continue;
      const stage = String(entry.stage || session?.stage || session?.status || '').trim().toLowerCase();
      const status = String(session?.status || stage || '').trim().toLowerCase();
      if (!isActiveHiddenStatus(stage || status)) continue;
      rows.push({
        tag: String(session?.agentTag || `${agent}:${id || rows.length}`).trim(),
        agent,
        status: 'running',
        stage: stage || status || 'running',
        sessionId: id,
        provider: session?.provider || null,
        model: session?.model || null,
      });
    }
  } catch {}
  return rows;
}

function isTerminalBridgeStatus(statusText) {
  return /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/.test(String(statusText || '').toLowerCase());
}

// Agent-side web search activity for the L2 "Web Searching" segment: any live
// sub-session owned by THIS lead (ownerSessionId / clientHostPid match) whose
// CURRENT tool call classifies as 'Web Research' (search/web_fetch/...). The
// lead's own calls are excluded — those arrive via activeTools from the
// transcript — so counts never double.
export function agentWebSearchStatus({ sessionId = '', clientHostPid = 0 } = {}) {
  const ownerPid = positiveInt(clientHostPid);
  const ownerSessionId = String(sessionId || '').trim();
  let count = 0;
  let startedAt = 0;
  try {
    for (const [runtimeSessionId, entry] of forEachSessionRuntime() || []) {
      if (!entry || entry.closed === true) continue;
      if (String(entry.stage || '').trim().toLowerCase() !== 'tool_running') continue;
      const session = entry.session || null;
      if (!session || session.closed === true) continue;
      const id = session?.id || runtimeSessionId || null;
      if (ownerSessionId && id === ownerSessionId) continue;
      const sessionOwnerId = String(session?.ownerSessionId || '').trim();
      if (sessionOwnerId && ownerSessionId && sessionOwnerId !== ownerSessionId) continue;
      const pid = positiveInt(session?.clientHostPid);
      if (ownerPid && pid && pid !== ownerPid) continue;
      const tool = String(entry.lastToolCall || '').trim();
      if (!tool) continue;
      let category = null;
      try { category = classifyToolCategory(tool); } catch { /* unknown tool -> skip */ }
      if (category !== 'Web Research') continue;
      count += 1;
      const started = num(entry.toolStartedAt);
      if (started > 0 && (startedAt === 0 || started < startedAt)) startedAt = started;
    }
  } catch {}
  return { count, startedAt };
}

function timeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

function maintenanceLabel(tag) {
  switch (tag) {
    case 'cycle1-agent': return 'cycle1';
    case 'cycle2-agent': return 'cycle2';
    case 'cycle3-agent': return 'cycle3';
    case 'scheduler-task': return 'scheduler';
    case 'webhook-handler': return 'webhook';
    case 'explorer': return 'explorer';
    default: return '';
  }
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
