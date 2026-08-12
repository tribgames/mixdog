import { Bot, Clock3 } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import type { DesktopSessionSummary } from '../shared/contract';
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
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import { formatWorkElapsed, timeMs } from './TranscriptView';
import type { Snapshot } from './desktop-types';

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

function leadIsActive(snapshot: Snapshot): boolean {
  const spinner = record(snapshot.spinner);
  const commandStatus = record(snapshot.commandStatus);
  return Boolean(
    snapshot.busy
    || snapshot.commandBusy
    || snapshot.thinking
    || (snapshot.spinner && spinner.active !== false)
    || (snapshot.commandStatus && commandStatus.active !== false),
  );
}

function agentActivitySnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  return left.sessionId === right.sessionId
    && left.busy === right.busy
    && left.commandBusy === right.commandBusy
    && left.thinking === right.thinking
    && left.spinner === right.spinner
    && left.commandStatus === right.commandStatus
    && left.provider === right.provider
    && left.model === right.model
    && left.effort === right.effort
    && left.fast === right.fast
    && left.agentWorkers === right.agentWorkers
    && left.agentJobs === right.agentJobs
    && left.shellJobs === right.shellJobs;
}

function AgentActivityRow({
  agent,
  clock,
  ownerSessionId,
  onOpenSession,
}: {
  agent: LiveAgentSummary;
  clock: number;
  ownerSessionId: string;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const elapsedBase = agent.turnStartedAt || agent.startedAt;
  const elapsed = agent.queued
    ? t('Queued')
    : elapsedBase ? formatWorkElapsed(clock - elapsedBase) || '0s' : agent.status;
  const modelLabel = modelDisplayName(agent.model, agent.provider);
  const effortLabel = agent.effort
    ? `${agent.effort.slice(0, 1).toLocaleUpperCase()}${agent.effort.slice(1)}`
    : '';
  const routeLabel = [modelLabel, effortLabel].filter(Boolean).join(' · ');
  return <button type="button" className="agent-activity-row"
    data-agent-tag={agent.tag || undefined}
    data-agent-session-id={agent.sessionId || undefined}
    aria-label={agent.tag || agent.role}
    aria-disabled={!agent.sessionId || undefined}
    onClick={() => {
      if (agent.sessionId) {
        onOpenSession?.(
          agent.sessionId,
          agent.tag || agent.role,
          agent.ownerSessionId || ownerSessionId,
        );
      }
    }}>
    <span className="agent-activity-state">
      {agent.queued
        ? <Clock3 size={12} aria-label={t('Queued')} />
        : <ProgressSpinner size={12} role="status"
            aria-label={t('{{name}} is running', { name: agent.role })} />}
    </span>
    <span className="agent-activity-copy">
      <span className="agent-activity-primary"><b>{agent.role}</b></span>
      <small className="agent-route-summary" title={agent.model || undefined}>
        <span>{routeLabel}</span>
        {agent.fast && <FastModeIndicator />}
      </small>
    </span>
    <time className="agent-activity-elapsed">{elapsed}</time>
  </button>;
}

function AgentSessionGroup({
  active,
  session,
  clock,
  onOpenLeadSession,
  onOpenSession,
}: {
  active: boolean;
  session: DesktopSessionSummary;
  clock: number;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const lane = useSessionLane(
    session.id,
    defaultSessionLaneStore,
    agentActivitySnapshotsEqual,
    active,
  );
  const title = sessionSummaryTitle(session);
  if (lane === null) {
    return <section className="agent-session-group" data-agent-owner-session-id={session.id}>
      <button type="button" className="agent-session-heading"
        aria-label={title}
        onClick={() => onOpenLeadSession?.(session.id)}>
        <span className="agent-session-title">{title}</span>
      </button>
      <div className="agent-activity-rows">
        <div className="agent-activity-row agent-activity-row--static" role="status">
          <span className="agent-activity-state"><ProgressSpinner size={12} /></span>
          <span className="agent-activity-copy">{t('Loading activity…')}</span>
        </div>
      </div>
    </section>;
  }
  const snapshot = lane as Snapshot;
  const agents = liveAgentRows(snapshot, session.id);
  const shells = liveShellRows(snapshot);
  const shellCount = liveShellCount(snapshot);
  const showLead = leadIsActive(snapshot);
  const taskCount = (showLead ? 1 : 0) + agents.length + shellCount;
  const leadModel = String(snapshot.model || '').trim();
  const leadProvider = String(snapshot.provider || '').trim();
  const leadRoute = modelDisplayName(leadModel, leadProvider);
  const leadStartedAt = timeMs(
    record(snapshot.commandStatus).startedAt || record(snapshot.spinner).startedAt,
  );
  return <section className="agent-session-group" data-agent-owner-session-id={session.id}>
    <button type="button" className="agent-session-heading"
      aria-label={title}
      onClick={() => onOpenLeadSession?.(session.id)}>
      <span className="agent-session-title">{title}</span>
      <small>{taskCount}</small>
    </button>
    <div className="agent-activity-rows">
      {showLead && <button type="button"
        className="agent-activity-row agent-activity-row--lead"
        data-lead-session-id={session.id}
        aria-label={`Lead · ${title}`}
        onClick={() => onOpenLeadSession?.(session.id)}>
        <span className="agent-activity-state">
          <ProgressSpinner size={12} role="status"
            aria-label={t('{{name}} is running', { name: 'Lead' })} />
        </span>
        <span className="agent-activity-copy">
          <span className="agent-activity-primary"><b>Lead</b></span>
          <small className="agent-route-summary" title={leadModel || undefined}>
            <span>{leadRoute}</span>
            {snapshot.fast === true && <FastModeIndicator />}
          </small>
        </span>
        <time className="agent-activity-elapsed">
          {leadStartedAt ? formatWorkElapsed(clock - leadStartedAt) || '0s' : ''}
        </time>
      </button>}
      {agents.map((agent) => <AgentActivityRow key={agent.key}
        agent={agent}
        clock={clock}
        ownerSessionId={session.id}
        onOpenSession={onOpenSession} />)}
      {shells.map((shell) => <div key={shell.key}
        className="agent-activity-row agent-activity-row--static"
        data-shell-task-id={shell.key}>
        <span className="agent-activity-state">
          <ProgressSpinner size={12} role="status"
            aria-label={t('{{name}} is running', { name: t('Shell') })} />
        </span>
        <span className="agent-activity-copy">
          <span className="agent-activity-primary"><b>{t('Shell')}</b></span>
          <small className="agent-route-summary"
            title={[shell.command, shell.cwd].filter(Boolean).join('\n')}>
            <span>{shell.command || shell.cwd || shell.key}</span>
          </small>
        </span>
        <time className="agent-activity-elapsed">
          {shell.startedAt ? formatWorkElapsed(clock - shell.startedAt) || '0s' : ''}
        </time>
      </div>)}
      {shellCount > shells.length && <div
        className="agent-activity-row agent-activity-row--static">
        <span className="agent-activity-state">
          <ProgressSpinner size={12} role="status"
            aria-label={t('{{name}} is running', { name: t('Shell') })} />
        </span>
        <span className="agent-activity-copy">
          <span className="agent-activity-primary"><b>{t('Shell')}</b></span>
          <small className="agent-route-summary">
            <span>×{shellCount - shells.length}</span>
          </small>
        </span>
        <time className="agent-activity-elapsed">
          {String(record(snapshot.shellJobs).elapsedLabel || '')}
        </time>
      </div>}
    </div>
  </section>;
}

export function AgentActivityPane({
  active,
  sessions,
  activeSessionIds,
  onOpenLeadSession,
  onOpenSession,
}: {
  active: boolean;
  sessions: readonly DesktopSessionSummary[];
  activeSessionIds: readonly string[];
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const activeIds = new Set(activeSessionIds);
  const activeSessions = sessions
    .filter((session) => activeIds.has(session.id))
    .sort((left, right) =>
      Number(right.activityAt || right.updatedAt) - Number(left.activityAt || left.updatedAt));
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active || activeSessions.length === 0) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, activeSessions.length]);

  if (activeSessions.length === 0) return <div className="agent-activity-page">
    <p className="agent-activity-empty">
      <Bot size={28} aria-hidden="true" />
      <span>{t('No agents are running.')}</span>
    </p>
  </div>;
  return <div className="agent-activity-page">
    <div className="agent-session-groups">
      {activeSessions.map((session) => <AgentSessionGroup key={session.id}
        active={active}
        session={session}
        clock={clock}
        onOpenLeadSession={onOpenLeadSession}
        onOpenSession={onOpenSession} />)}
    </div>
  </div>;
}
