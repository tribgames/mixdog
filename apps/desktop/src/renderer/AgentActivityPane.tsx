import { Bot, ChevronDown, ChevronRight, Clock3 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import {
  desktopAgentIdentity,
  desktopAgentStatus,
  isActiveDesktopAgentEntry,
  isQueuedDesktopAgentEntry,
} from '../shared/agent-activity';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { modelDisplayName } from './provider-display';
import { defaultSessionLaneStore } from './session-lane-store';
import { formatWorkElapsed, timeMs } from './TranscriptView';

type RecordValue = Record<string, unknown>;

interface LiveAgentSummary {
  key: string;
  role: string;
  roleId: string;
  model: string;
  provider: string;
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

export function AgentActivityPane({
  active,
  sessions,
  onOpenSession,
}: {
  active: boolean;
  sessions: readonly DesktopSessionSummary[];
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  const sessionKey = sessions.map((session) => session.id).join('\u0000');
  const poolAvailable = typeof window.mixdogDesktop?.listAgentPool === 'function'
    && typeof window.mixdogDesktop?.subscribeAgentPool === 'function';
  const [agentPool, setAgentPool] = useState<DesktopAgentPoolRow[]>([]);
  const [laneRevision, setLaneRevision] = useState(0);
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!active || poolAvailable || !sessionKey) return undefined;
    const refresh = () => setLaneRevision((current) => current + 1);
    const unsubscribes = sessionKey.split('\u0000')
      .filter(Boolean)
      .map((sessionId) => defaultSessionLaneStore.subscribe(sessionId, refresh));
    refresh();
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [active, poolAvailable, sessionKey]);
  useEffect(() => {
    if (!active || !poolAvailable) return undefined;
    let disposed = false;
    let pushRevision = 0;
    const apply = (rows: DesktopAgentPoolRow[]) => {
      if (disposed) return;
      pushRevision += 1;
      setAgentPool(Array.isArray(rows) ? rows : []);
    };
    const unsubscribe = window.mixdogDesktop!.subscribeAgentPool!(apply);
    const initialRevision = pushRevision;
    void window.mixdogDesktop!.listAgentPool!().then((rows) => {
      if (!disposed && pushRevision === initialRevision) {
        setAgentPool(Array.isArray(rows) ? rows : []);
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [active, poolAvailable]);
  const groups = useMemo(() => {
    if (!poolAvailable) {
      return sessions.map((session) => ({
        key: session.id,
        ownerSessionId: session.id,
        title: sessionSummaryTitle(session),
        agents: liveAgentRows(defaultSessionLaneStore.get(session.id), session.id),
      })).filter((group) => group.agents.length > 0);
    }
    const owners = new Map(sessions.map((session) => [session.id, session]));
    const grouped = new Map<string, LiveAgentSummary[]>();
    for (const agent of liveAgentRows({ agentWorkers: agentPool })) {
      const key = agent.ownerSessionId || agent.sessionId;
      const bucket = grouped.get(key);
      if (bucket) bucket.push(agent);
      else grouped.set(key, [agent]);
    }
    return [...grouped.entries()].map(([key, agents]) => ({
      key,
      ownerSessionId: agents[0]?.ownerSessionId || key,
      title: owners.has(key) ? sessionSummaryTitle(owners.get(key)!) : t('Background agents'),
      agents,
    }));
  }, [agentPool, laneRevision, poolAvailable, sessions]);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active || groups.length === 0) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, groups.length]);

  return <div className="agent-activity-page">
    {groups.length > 0 ? <div className="agent-session-groups">
      {groups.map(({ key, ownerSessionId, title, agents }) => {
        const collapsed = collapsedSessionIds.has(key);
        return <section key={key} className="agent-session-group" aria-label={t('{{title}} agents', { title })}>
          <button type="button" className="agent-session-heading"
            aria-expanded={!collapsed}
            onClick={() => setCollapsedSessionIds((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })}>
            <span className="agent-session-chevron" aria-hidden="true">
              {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </span>
            <span className="agent-session-title" title={title}>{title}</span>
            <small>{agents.length}</small>
          </button>
          <div className="agent-activity-rows" hidden={collapsed}>
            {agents.map((agent) => {
              // Current turn's elapsed; session lifetime only when a reused
              // worker has no turn stamp yet.
              const elapsedBase = agent.turnStartedAt || agent.startedAt;
              const elapsed = elapsedBase ? formatWorkElapsed(clock - elapsedBase) || '0s' : agent.status;
              const modelLabel = modelDisplayName(agent.model, agent.provider);
              return <button key={agent.key} type="button" className="agent-activity-row"
                data-agent-tag={agent.tag || undefined}
                data-agent-session-id={agent.sessionId || undefined}
                aria-label={t('Open {{role}} in {{title}}', { role: agent.role, title })}
                aria-disabled={!agent.sessionId || undefined}
                onClick={() => {
                  if (agent.sessionId) {
                    onOpenSession?.(agent.sessionId, agent.tag || agent.role, ownerSessionId);
                  }
                }}>
                <span className="agent-activity-state">
                  {agent.queued
                    ? <Clock3 size={12} aria-label={t('Queued')} />
                    : <ProgressSpinner size={12} role="status" aria-label={t('{{name}} is running', { name: agent.role })} />}
                </span>
                <span className="agent-activity-copy">
                  <span className="agent-activity-primary">
                    <b>{agent.role}</b>
                    {modelLabel && <span title={agent.model}>· {modelLabel}</span>}
                  </span>
                  <small>{agent.queued ? `Queued${agent.tag ? ` · ${agent.tag}` : ''}` : agent.tag}</small>
                </span>
                <time className="agent-activity-elapsed">{elapsed}</time>
              </button>;
            })}
          </div>
        </section>;
      })}
    </div> : <div className="utility-dock-empty agent-activity-empty">
      <Bot size={28} strokeWidth={1.5} aria-hidden="true" />
      <p>{t('No agents are running.')}</p>
    </div>}
  </div>;
}
