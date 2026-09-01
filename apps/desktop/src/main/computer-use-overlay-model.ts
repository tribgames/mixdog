import type {
  ComputerUseActivity,
  ComputerUseCursor,
  ComputerUseSnapshot,
} from './computer-use-coordinator';

export interface ComputerUseOverlayPresentation {
  state: 'hidden' | 'in_use' | 'user_control' | 'attention_required';
  visible: boolean;
  interactive: boolean;
  sessionId: string;
  sessionLabel: string;
  title: string;
  chips: string[];
  accent: string;
  showTakeover: boolean;
  showResume: boolean;
  showStopSession: boolean;
  showStopAll: boolean;
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
  const sessionId = activity?.sessionId || '';
  const queueCount = snapshot.activities.filter((entry) => (
    entry.phase === 'queued_foreground' || entry.phase === 'queued_target'
  )).length;
  if (snapshot.attentionRequired) {
    const attentionSessionId = snapshot.attentionRequired.sessionId || sessionId;
    return {
      state: 'attention_required',
      visible: true,
      interactive: true,
      sessionId: attentionSessionId,
      sessionLabel: shortSessionId(attentionSessionId),
      title: ko ? '확인 필요' : 'Action required',
      chips: [
        snapshot.attentionRequired.detail
          || (ko ? 'Computer Use에 사용자 판단이 필요합니다.' : 'Computer Use needs your input.'),
      ],
      accent: '#f85149',
      showTakeover: false,
      showResume: false,
      showStopSession: Boolean(attentionSessionId),
      showStopAll: snapshot.activities.length > 0,
    };
  }
  if (snapshot.userControlActive) {
    return {
      state: 'user_control',
      visible: true,
      interactive: true,
      sessionId,
      sessionLabel: shortSessionId(sessionId),
      title: ko ? '사용자가 제어 중' : 'You have control',
      chips: [
        ko
          ? `${snapshot.activities.length}개 작업 일시정지`
          : `${snapshot.activities.length} session${snapshot.activities.length === 1 ? '' : 's'} paused`,
      ],
      accent: '#f0b429',
      showTakeover: false,
      showResume: true,
      showStopSession: Boolean(sessionId),
      showStopAll: snapshot.activities.length > 0,
    };
  }
  if (!activity) {
    return {
      state: 'hidden',
      visible: false,
      interactive: false,
      sessionId: '',
      sessionLabel: '',
      title: '',
      chips: [],
      accent: SESSION_COLORS[0],
      showTakeover: false,
      showResume: false,
      showStopSession: false,
      showStopAll: false,
    };
  }
  const target = visibleTarget(activity.target);
  const foreground = activity.phase === 'active_foreground';
  const chips = [
    target,
    activity.mode === 'foreground' ? 'Foreground' : 'Background',
    snapshot.activities.length > 1
      ? (ko ? `${snapshot.activities.length}개 세션` : `${snapshot.activities.length} sessions`)
      : '',
    queueCount > 0 ? (ko ? `대기 ${queueCount}` : `${queueCount} queued`) : '',
  ].filter(Boolean);
  return {
    state: 'in_use',
    visible: true,
    // Foreground pointer input must pass through the overlay. The global
    // takeover shortcut remains available while the banner is click-through.
    interactive: !foreground,
    sessionId: activity.sessionId,
    sessionLabel: shortSessionId(activity.sessionId),
    title: ko ? 'Mixdog 사용 중' : 'Mixdog in use',
    chips,
    accent: sessionColor(activity.sessionId),
    showTakeover: !foreground,
    showResume: false,
    showStopSession: !foreground,
    showStopAll: !foreground && snapshot.activities.length > 1,
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
