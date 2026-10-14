import type { DesktopModelSelection } from '../shared/contract';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { requestOpenModelPicker } from './model-picker-event';

export type QuotaFailure = {
  turnKey: string;
  quota: { provider: string; model: string; resetAt: number | null };
};

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
    return {
      turnKey,
      quota: {
        provider: quota.provider,
        model: typeof quota.model === 'string' ? quota.model : '',
        resetAt: typeof quota.resetAt === 'number' && Number.isFinite(quota.resetAt) ? quota.resetAt : null,
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
  return Boolean(failure && sessionId && !busy && dismissedKey !== quotaDismissKey(sessionId, failure.turnKey));
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

type PendingContinue = { sessionId: string; onApplied(selection: DesktopModelSelection): void };
let pending: PendingContinue | null = null;

/** Opens the composer's model picker. The next explicit model selection for
 *  `sessionId` applies to the chat as usual (in place), and once another
 *  model is applied `onApplied` runs. False when no picker answered. */
export function beginQuotaContinue(sessionId: string, onApplied: (selection: DesktopModelSelection) => void): boolean {
  pending = { sessionId, onApplied };
  if (requestOpenModelPicker()) return true;
  pending = null;
  return false;
}

/** Claims the pending continue for an explicit model selection. */
export function takeQuotaContinue(sessionId: string): ((selection: DesktopModelSelection) => void) | null {
  if (!pending || pending.sessionId !== sessionId) return null;
  const { onApplied } = pending;
  pending = null;
  return onApplied;
}

/** The picker closed without a selection. */
export function cancelQuotaContinue(sessionId: string): void {
  if (pending?.sessionId === sessionId) pending = null;
}
