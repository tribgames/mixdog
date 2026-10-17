import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';

/** Provider kinds the composer banner speaks to; only the first can be resumed at a reset. */
export type QuotaFailureKind = 'quota_exhausted' | 'entitlement' | 'billing';

export type QuotaFailure = {
  turnKey: string;
  kind: QuotaFailureKind;
  quota: { provider: string; model: string; resetAt: number | null };
};

const finiteTime = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** The failed turndone that ended the transcript on an exhausted provider
 *  quota, when no later turn has begun. */
export function latestQuotaFailure(items: readonly TranscriptItem[], turnKeys: readonly string[]): QuotaFailure | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'user') return null;
    if (item?.kind !== 'turndone') continue;
    const quota = item.quota as { provider?: unknown; model?: unknown; resetAt?: unknown } | null | undefined;
    if (String(item.status || '').toLowerCase() !== 'failed' || !quota || typeof quota.provider !== 'string') {
      return null;
    }
    const turnKey = turnKeys[index] || '';
    if (!turnKey) return null;
    // The persisted provider-kind descriptor decides; items without one
    // (older transcripts) are quota stops by their quota metadata alone.
    const descriptor = item.errorKind as { kind?: unknown; resetAt?: unknown } | null | undefined;
    const kind = descriptor && typeof descriptor.kind === 'string' ? descriptor.kind : 'quota_exhausted';
    if (kind !== 'quota_exhausted' && kind !== 'entitlement' && kind !== 'billing') return null;
    return {
      turnKey,
      kind,
      quota: {
        provider: quota.provider,
        model: typeof quota.model === 'string' ? quota.model : '',
        resetAt: finiteTime(quota.resetAt) ?? finiteTime(descriptor?.resetAt),
      },
    };
  }
  return null;
}

export const quotaDismissKey = (sessionId: string, turnKey: string) => `${sessionId}:${turnKey}`;

/** The panel shows for a quota failure of an idle session that the user has
 *  not dismissed for that turn. */
export function quotaPanelVisible(state: {
  failure: QuotaFailure | null;
  sessionId: string;
  busy: boolean;
  dismissedKey: string;
}): boolean {
  const { failure, sessionId, busy, dismissedKey } = state;
  if (!failure || !sessionId || busy || dismissedKey === quotaDismissKey(sessionId, failure.turnKey)) return false;
  return true;
}

/** Local HH:mm, prefixed with month/day when the reset is not today. */
export function quotaResetLabel(resetAt: number, now = Date.now()): string {
  const reset = new Date(resetAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(reset.getHours())}:${pad(reset.getMinutes())}`;
  return reset.toDateString() === new Date(now).toDateString()
    ? time
    : `${reset.getMonth() + 1}/${reset.getDate()} ${time}`;
}

/** Time left until `resetAt`, rounded up to whole minutes ("2h 15m"). */
export function quotaRemainingLabel(resetAt: number, now = Date.now()): string {
  const total = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours > 0 && minutes > 0) return t('{{hours}}h {{minutes}}m', { hours, minutes });
  if (hours > 0) return t('{{hours}}h', { hours });
  if (minutes > 0) return t('{{minutes}}m', { minutes });
  return t('Under 1m');
}
