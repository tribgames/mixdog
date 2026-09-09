import type {
  ComputerUseActivity,
  ComputerUseCursor,
  ComputerUseSnapshot,
} from '../session/coordinator';
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
  detail: string;
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
  control: { busy?: boolean; error?: ComputerOverlayControlError | string } = {},
): ComputerUseOverlayPresentation {
  const ko = locale.toLowerCase().startsWith('ko');
  const activity = primaryActivity(snapshot.activities);
  const sessionIds = [...new Set([
    ...(snapshot.pausedSessionIds ?? []),
    ...snapshot.activities.map((entry) => entry.sessionId),
    snapshot.attentionRequired?.sessionId || '',
  ])].filter(Boolean);
  const paused = snapshot.userControlActive;
  const pending = snapshot.cleanupState === 'pending';
  const failed = snapshot.cleanupState === 'failed' || control.error === 'cleanup';
  const confirmation = failed || Boolean(snapshot.attentionRequired) || Boolean(control.error)
    || ['input_observation_unavailable', 'input_recovery_unconfirmed', 'input_cleanup_unconfirmed'].includes(snapshot.takeoverReason || '');
  const detail = failed
    ? (ko ? '입력 정리를 확인하지 못했습니다. 재개할 수 없습니다.' : 'Input cleanup is unconfirmed. Resume is blocked.')
    : control.error === 'stale'
      ? (ko ? '상태가 바뀌었습니다. 현재 재개 버튼을 사용해 주세요.' : 'State changed. Use the current Resume button.')
      : control.error
        ? (ko ? '요청을 완료하지 못했습니다.' : 'The request could not be completed.')
        : pending
          ? (ko ? '입력 해제와 작업 종료를 확인하고 있습니다.' : 'Waiting for input release and worker exit.')
          : control.busy
            ? (ko ? '재개 요청을 처리하고 있습니다. 중단은 언제든 가능합니다.' : 'Processing resume. Stop remains available.')
          : paused && snapshot.takeoverReason === 'user_input_active' && (snapshot.idleResumeSeconds ?? 5) > 0
            ? (ko ? `입력이 멈춘 뒤 ${snapshot.idleResumeRemaining ?? snapshot.idleResumeSeconds ?? 5}초 후 재개합니다.`
              : `Resuming after ${snapshot.idleResumeRemaining ?? snapshot.idleResumeSeconds ?? 5}s without input.`)
          : confirmation
            ? (ko ? '입력 복구를 확인하지 못해 자동 재개를 차단했습니다. 상태를 확인해 주세요.' : 'Input recovery is unconfirmed. Automatic resume is blocked; check the current state.')
          : paused && snapshot.takeoverReason === 'user_stop'
            ? (ko ? '사용자가 중지했습니다. 자동 재개하지 않습니다. 재개 버튼을 누르면 새 화면부터 확인합니다.'
               : 'Stopped by the user. Automatic resume is disabled. Resume checks a fresh screen.')
          : paused
            ? (ko ? '일시중지했습니다. 재개하면 새 화면을 확인하고 대기 작업을 이어갑니다.' : 'Paused. Resume checks fresh state before continuing queued work.')
            : '';
  return {
    // A pending cleanup with no session, pause, or failure behind it is a
    // no-op release (idle worker reap, deferred session release) and stays
    // hidden; a failed cleanup always surfaces.
    visible: sessionIds.length > 0 || paused || failed,
    sessionIds,
    title: confirmation ? (ko ? '확인 필요' : 'Confirmation needed')
      : paused && snapshot.takeoverReason === 'user_stop' ? (ko ? '중지됨' : 'Stopped')
      : paused ? (ko ? '사용자 조작 중' : 'User controlling')
      : (ko ? 'Mixdog 사용 중' : 'Mixdog using'),
    accent: activity ? sessionColor(activity.sessionId) : SESSION_COLORS[0],
    paused, canResume: paused && !pending && !failed,
    generation: snapshot.takeoverGeneration ?? 0, detail, busy: control.busy === true,
    idleResumeSeconds: snapshot.idleResumeSeconds ?? 5,
    attention: confirmation,
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
    if (!activity || activity.phase === 'paused_user_takeover'
      || activity.mode !== 'foreground' || cursor.mode !== 'foreground') return [];
    const ordinal = activityOrder.get(cursor.sessionId) || 1;
    const target = visibleTarget(activity.target);
    const multipleSessions = snapshot.activities.length > 1;
    return [{
      ...cursor,
      accent: sessionColor(cursor.sessionId),
      badge: `${multipleSessions ? `${ordinal} · ` : ''}${target || shortSessionId(cursor.sessionId)}`,
      context: multipleSessions ? 'Foreground' : '',
    }];
  });
}
