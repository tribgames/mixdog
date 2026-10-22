// The bot page's Leads: ordinary coding sessions whose Lead (or a sub-agent)
// works right now, one messenger row each in the bot rows' layout — provider
// icon in the avatar slot, session title, "model · latest line", and on the
// right the time over the state mark. A divider sets the block apart; a
// finished Lead stays listed (resting, no state mark) for the Agents pane
// window after it settled, as in 1.2, then leaves.
import { Bot, Pin } from 'lucide-react';
import type React from 'react';
import { Fragment } from 'react';
import { AGENT_PANE_VISIBLE_MS } from '../../../../src/runtime/shared/agent-reap-state.mjs';
import type { RetainChoice } from './bot-order-store';
import { desktopAgentActivityState, hasPendingDesktopAgentWork } from '../shared/agent-activity';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import { type AgentActivityNode, flattenAgentActivityNodes } from './agent-activity-model';
import { agentChatTimeLabel, agentGroupIndicator } from './agent-chat-summary';
import { agentElapsedText } from './agent-row-meta';
import { t } from './i18n';
import { useLeadAvatar } from './lead-avatar-store';
import { timeMs } from './transcript-primitives';
import { ProgressSpinner } from './ProgressSpinner';
import { contextMenuRowProps } from './ScmContextMenu';
import { ProviderIcon, modelDisplayName } from './provider-display';
import { sessionDisplayTitle } from './session-display-title';
import { SubtreeToggle, subAgentNodes, subtreeRowAttr } from './agent-subtree';

export interface AgentLeadRow {
  sessionId: string;
  title: string;
  provider: string | null;
  /** "model · latest line", the muted preview. */
  preview: string;
  at: number;
  /** `idle`: finished, still inside the pane window. */
  kind: 'running' | 'attention' | 'idle';
  /** Pinned by the user: never expires. */
  pinned: boolean;
  /** Sub-agents hang under it (running, or finished and not yet cleared). */
  hasSubAgents: boolean;
}

interface LeadGroup {
  ownerId: string;
  session: DesktopSessionSummary;
  nodes: readonly AgentActivityNode[];
}

/** The newest moment anything in the group settled: the pool's frozen
 *  `idleSince` (finish stamp, else last update), the clock the Agents pane
 *  window (AGENT_PANE_VISIBLE_MS) counts from. 0 when no row carries one. */
function settledAt(flat: readonly AgentActivityNode[]): number {
  return Math.max(0, ...flat.map((node) => timeMs(node.agent.idleSince)));
}

const HOUR_MS = AGENT_PANE_VISIBLE_MS;

/** How long a finished Lead stays listed for a "Keep finished agents" choice;
 *  the 1-hour default is the pool's own pane window. */
export function retainWindowMs(choice: RetainChoice): number {
  if (choice === 'forever') return Number.POSITIVE_INFINITY;
  return { '1h': HOUR_MS, '1d': 24 * HOUR_MS, '7d': 7 * 24 * HOUR_MS }[choice];
}

/** Whether something settled at `stamp` is still inside `windowMs`. An
 *  unstamped pool row has no provable age and stays (as the pool treats it). */
const withinWindow = (stamp: number, now: number, windowMs: number): boolean => !(stamp > 0) || now - stamp < windowMs;

export interface AgentLeadRowOptions {
  now?: number;
  /** The "Keep finished agents" window; default 1 hour. */
  retainMs?: number;
  /** Pinned Lead session ids: never expire. */
  pinned?: ReadonlySet<string>;
  /** The session list the pane shows (already narrowed to the ones it may
   *  list). The pool stops publishing a finished Lead after an hour, so a
   *  longer window or a pin lists the session itself, as finished. */
  sessions?: readonly DesktopSessionSummary[];
}

const NO_PINS: ReadonlySet<string> = new Set();

/** An ordinary coding session (a bot's task session included): not an agent's
 *  home, room or automation run. */
function ordinaryLeadSession(session: DesktopSessionSummary): boolean {
  return (
    session.messageCount > 0 &&
    !session.archived &&
    !session.agentHome &&
    !session.agentRoom &&
    !session.agentSession &&
    !session.sourceType &&
    session.sessionMode !== 'agent'
  );
}

/** The Leads still working (or blocked on the user), the ones that finished
 *  inside the retention window and the pinned ones; pinned first, then newest
 *  activity first. */
