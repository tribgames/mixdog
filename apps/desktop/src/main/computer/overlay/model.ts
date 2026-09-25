import type { ComputerUseActivity, ComputerUseCursor, ComputerUseSnapshot } from '../session/coordinator';
import type { ComputerOverlayControlError } from './controls';

export interface ComputerUseOverlayPresentation {
  visible: boolean;
  /** Every agent session currently using the computer; stop ends all their turns. */
  sessionIds: string[];
  title: string;
  accent: string;
  paused: boolean;
  canResume: boolean;
  generation: number;
  busy: boolean;
  idleResumeSeconds: number;
  attention: boolean;
}

export interface ComputerUseCursorPresentation extends ComputerUseCursor {
  accent: string;
  badge: string;
  context: string;
}

export const SESSION_COLORS = ['#58a6ff', '#a371f7', '#3fb950', '#d29922', '#f778ba', '#39c5cf'];

export function sessionColor(sessionId: string): string {
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

export function computerUseOverlayPresentation(
  snapshot: ComputerUseSnapshot,
  locale = 'en',
  control: { busy?: boolean; error?: ComputerOverlayControlError | string } = {}
): ComputerUseOverlayPresentation {
  const ko = locale.toLowerCase().startsWith('ko');
  const activity = primaryActivity(snapshot.activities);
  // A command runs for a few hundred milliseconds, but the session keeps the
  // user's window between commands. Showing the banner only while a command is
  // in flight leaves nothing on screen at the moment the user reaches for Pause
  // or Stop, so a held target keeps the controls reachable for its whole hold.
  const sessionIds = [
    ...new Set([
      ...(snapshot.pausedSessionIds ?? []),
      ...snapshot.activities.map((entry) => entry.sessionId),
      ...(snapshot.targetLeases ?? []).map((lease) => lease.sessionId),
      snapshot.attentionRequired?.sessionId || '',
    ]),
  ].filter(Boolean);
  const paused = snapshot.userControlActive;
  const pending = snapshot.cleanupState === 'pending';
  const failed = snapshot.cleanupState === 'failed' || control.error === 'cleanup';
  const confirmation =
    failed ||
    Boolean(snapshot.attentionRequired) ||
    Boolean(control.error) ||
    ['input_observation_unavailable', 'input_recovery_unconfirmed', 'input_cleanup_unconfirmed'].includes(
      snapshot.takeoverReason || ''
    );
  let title = ko ? '컴퓨터 사용 중' : 'Computer in use';
  if (confirmation) title = ko ? '확인 필요' : 'Check';
  else if (paused && snapshot.takeoverReason === 'user_stop') title = ko ? '중지 중' : 'Stopping';
  else if (paused) title = ko ? '일시정지' : 'Paused';
  return {
    // A pending cleanup with no session, pause, or failure behind it is a
    // no-op release (idle worker reap, deferred session release) and stays
    // hidden; a failed cleanup always surfaces.
    visible: sessionIds.length > 0 || paused || failed,
    sessionIds,
    title,
    // Per-session colours only carry meaning while several agents work at once;
    // a lone session keeps the standard accent instead of a hash-picked one.
    accent: activity && snapshot.activities.length > 1 ? sessionColor(activity.sessionId) : SESSION_COLORS[0],
    paused,
    canResume: paused && !pending && !failed && control.error !== 'stop',
    generation: snapshot.takeoverGeneration ?? 0,
    busy: control.busy === true,
    idleResumeSeconds: snapshot.idleResumeSeconds ?? 5,
    attention: confirmation,
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
