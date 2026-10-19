// The messenger-style Agents list: what one row says about its session, built
// only from state the pool and the recent list already publish.
import {
  desktopAgentActivityState,
  desktopAgentFailureReason,
  hasPendingDesktopAgentWork,
  type DesktopAgentActivityState,
} from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { agentRoleLabel, flattenAgentActivityNodes, type AgentActivityNode } from './agent-activity-model';
import { agentElapsedText } from './agent-row-meta';
import { t, uiFormatLocale } from './i18n';
import { uiTimeUnit } from './ui-format';

/** The ONE trailing status of a row, strongest first: blocked on the user,
 *  failed, working, unread. Done-and-read shows nothing. */
export type AgentChatIndicator =
  | { kind: 'attention' }
  | { kind: 'error' }
  | { kind: 'running' }
  | { kind: 'unread'; count: number }
  | null;

export interface AgentChatSummary {
  /** The lifecycle the preview names (the Lead's, unless a member needs the
   *  user or failed). */
  state: DesktopAgentActivityState;
  /** The preview's state words. */
  stateText: string;
  /** The whole preview line. */
  preview: string;
  indicator: AgentChatIndicator;
  /** Every agent of the group below the Lead. */
  memberCount: number;
}

const WORKING_STATES: ReadonlySet<DesktopAgentActivityState> = new Set(['running', 'queued', 'waiting']);
/** A Lead-less group reads as its busiest member. */
const MEMBER_STATE_ORDER: readonly DesktopAgentActivityState[] = [
  'running',
  'waiting',
  'queued',
  'cancel-unconfirmed',
  'unknown',
  'done',
  'cancelled',
  'idle',
];

/** One node's lifecycle exactly as its own row paints it. */
export function agentNodeState(node: AgentActivityNode, unreadSessionIds?: ReadonlySet<string>) {
  return desktopAgentActivityState(node.agent, {
    unread: unreadSessionIds?.has(node.sessionId) === true,
    waitingForTasks: flattenAgentActivityNodes(node.children).some(({ agent }) => hasPendingDesktopAgentWork(agent)),
  });
}

/** An agent row's name: its role, plus its tag when the tag says more. */
export function agentRowName(agent: DesktopAgentPoolRow, lead: boolean): string {
  const role = agentRoleLabel(agent.agent || agent.tag);
  const tag = String(agent.tag || '').trim();
  return !lead && tag && tag.toLowerCase() !== role.toLowerCase() ? `${role} · ${tag}` : role;
}

/** Why a failed agent failed, in words. */
export function agentFailureText(agent: DesktopAgentPoolRow): string {
  const reason = desktopAgentFailureReason(agent);
  if (reason === 'process-restart') return t('Interrupted by app restart');
  if (reason === 'stalled') return t('Stopped: no progress');
  return t('Failed');
}

function agentStateWords(state: DesktopAgentActivityState, agent: DesktopAgentPoolRow): string {
  if (state === 'running') return t('Working');
  if (state === 'waiting') return t('Waiting for tasks');
  if (state === 'failed') return agentFailureText(agent);
  // Every other state is clock-free words.
  return agentElapsedText(state, agent, 0);
}

export function agentSessionChatSummary(
  ownerId: string,
  nodes: readonly AgentActivityNode[],
  unreadSessionIds?: ReadonlySet<string>
): AgentChatSummary {
  const all = flattenAgentActivityNodes(nodes);
  const lead = all.find((node) => node.sessionId === ownerId);
  const members = all.filter((node) => node.sessionId !== ownerId);
  const states = new Map(all.map((node) => [node, agentNodeState(node, unreadSessionIds)]));
  const stateOf = (node: AgentActivityNode) => states.get(node) ?? 'unknown';
  const about = (node: AgentActivityNode, text: string) =>
    node === lead ? text : `${agentRowName(node.agent, false)} · ${text}`;
  const attention = all.find((node) => stateOf(node) === 'needs-user');
  const failed = all.find((node) => stateOf(node) === 'failed');
  const workingMembers = members.filter((node) => WORKING_STATES.has(stateOf(node)));
  let state: DesktopAgentActivityState;
  let stateText: string;
  if (attention) {
    state = 'needs-user';
    stateText = about(attention, t('Waiting for approval'));
  } else if (failed) {
    state = 'failed';
    stateText = about(failed, agentFailureText(failed.agent));
  } else if (lead) {
    state = stateOf(lead);
    stateText = agentStateWords(state, lead.agent);
  } else {
    const busiest =
      MEMBER_STATE_ORDER.map((candidate) => members.find((node) => stateOf(node) === candidate)).find(Boolean) ??
      members[0];
    state = busiest ? stateOf(busiest) : 'idle';
    stateText = busiest ? agentStateWords(state, busiest.agent) : t('Idle');
  }
  // The group's size rides the preview, unless the preview already names the
  // one member it is about.
  const preview =
    members.length > 0 && !attention && !failed
      ? `${stateText} · ${t('{{count}} agents', { count: members.length })}`
      : stateText;
  const unreadCount = new Set(
    [ownerId, ...members.map((node) => node.sessionId)].filter((id) => unreadSessionIds?.has(id))
  ).size;
  let indicator: AgentChatIndicator = null;
  if (attention) indicator = { kind: 'attention' };
  else if (failed) indicator = { kind: 'error' };
  else if ((lead && WORKING_STATES.has(stateOf(lead))) || workingMembers.length > 0) indicator = { kind: 'running' };
  else if (unreadCount > 0) indicator = { kind: 'unread', count: unreadCount };
  return { state, stateText, preview, indicator, memberCount: members.length };
}

/** Messenger-list time, compact: "11:04" today, "Yesterday", else "10/17". */
export function agentChatTimeLabel(at: number, now = Date.now()): string {
  if (!at) return '';
  const date = new Date(at);
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((day(new Date(now)) - day(date)) / 86_400_000);
  if (diff <= 0) {
    return date.toLocaleTimeString(uiFormatLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  if (diff === 1) return t('Yesterday');
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** A running turn's elapsed in its largest unit only: "2m", "1h"; seconds
 *  only before the first minute. */
export function agentChatElapsed(elapsedMs: number): string {
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed >= 86_400_000) return uiTimeUnit(Math.floor(elapsed / 86_400_000), 'day');
  if (elapsed >= 3_600_000) return uiTimeUnit(Math.floor(elapsed / 3_600_000), 'hour');
  if (elapsed >= 60_000) return uiTimeUnit(Math.floor(elapsed / 60_000), 'minute');
  return uiTimeUnit(Math.floor(elapsed / 1_000), 'second');
}
