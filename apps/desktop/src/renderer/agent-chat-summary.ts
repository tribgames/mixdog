// What a contact row says about the work in its home thread, and the shared
// row name and compact time, built only from state the pool and the recent
// list already publish.
import {
  desktopAgentActivityState,
  hasPendingDesktopAgentWork,
  type DesktopAgentActivityState,
} from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { agentRoleLabel, flattenAgentActivityNodes, type AgentActivityNode } from './agent-activity-model';
import { t, uiFormatLocale } from './i18n';
import { timeFormatOptions } from './time-format-preference';

/** The ONE trailing status of a row, strongest first: blocked on the user,
 *  failed, working, unread. Done-and-read shows nothing. */
export type AgentChatIndicator =
  | { kind: 'attention' }
  | { kind: 'error' }
  | { kind: 'running' }
  | { kind: 'unread'; count: number }
  | null;

const WORKING_STATES: ReadonlySet<DesktopAgentActivityState> = new Set(['running', 'queued', 'waiting']);

/** One node's lifecycle exactly as its own row paints it. */
function agentNodeState(node: AgentActivityNode, unreadSessionIds?: ReadonlySet<string>) {
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

/** A Lead group's ONE status for the contact row that owns it: a member
 *  blocked on the user, then a failure, then work in progress, then the
 *  owner's own unread reply (a member's result reaches the user through it). */
export function agentGroupIndicator(
  ownerId: string,
  nodes: readonly AgentActivityNode[],
  unreadSessionIds?: ReadonlySet<string>
): AgentChatIndicator {
  const states = flattenAgentActivityNodes(nodes).map(
    (node) => [node, agentNodeState(node, unreadSessionIds)] as const
  );
  if (states.some(([, state]) => state === 'needs-user')) return { kind: 'attention' };
  if (states.some(([, state]) => state === 'failed')) return { kind: 'error' };
  if (states.some(([, state]) => WORKING_STATES.has(state))) return { kind: 'running' };
  return unreadSessionIds?.has(ownerId) ? { kind: 'unread', count: 1 } : null;
}

/** The compact labels a row's time column must hold in `locale`, widest
 *  candidates of each kind: a two-digit afternoon clock, "Yesterday", and a
 *  two-digit month and day. Older numeric dates are the rare case: they wrap. */
export function agentChatTimeColumnLabels(locale = uiFormatLocale()): string[] {
  const clock = (hour: number) =>
    new Date(2026, 11, 28, hour, 59).toLocaleTimeString(locale, {
      hour: 'numeric',
      minute: '2-digit',
      ...timeFormatOptions(),
    });
  return [
    clock(12),
    clock(23),
    clock(10),
    t('Yesterday'),
    new Date(2026, 11, 28).toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
    new Date(2026, 8, 28).toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
  ];
}

let measuredLocale = '';
/** Sizes the rows' time column (10-rail-pages.css `--agent-contact-side`) to
 *  the widest compact label of the current locale, in em of the time's own
 *  font size, with tabular figures: published once per locale on :root. */
function publishTimeColumnWidth(): void {
  const locale = uiFormatLocale();
  if (locale === measuredLocale || typeof document === 'undefined') return;
  const context = document.createElement('canvas').getContext?.('2d');
  if (!context) return;
  measuredLocale = locale;
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  context.font = `400 100px ${family}`;
  // Tabular figures: every digit takes the widest digit's advance.
  const digit = Math.max(...'0123456789'.split('').map((d) => context.measureText(d).width));
  const width = Math.max(
    ...agentChatTimeColumnLabels(locale).map((label) =>
      [...label].reduce((sum, ch) => sum + (/\d/.test(ch) ? digit : context.measureText(ch).width), 0)
    )
  );
  document.documentElement.style.setProperty('--agent-contact-time-ems', (width / 100 + 0.2).toFixed(3));
}

/** Messenger-list time in the UI locale: the clock today ("오후 2:08"),
 *  "Yesterday", month and day earlier this year ("10월 17일", "Oct 17"), and
 *  the full numeric date before that ("2025. 10. 17."). The month is the
 *  short form: the long one overflows the row's time column in most locales. */
export function agentChatTimeLabel(at: number, now = Date.now()): string {
  if (!at) return '';
  publishTimeColumnWidth();
  const date = new Date(at);
  const today = new Date(now);
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((day(today) - day(date)) / 86_400_000);
  const locale = uiFormatLocale();
  if (diff <= 0) return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', ...timeFormatOptions() });
  if (diff === 1) return t('Yesterday');
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'numeric', day: 'numeric' });
}
