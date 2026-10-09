import type { ComputerUseActivity, ComputerUseCursor, ComputerUseSnapshot } from '../session/coordinator';
import type { ComputerOverlayControlError } from './controls';

export interface ComputerUseOverlayPresentation {
  visible: boolean;
  /** Every agent session currently using the computer; stop ends all their turns. */
  sessionIds: string[];
  title: string;
  accent: string;
  paused: boolean;
  /** Paused by the user or the environment: the pill offers Resume next to Stop. */
  resumable: boolean;
  generation: number;
  attention: boolean;
}

export interface ComputerUseCursorPresentation extends ComputerUseCursor {
  accent: string;
  badge: string;
  context: string;
}

const SESSION_COLORS = ['#58a6ff', '#a371f7', '#3fb950', '#d29922', '#f778ba', '#39c5cf'];

function sessionColor(sessionId: string): string {
  let hash = 0;
  for (const character of sessionId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return SESSION_COLORS[hash % SESSION_COLORS.length] || SESSION_COLORS[0];
}

/** Which activity the banner speaks for; unlisted phases rank last. */
const ACTIVITY_PHASE_RANK: Partial<Record<ComputerUseActivity['phase'], number>> = {
  paused_user_takeover: 0,
  active_foreground: 1,
  active_background: 2,
  queued_foreground: 3,
  queued_target: 4,
};

function primaryActivity(activities: ComputerUseActivity[]): ComputerUseActivity | undefined {
  const rank = (activity: ComputerUseActivity): number => ACTIVITY_PHASE_RANK[activity.phase] ?? 5;
  return [...activities].sort((left, right) => rank(left) - rank(right))[0];
}

function shortSessionId(sessionId: string): string {
  const trimmed = String(sessionId || '');
  if (trimmed.length <= 12) return trimmed || 'session';
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

function visibleTarget(target: string): string {
  const value = String(target || '').trim();
  if (!value || /^hwnd:/i.test(value)) return '';
  return value.length > 24 ? `${value.slice(0, 23)}…` : value;
}

/** The pill's titles per state; the page starts with `working` and falls back to it. */
export function overlayTitles(locale: string) {
  const ko = locale.toLowerCase().startsWith('ko');
  return {
    working: ko ? '컴퓨터 사용 중' : 'Computer in use',
    attention: ko ? '확인 필요' : 'Check',
    paused: ko ? '대기 중' : 'Waiting',
  };
}

export function computerUseOverlayPresentation(
  snapshot: ComputerUseSnapshot,
  locale = 'en',
  control: { error?: ComputerOverlayControlError | string } = {}
): ComputerUseOverlayPresentation {
  const activity = primaryActivity(snapshot.activities);
  // Stop ends every session still in a turn that used the computer, including
  // one thinking between commands.
  const sessionIds = [
    ...new Set([
      ...(snapshot.pausedSessionIds ?? []),
      ...snapshot.activities.map((entry) => entry.sessionId),
      ...(snapshot.targetLeases ?? []).map((lease) => lease.sessionId),
      snapshot.attentionRequired?.sessionId || '',
    ]),
  ].filter(Boolean);
  // Three states only: working, paused (Resume or Stop), or gone. Stop closes
  // the pill with the press — the task ends and reports the failure itself —
  // and nothing outlives the work: a cleanup Stop could not confirm is retried
  // by the next command instead of holding an undismissable pill on screen.
  const stopping = snapshot.userControlActive && snapshot.takeoverReason === 'user_stop';
  // Input is blocked while the user holds control or a cleanup failure is
  // latched; the pill is then the way out, unless a Stop is still in flight
  // without an error.
  const inputBlocked = snapshot.userControlActive || snapshot.cleanupState === 'failed';
  const stopInFlight = stopping && !control.error;
  const paused = snapshot.userControlActive && (!stopping || Boolean(control.error));
  const attention = Boolean(snapshot.attentionRequired) || Boolean(control.error);
  // A command runs for a few hundred milliseconds, so a held target (the grace
  // period after the last command) keeps the controls reachable between
  // commands. Thinking right after a command is still the same task for the
  // grace period, but a turn that moved on to other work must not leave the
  // pill up until it ends. A pause lasts while any task it paused is still
  // waiting on it; one whose tasks all ended is not the user's to resolve.
  const working = (snapshot.presentSessionIds ?? []).length > 0;
  const holding = (snapshot.targetLeases ?? []).length > 0;
  const waiting = paused && (snapshot.pausedSessionIds ?? []).length > 0;
  const titles = overlayTitles(locale);
  let title = titles.working;
  if (attention) title = titles.attention;
  else if (paused) title = titles.paused;
  return {
    visible: !stopInFlight && (working || holding || waiting || Boolean(snapshot.attentionRequired) || inputBlocked),
    sessionIds,
    title,
    // Per-session colours only carry meaning while several agents work at once;
    // a lone session keeps the standard accent instead of a hash-picked one.
    accent: activity && snapshot.activities.length > 1 ? sessionColor(activity.sessionId) : SESSION_COLORS[0],
    paused,
    resumable: paused,
    generation: snapshot.takeoverGeneration ?? 0,
    attention,
  };
}

export function computerUseCursorPresentations(snapshot: ComputerUseSnapshot): ComputerUseCursorPresentation[] {
  if (snapshot.userControlActive) return [];
  const activityOrder = new Map(snapshot.activities.map((activity, index) => [activity.sessionId, index + 1]));
  const activityBySession = new Map(snapshot.activities.map((activity) => [activity.sessionId, activity]));
  return snapshot.cursors.flatMap((cursor) => {
    const activity = activityBySession.get(cursor.sessionId);
    if (!activity || activity.phase === 'paused_user_takeover' || activity.mode !== cursor.mode) return [];
    const ordinal = activityOrder.get(cursor.sessionId) || 1;
    const target = visibleTarget(activity.target);
    const multipleSessions = snapshot.activities.length > 1;
    const modeLabel = cursor.mode === 'foreground' ? 'Foreground' : 'Background';
    const ordinalPrefix = multipleSessions ? `${ordinal} · ` : '';
    return [
      {
        ...cursor,
        accent: multipleSessions ? sessionColor(cursor.sessionId) : SESSION_COLORS[0],
        badge: `${ordinalPrefix}${target || shortSessionId(cursor.sessionId)}`,
        context: multipleSessions ? modeLabel : '',
      },
    ];
  });
}
