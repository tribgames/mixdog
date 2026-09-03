import type {
  ComputerUseActivity,
  ComputerUseCursor,
  ComputerUseSnapshot,
} from '../session/coordinator';

export interface ComputerUseOverlayPresentation {
  visible: boolean;
  /** Every agent session currently using the computer; stop ends all their turns. */
  sessionIds: string[];
  title: string;
  accent: string;
}

export interface ComputerUseCursorPresentation extends ComputerUseCursor {
  accent: string;
  badge: string;
  context: string;
}

export const SESSION_COLORS = ['#58a6ff', '#a371f7', '#3fb950', '#d29922', '#f778ba', '#39c5cf'];

export function sessionColor(sessionId: string): string {
  let hash = 0;
  for (const character of sessionId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return SESSION_COLORS[hash % SESSION_COLORS.length] || SESSION_COLORS[0];
}

function primaryActivity(activities: ComputerUseActivity[]): ComputerUseActivity | undefined {
  const rank = (activity: ComputerUseActivity): number => {
    if (activity.phase === 'paused_user_takeover') return 0;
    if (activity.phase === 'active_foreground') return 1;
    if (activity.phase === 'active_background') return 2;
    if (activity.phase === 'queued_foreground') return 3;
    if (activity.phase === 'queued_target') return 4;
    return 5;
  };
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
): ComputerUseOverlayPresentation {
  const ko = locale.toLowerCase().startsWith('ko');
  const activity = primaryActivity(snapshot.activities);
  const sessionIds = [...new Set([
    ...snapshot.activities.map((entry) => entry.sessionId),
    snapshot.attentionRequired?.sessionId || '',
  ])].filter(Boolean);
  if (sessionIds.length === 0) {
    return { visible: false, sessionIds: [], title: '', accent: SESSION_COLORS[0] };
  }
  return {
    visible: true,
    sessionIds,
    title: ko ? '컴퓨터 사용 중' : 'Computer in use',
    accent: activity ? sessionColor(activity.sessionId) : SESSION_COLORS[0],
  };
}

export function computerUseCursorPresentations(
  snapshot: ComputerUseSnapshot,
): ComputerUseCursorPresentation[] {
  if (snapshot.userControlActive) return [];
  const activityOrder = new Map(
    snapshot.activities.map((activity, index) => [activity.sessionId, index + 1]),
  );
  const activityBySession = new Map(
    snapshot.activities.map((activity) => [activity.sessionId, activity]),
  );
  return snapshot.cursors.flatMap((cursor) => {
    const activity = activityBySession.get(cursor.sessionId);
    if (!activity || activity.phase === 'paused_user_takeover') return [];
    const ordinal = activityOrder.get(cursor.sessionId) || 1;
    const target = visibleTarget(activity.target);
    const multipleSessions = snapshot.activities.length > 1;
    return [{
      ...cursor,
      accent: sessionColor(cursor.sessionId),
      badge: `${multipleSessions ? `${ordinal} · ` : ''}${target || shortSessionId(cursor.sessionId)}`,
      context: cursor.mode === 'background'
        ? 'Background'
        : (multipleSessions ? 'Foreground' : ''),
    }];
  });
}