export function agentLeadRows(
  groups: readonly LeadGroup[],
  needsUser: ReadonlySet<string>,
  { now = Date.now(), retainMs = HOUR_MS, pinned = NO_PINS, sessions = [] }: AgentLeadRowOptions = {}
): AgentLeadRow[] {
  const rows: AgentLeadRow[] = [];
  for (const group of groups) {
    const flat = flattenAgentActivityNodes(group.nodes);
    const attention =
      needsUser.has(group.ownerId) || agentGroupIndicator(group.ownerId, group.nodes)?.kind === 'attention';
    const running = flat.some(
      (node) => hasPendingDesktopAgentWork(node.agent) || desktopAgentActivityState(node.agent) === 'running'
    );
    const isPinned = pinned.has(group.ownerId);
    if (!attention && !running && !isPinned && !withinWindow(settledAt(flat), now, retainMs)) continue;
    const { session } = group;
    const lead: DesktopAgentPoolRow | undefined = flat.find((node) => node.sessionId === group.ownerId)?.agent;
    const provider = lead?.provider || session.provider || null;
    const model = modelDisplayName(lead?.model || session.model, provider || '');
    let kind: AgentLeadRow['kind'] = 'idle';
    let status = lead ? agentElapsedText(desktopAgentActivityState(lead), lead, now) : t('Idle');
    if (running) {
      kind = 'running';
      status = t('Working');
    }
    if (attention) {
      kind = 'attention';
      status = t('Waiting for approval');
    }
    rows.push({
      sessionId: group.ownerId,
      title: sessionDisplayTitle(session, t('Untitled session')),
      provider,
      // The row shows the model only; the face's spinner / "!" carries the state.
      preview: model || status,
      at: Number(session.activityAt) || session.updatedAt || 0,
      kind,
      pinned: isPinned,
      hasSubAgents: subAgentNodes(group.ownerId, group.nodes).length > 0,
    });
  }
  const pooled = new Set(groups.map((group) => group.ownerId));
  for (const session of sessions) {
    if (pooled.has(session.id) || session.working || !ordinaryLeadSession(session)) continue;
    const at = Number(session.activityAt) || session.updatedAt || 0;
    const isPinned = pinned.has(session.id);
    if (!isPinned && !(at > 0 && withinWindow(at, now, retainMs))) continue;
    const provider = session.provider || null;
    const model = modelDisplayName(session.model, provider || '');
    rows.push({
      sessionId: session.id,
      title: sessionDisplayTitle(session, t('Untitled session')),
      provider,
      preview: model || t('Idle'),
      at,
      kind: 'idle',
      pinned: isPinned,
      hasSubAgents: false,
    });
  }
  return rows.sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.at - left.at);
}

export function AgentLeadRows({
  rows,
  selectedSessionId = '',
  onOpen,
  onOpenMenu,
  expandedIds,
  onToggleExpanded,
  renderSubtree,
  divider = true,
}: {
  rows: readonly AgentLeadRow[];
  /** A hairline above (the pane decides: something visible precedes). */
  divider?: boolean;
  selectedSessionId?: string;
  onOpen(sessionId: string): void;
  onOpenMenu?(row: AgentLeadRow, point: { x: number; y: number }): void;
  /** Owners whose sub-agents show, and how a row's chevron changes that. */
  expandedIds?: ReadonlySet<string>;
  onToggleExpanded?(sessionId: string, expanded: boolean): void;
  /** The existing tree rows of a Lead's sub-agents. */
  renderSubtree?(sessionId: string): React.ReactNode;
}): React.ReactElement | null {
  // The rows no longer wear the Lead face, but mounting the page still loads it
  // (and moves a face this device kept locally to the host) for the approvals.
  useLeadAvatar();
  if (rows.length === 0) return null;
  return (
    <>
      {divider && <hr className="agent-chat-divider" aria-label={t('Leads')} />}
      <ul className="agent-contact-list" data-agent-section="leads" aria-label={t('Leads')}>
        {rows.map((row) => {
          const open = expandedIds?.has(row.sessionId) === true;
          return (
            <Fragment key={row.sessionId}>
              <li
                className={`agent-chat-row${row.sessionId === selectedSessionId ? ' selected' : ''}`}
                data-kind="contact"
                data-agent-lead={row.sessionId}
                {...subtreeRowAttr(row.hasSubAgents && Boolean(onToggleExpanded))}
                {...contextMenuRowProps((point) => onOpenMenu?.(row, point))}
              >
                {row.hasSubAgents && onToggleExpanded && (
                  <SubtreeToggle
                    expanded={open}
                    name={row.title}
                    onToggle={(next) => onToggleExpanded(row.sessionId, next)}
                  />
                )}
                <button
                  type="button"
                  className="agent-chat-row-main"
                  aria-current={row.sessionId === selectedSessionId ? 'page' : undefined}
                  aria-haspopup="menu"
                  aria-label={row.title}
                  onClick={(event) => {
                    // The plate is only the sub-agent toggle's place (CSS also lets
                    // pointers through it); the rest of the row opens the session.
                    if ((event.target as Element).closest('.agent-chat-avatar')) return;
                    onOpen(row.sessionId);
                  }}
                >
                  <span className="agent-chat-avatar">
                    {/* The provider's mark is the Lead's face: a tinted plate in the avatar box. */}
                    <span className="agent-lead-plate">
                      {row.provider ? <ProviderIcon provider={row.provider} /> : <Bot aria-hidden="true" />}
                    </span>
                  </span>
                  <span className="agent-chat-body agent-contact-body">
                    <b className="agent-chat-title">{row.title}</b>
                    <span className="agent-chat-preview">{row.preview}</span>
                    <span className="agent-contact-aside" data-has-status={row.kind === 'idle' ? undefined : 'true'}>
                      {row.at > 0 && <time className="agent-chat-time">{agentChatTimeLabel(row.at)}</time>}
                      {row.kind === 'running' && (
                        <span className="agent-chat-status" data-kind="running">
                          <ProgressSpinner size={14} aria-hidden="true" />
                          <span className="sr-only">{t('Working')}</span>
                        </span>
                      )}
                      {row.kind === 'attention' && (
                        <span className="agent-chat-status" data-kind="attention-mark">
                          <span aria-hidden="true">!</span>
                          <span className="sr-only">{t('Waiting for approval')}</span>
                        </span>
                      )}
                      {row.pinned && (
                        <span className="agent-lead-pin" data-lead-pin="true">
                          <Pin size={10} aria-hidden="true" />
                          <span className="sr-only">{t('Pinned')}</span>
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
              {open && row.hasSubAgents && renderSubtree && (
                <li className="agent-subtree" data-agent-subtree={row.sessionId}>
                  {renderSubtree(row.sessionId)}
                </li>
              )}
            </Fragment>
          );
        })}
      </ul>
    </>
  );
}
