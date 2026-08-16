import { Bot } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import {
  desktopAgentIdentity,
  desktopAgentStatus,
  isActiveDesktopAgentEntry,
  isQueuedDesktopAgentEntry,
} from '../shared/agent-activity';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { FastModeIndicator } from './FastModeToggle';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { modelDisplayName } from './provider-display';
import { formatWorkElapsed, timeMs } from './TranscriptView';

type RecordValue = Record<string, unknown>;

interface LiveAgentSummary {
  key: string;
  role: string;
  roleId: string;
  model: string;
  provider: string;
  effort: string;
  fast: boolean;
  tag: string;
  status: string;
  queued: boolean;
  startedAt: number;
  turnStartedAt: number;
  sessionId: string;
  ownerSessionId: string;
}

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function agentRoleLabel(value: unknown): string {
  const role = String(value || '').trim();
  if (!role) return 'Agent';
  return role.split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function liveAgentRows(snapshot: unknown, fallbackOwnerSessionId = ''): LiveAgentSummary[] {
  const state = record(snapshot);
  const workers = (Array.isArray(state.agentWorkers) ? state.agentWorkers : []).map(record);
  const jobs = (Array.isArray(state.agentJobs) ? state.agentJobs : []).map(record);
  const workerByIdentity = new Map<string, RecordValue>();
  workers.forEach((entry) => {
    const identity = desktopAgentIdentity(entry);
    if (identity) workerByIdentity.set(identity, entry);
  });
  const mapped = new Map<string, LiveAgentSummary>();
  [
    ...workers.map((entry, index) => ({ entry, index, worker: true })),
    ...jobs.map((entry, index) => ({ entry, index: workers.length + index, worker: false })),
  ].forEach(({ entry, index, worker }) => {
    if (!isActiveDesktopAgentEntry(entry)) return;
    const identity = desktopAgentIdentity(entry);
    if (!worker && identity) {
      const workerEntry = workerByIdentity.get(identity);
      if (workerEntry
        && (isActiveDesktopAgentEntry(workerEntry) || !isQueuedDesktopAgentEntry(entry))) return;
    }
    const status = desktopAgentStatus(entry);
    const tag = String(entry.tag || '').trim();
    const taskId = String(entry.task_id || entry.taskId || '').trim();
    const roleValue = String(entry.agent || entry.name || entry.type || '').trim();
    const role = agentRoleLabel(roleValue);
    const roleId = roleValue.toLowerCase();
    const model = String(entry.model || '').trim();
    const provider = String(entry.provider || '').trim();
    const effort = String(entry.effort || '').trim();
    const fast = entry.fast === true;
    const startedAt = timeMs(entry.startedAt || entry.startTime || entry.createdAt);
    const turnStartedAt = timeMs(entry.turnStartedAt);
    const sessionId = String(entry.sessionId || '').trim();
    const ownerSessionId = String(entry.ownerSessionId || fallbackOwnerSessionId || '').trim();
    const queued = isQueuedDesktopAgentEntry(entry);
    const key = identity || `${roleValue || 'agent'}-${index}`;
    const current = mapped.get(key);
    if (!current) {
      mapped.set(key, {
        key,
        role,
        roleId,
        model,
        provider,
        effort,
        fast,
        tag: tag || taskId,
        status,
        queued,
        startedAt,
        turnStartedAt,
        sessionId,
        ownerSessionId,
      });
      return;
    }
    mapped.set(key, {
      ...current,
      role: current.role === 'Agent' ? role : current.role,
      roleId: current.roleId || roleId,
      model: current.model || model,
      provider: current.provider || provider,
      effort: current.effort || effort,
      fast: current.fast || fast,
      tag: current.tag || tag || taskId,
      status: current.queued && !queued ? status : current.status,
      queued: current.queued && queued,
      startedAt: current.startedAt || startedAt,
      turnStartedAt: current.turnStartedAt || turnStartedAt,
      sessionId: current.sessionId || sessionId,
      ownerSessionId: current.ownerSessionId || ownerSessionId,
    });
  });
  return [...mapped.values()].sort((left, right) => {
    const leftTime = left.startedAt || Number.MAX_SAFE_INTEGER;
    const rightTime = right.startedAt || Number.MAX_SAFE_INTEGER;
    return leftTime - rightTime || left.key.localeCompare(right.key);
  });
}

interface LiveShellSummary {
  key: string;
  command: string;
  cwd: string;
  startedAt: number;
}

export function liveShellRows(snapshot: unknown): LiveShellSummary[] {
  const shellJobs = record(record(snapshot).shellJobs);
  const jobs = Array.isArray(shellJobs.jobs) ? shellJobs.jobs : [];
  return jobs.flatMap((value) => {
    const entry = record(value);
    const key = String(entry.taskId || entry.task_id || '').trim();
    if (!key) return [];
    return [{
      key,
      command: String(entry.command || '').trim(),
      cwd: String(entry.cwd || '').trim(),
      startedAt: timeMs(entry.startedAt) || 0,
    }];
  }).sort((left, right) =>
    (left.startedAt || Number.MAX_SAFE_INTEGER) - (right.startedAt || Number.MAX_SAFE_INTEGER)
      || left.key.localeCompare(right.key));
}

export function liveShellCount(snapshot: unknown): number {
  return Math.max(0, Number(record(record(snapshot).shellJobs).count) || 0);
}

export function liveTaskCount(snapshot: unknown): number {
  return liveAgentRows(snapshot).length + liveShellCount(snapshot);
}

function poolRowKey(agent: DesktopAgentPoolRow, index: number): string {
  return String(agent.sessionId || agent.tag || agent.taskId || index);
}

function poolOwnerId(agent: DesktopAgentPoolRow): string {
  return String(agent.ownerSessionId || agent.sessionId || '').trim();
}

function AgentPoolRow({
  agent,
  clock,
  ownerSessionId,
  onOpenSession,
}: {
  agent: DesktopAgentPoolRow;
  clock: number;
  ownerSessionId: string;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const queued = isQueuedDesktopAgentEntry(agent);
  const running = isActiveDesktopAgentEntry(agent) && !queued;
  const role = agentRoleLabel(agent.agent || agent.tag);
  const elapsedBase = timeMs(agent.turnStartedAt) || timeMs(agent.startedAt);
  const idleBase = timeMs(agent.finishedAt) || timeMs(agent.updatedAt);
  const idleElapsed = idleBase ? formatWorkElapsed(clock - idleBase) || '0s' : '';
  const elapsed = queued
    ? t('Queued')
    : running
      ? (elapsedBase ? formatWorkElapsed(clock - elapsedBase) || '0s' : desktopAgentStatus(agent))
      : [t('Idle'), idleElapsed].filter(Boolean).join(' · ');
  const modelLabel = modelDisplayName(String(agent.model || ''), String(agent.provider || ''));
  const effortValue = String(agent.effort || '').trim();
  const effortLabel = effortValue
    ? `${effortValue.slice(0, 1).toLocaleUpperCase()}${effortValue.slice(1)}`
    : '';
  const routeLabel = [modelLabel, effortLabel].filter(Boolean).join(' · ');
  const sessionId = String(agent.sessionId || '').trim();
  return <div className="schedules-row workflows-agent-summary-row">
    <button type="button" className="schedules-row-copy projects-row-open"
      data-agent-tag={agent.tag || undefined}
      data-agent-session-id={sessionId || undefined}
      aria-label={agent.tag || role}
      disabled={!sessionId}
      onClick={() => {
        if (sessionId) onOpenSession?.(sessionId, agent.tag || role, ownerSessionId);
      }}>
      <b>{role}</b>
      <small className="agent-route-summary" title={String(agent.model || '') || undefined}>
        <span>{routeLabel}</span>
        {agent.fast === true && <FastModeIndicator />}
      </small>
    </button>
    <span className="agent-activity-status">
      {running && <ProgressSpinner size={16} role="status"
        aria-label={t('{{name}} is running', { name: role })} />}
      <time className="agent-activity-elapsed">{elapsed}</time>
    </span>
  </div>;
}

export function AgentActivityPane({
  active,
  sessions,
  onOpenLeadSession,
  onOpenSession,
}: {
  active: boolean;
  sessions: readonly DesktopSessionSummary[];
  activeSessionIds?: readonly string[];
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const [agents, setAgents] = useState<DesktopAgentPoolRow[] | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const host = window.mixdogDesktop;
    if (typeof host?.listAgentPool !== 'function') {
      setAgents([]);
      return undefined;
    }
    let live = true;
    void host.listAgentPool()
      .then((rows) => {
        if (live) setAgents(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (live) setAgents([]);
      });
    const unsubscribe = typeof host.subscribeAgentPool === 'function'
      ? host.subscribeAgentPool((rows) => {
        if (live) setAgents(Array.isArray(rows) ? rows : []);
      })
      : undefined;
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);
  const groups = useMemo(() => {
    const byOwner = new Map<string, {
      ownerId: string;
      session?: DesktopSessionSummary;
      agents: DesktopAgentPoolRow[];
    }>();
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    for (const agent of agents || []) {
      const ownerId = poolOwnerId(agent);
      if (!ownerId) continue;
      let group = byOwner.get(ownerId);
      if (!group) {
        group = { ownerId, session: sessionById.get(ownerId), agents: [] };
        byOwner.set(ownerId, group);
      }
      group.agents.push(agent);
    }
    for (const group of byOwner.values()) {
      group.agents.sort((left, right) => {
        const leftLead = String(left.agent || '').toLowerCase() === 'lead' ? 0 : 1;
        const rightLead = String(right.agent || '').toLowerCase() === 'lead' ? 0 : 1;
        return leftLead - rightLead;
      });
    }
    return [...byOwner.values()].sort((left, right) => {
      const leftTime = Number(left.session?.activityAt || left.session?.updatedAt) || 0;
      const rightTime = Number(right.session?.activityAt || right.session?.updatedAt) || 0;
      return rightTime - leftTime || left.ownerId.localeCompare(right.ownerId);
    });
  }, [agents, sessions]);
  const hasLiveClock = (agents || []).length > 0;
  useEffect(() => {
    if (!active || !hasLiveClock) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, hasLiveClock]);

  if (agents === null) return <div className="schedules-page agent-activity-page">
    <div className="schedules-list">
      <div className="schedules-row workflows-agent-summary-row" role="status">
        <span className="schedules-row-copy">{t('Loading activity…')}</span>
        <span className="agent-activity-status"><ProgressSpinner size={16} /></span>
      </div>
    </div>
  </div>;
  if (groups.length === 0) return <div className="schedules-page agent-activity-page">
    <p className="schedules-empty agent-activity-empty">
      <Bot size={28} aria-hidden="true" />
      <span>{t('No agents are running.')}</span>
    </p>
  </div>;
  return <div className="schedules-page agent-activity-page">
    {groups.map((group) => {
      const title = group.session ? sessionSummaryTitle(group.session) : group.ownerId;
      return <section key={group.ownerId} className="workflows-models"
        data-agent-owner-session-id={group.ownerId}>
        <div className="workflows-section-head">
          <button type="button" className="agent-session-heading" aria-label={title}
            data-lead-session-id={group.ownerId}
            onClick={() => onOpenLeadSession?.(group.ownerId)}>
            <h2>{title}</h2>
          </button>
        </div>
        <div className="schedules-list">
          {group.agents.map((agent, index) => <AgentPoolRow
            key={poolRowKey(agent, index)}
            agent={agent}
            clock={clock}
            ownerSessionId={group.ownerId}
            onOpenSession={onOpenSession} />)}
        </div>
      </section>;
    })}
  </div>;
}
