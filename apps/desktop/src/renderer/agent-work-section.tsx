// The bot page's "Working" section: the task sessions bots started
// (`taskAgent`) that are working right now, blocked on the user, or failed —
// owning bot, task title, status and elapsed. A row opens its session; the
// header folds the list (the choice persists). Nothing running, nothing shown.
import { ChevronDown, ChevronRight } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import { type AgentActivityNode, flattenAgentActivityNodes } from './agent-activity-model';
import { type AgentChatIndicator, agentGroupIndicator } from './agent-chat-summary';
import type { AgentContact } from './agent-contacts-model';
import { AgentAvatar } from './agent-avatar';
import { agentElapsedText } from './agent-row-meta';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { sessionDisplayTitle } from './session-display-title';
import { useClock } from './use-clock';

const COLLAPSED_KEY = 'mixdog.agent-work-collapsed';

function readCollapsed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(key: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(key, collapsed ? '1' : '0');
  } catch {
    /* Storage-less hosts keep the choice for this window only. */
  }
}

export interface AgentWorkRow {
  sessionId: string;
  title: string;
  agentId: string;
  botName: string;
  avatar: AgentContact['avatar'] | null;
  kind: 'running' | 'attention' | 'error';
  /** The task Lead's pool row, whose current turn start gives the elapsed time. */
  lead: Parameters<typeof agentElapsedText>[1] | null;
}

const NONE: ReadonlySet<string> = new Set();

/** The task sessions that need showing, newest activity first. `needsUser`
 *  holds the sessions waiting on the user (session-attention-index): a Lead
 *  blocked on its own approval or question has no pool node saying so. */
function workKind(needsAttention: boolean, pooled: AgentChatIndicator, working: boolean) {
  if (needsAttention) return 'attention';
  if (pooled && pooled.kind !== 'unread') return pooled.kind;
  return working ? 'running' : null;
}

export function agentWorkRows(
  sessions: readonly DesktopSessionSummary[],
  groups: ReadonlyMap<string, readonly AgentActivityNode[]>,
  contacts: readonly AgentContact[],
  needsUser: ReadonlySet<string> = NONE
): AgentWorkRow[] {
  const rows: Array<AgentWorkRow & { at: number }> = [];
  for (const session of sessions) {
    if (!session.taskAgent || session.archived) continue;
    const nodes = groups.get(session.id);
    const pooled: AgentChatIndicator = nodes?.length ? agentGroupIndicator(session.id, nodes) : null;
    const kind = workKind(needsUser.has(session.id), pooled, Boolean(session.working));
    if (!kind) continue;
    const contact = contacts.find((entry) => entry.agentId === session.taskAgent);
    rows.push({
      sessionId: session.id,
      title: sessionDisplayTitle(session, t('Untitled session')),
      agentId: session.taskAgent,
      botName: contact?.name ?? session.taskAgent,
      avatar: contact?.avatar ?? null,
      kind,
      lead: (nodes && flattenAgentActivityNodes(nodes).find((node) => node.sessionId === session.id)?.agent) || null,
      at: Number(session.activityAt) || session.updatedAt || 0,
    });
  }
  return rows.sort((left, right) => right.at - left.at);
}

function WorkStatus({ row }: { row: AgentWorkRow }): React.ReactElement {
  const now = useClock(row.kind === 'running');
  if (row.kind === 'running') {
    const elapsed = row.lead ? agentElapsedText('running', row.lead, now) : '';
    return (
      <>
        {elapsed && <time className="agent-chat-time">{elapsed}</time>}
        <span className="agent-chat-status" data-kind="running">
          <ProgressSpinner size={14} aria-hidden="true" />
          <span className="sr-only">{t('Working')}</span>
        </span>
      </>
    );
  }
  const label = row.kind === 'error' ? t('Failed') : t('Waiting for approval');
  return (
    <span className="agent-chat-status" data-kind={row.kind === 'error' ? 'error' : 'attention-mark'}>
      <span aria-hidden="true">!</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function AgentWorkSection({
  rows,
  groupCount = 0,
  children,
  onOpenSession,
}: {
  /** Task-session rows no work group already shows. */
  rows: readonly AgentWorkRow[];
  /** Work groups rendered as `children`; they count toward the header. */
  groupCount?: number;
  children?: React.ReactNode;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement | null {
  const label = t('Working');
  const [collapsed, setCollapsed] = useState(() => readCollapsed(COLLAPSED_KEY));
  const count = groupCount + rows.length;
  if (count === 0) return null;
  const toggle = (): void => {
    writeCollapsed(COLLAPSED_KEY, !collapsed);
    setCollapsed(!collapsed);
  };
  return (
    <section className="workflows-models agent-work-section" data-agent-section="working">
      <div className="workflows-section-head">
        <h2 className="agent-work-heading">
          <button type="button" className="agent-session-heading" aria-expanded={!collapsed} onClick={toggle}>
            <span className="agent-work-label">{label}</span>
            <span className="dock-review-count">{count}</span>
            <span className="agent-session-chevron" aria-hidden="true">
              {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </span>
          </button>
        </h2>
      </div>
      {!collapsed && children}
      {!collapsed && rows.length > 0 && (
        <ul className="agent-contact-list agent-work-list" aria-label={label}>
          {rows.map((row) => (
            <li key={row.sessionId} className="agent-chat-row" data-kind="contact" data-agent-work={row.sessionId}>
              <button
                type="button"
                className="agent-chat-row-main"
                data-work-status={row.kind}
                aria-label={`${row.botName}: ${row.title}`}
                onClick={() => onOpenSession?.(row.sessionId, row.title, row.sessionId)}
              >
                <span className="agent-chat-avatar">
                  {row.avatar && (
                    <AgentAvatar
                      agentId={row.agentId}
                      avatar={row.avatar}
                      className="agent-contact-mascot"
                      state={row.kind === 'running' ? 'typing' : 'still'}
                      priority={2}
                    />
                  )}
                </span>
                <span className="agent-chat-body agent-contact-body">
                  <b className="agent-chat-title">{row.botName}</b>
                  <span className="agent-chat-preview">{row.title}</span>
                  <span className="agent-contact-aside" data-has-status="true">
                    <WorkStatus row={row} />
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
