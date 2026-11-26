import { useCallback, useEffect, useRef, useState } from 'react';
import { useMobileBack } from './mobile-back';
import { record } from './record-utils';
import { SUBSCRIPTIONS } from './subscription-providers';
import {
  publishUsageDashboard,
  refreshUsageDashboard,
  withUsageTimeout,
  type UsageApi,
  type UsageRecord,
} from './usage-dashboard-store';
import { subscriptionRow, usageNumber as number } from './usage-pin-entries';
import { usageTimestamp as timestamp } from './usage-window-text';
import { t } from './i18n';

const SIDEBAR_CODEX_RESET_ATTEMPT_KEY = 'mixdog.desktop.codex-reset-attempt.v1';
const SIDEBAR_CODEX_RESET_TIMEOUT_MS = 90_000;

function resetCreditKey(credit: UsageRecord, index: number): string {
  return String(
    credit.id ||
      credit.creditId ||
      (timestamp(credit.expiresAt) ? `expires:${timestamp(credit.expiresAt)}` : `credit:${index}`)
  );
}

function resetCredits(row: UsageRecord): UsageRecord {
  return record(row.resetCredits);
}

function availableResetCount(value: UsageRecord): number {
  return Math.max(0, Math.floor(number(value.availableCount) || 0));
}

function availableResetCredits(value: UsageRecord): UsageRecord[] {
  const availableCount = availableResetCount(value);
  const credits = (Array.isArray(value.availableCredits) ? value.availableCredits : [])
    .map(record)
    .sort(
      (left, right) =>
        (timestamp(left.expiresAt) ?? Number.POSITIVE_INFINITY) -
        (timestamp(right.expiresAt) ?? Number.POSITIVE_INFINITY)
    );
  while (credits.length < availableCount) credits.push({});
  return credits.slice(0, availableCount);
}

function createResetAttemptId(): string {
  const bytes = new Uint8Array(16);
  if (typeof window.crypto?.getRandomValues === 'function') {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function codexResetAttempt(offerRevision: string): string {
  try {
    const stored = record(JSON.parse(window.localStorage.getItem(SIDEBAR_CODEX_RESET_ATTEMPT_KEY) || 'null'));
    if (stored.offerRevision === offerRevision && typeof stored.idempotencyKey === 'string') {
      return stored.idempotencyKey;
    }
  } catch {
    // A corrupt retry record is replaced with a fresh scoped attempt below.
  }
  const idempotencyKey = createResetAttemptId();
  try {
    window.localStorage.setItem(
      SIDEBAR_CODEX_RESET_ATTEMPT_KEY,
      JSON.stringify({
        offerRevision,
        idempotencyKey,
      })
    );
  } catch {
    // In-memory completion remains safe for this window when storage is unavailable.
  }
  return idempotencyKey;
}

function resetOutcomeNotice(status: unknown, outcome: unknown): string {
  if (status === 'offerChanged') return t('Reset availability changed. Review the latest Codex usage.');
  if (outcome === 'reset') return '';
  if (outcome === 'alreadyRedeemed') return t('Reset already applied.');
  if (outcome === 'nothingToReset') return t('No eligible rate-limit window is exhausted.');
  return t('No reset credit is available.');
}

function clearCodexResetAttempt(offerRevision: string): void {
  try {
    const stored = record(JSON.parse(window.localStorage.getItem(SIDEBAR_CODEX_RESET_ATTEMPT_KEY) || 'null'));
    if (stored.offerRevision === offerRevision) {
      window.localStorage.removeItem(SIDEBAR_CODEX_RESET_ATTEMPT_KEY);
    }
  } catch {
    // The next attempt replaces an unreadable record.
  }
}

export function useCodexResetCredit(api: UsageApi, dashboard: unknown, sidebarOpen: boolean) {
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const credits = resetCredits(subscriptionRow(dashboard, SUBSCRIPTIONS[0]));
  const count = availableResetCount(credits);
  const rows = availableResetCredits(credits);
  const keys = rows.map(resetCreditKey);
  const keySignature = keys.join('\u0000');
  const offer = String(credits.offerRevision || '');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keySignature is the stable string form of keys, so the effect re-runs only when the key set changes
  useEffect(() => {
    if (confirmingKey && !keys.includes(confirmingKey)) {
      setConfirmingKey(null);
    }
  }, [keySignature, confirmingKey]);
  useMobileBack(confirmingKey !== null, () => {
    if (!resetting) setConfirmingKey(null);
  });
  useMobileBack(infoOpen, () => setInfoOpen(false));
  useEffect(() => {
    if (!sidebarOpen) setInfoOpen(false);
  }, [sidebarOpen]);
  const clear = useCallback(() => {
    setConfirmingKey(null);
    setNotice('');
  }, []);
  useEffect(() => {
    if (!infoOpen) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setInfoOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setInfoOpen(false);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [infoOpen]);
  const consume = async () => {
    if (!offer || count < 1 || resetting || typeof api?.invokeCapability !== 'function') return;
    const idempotencyKey = codexResetAttempt(offer);
    const readStartedAt = Date.now();
    setResetting(true);
    setNotice('');
    try {
      const response = await withUsageTimeout(
        api.invokeCapability({
          capability: 'consumeCodexRateLimitResetCredit',
          args: [
            {
              expectedOfferRevision: offer,
              idempotencyKey,
            },
          ],
        }),
        SIDEBAR_CODEX_RESET_TIMEOUT_MS,
        window
      );
      const result = record(response?.value);
      // Authoritative provider vocabulary (oauth-usage.mjs): every consume that
      // the runtime recognises carries one of these, plus a rebuilt dashboard.
      const outcome = String(result.outcome || '');
      const authoritative =
        result.status === 'offerChanged' ||
        outcome === 'reset' ||
        outcome === 'alreadyRedeemed' ||
        outcome === 'nothingToReset' ||
        outcome === 'noCredit';
      if (!authoritative) {
        // Unrecognised outcome: the durable idempotency key SURVIVES so a retry
        // reuses this operation instead of spending a second credit, and the
        // surface says so.
        setNotice(t('Reset could not be confirmed. Retrying is safe.'));
        return;
      }
      if (!publishUsageDashboard(result.dashboard, { readStartedAt, providers: [SUBSCRIPTIONS[0].provider] })) {
        void refreshUsageDashboard(api, { force: true });
      }
      clearCodexResetAttempt(offer);
      setConfirmingKey(null);
      setNotice(resetOutcomeNotice(result.status, outcome));
    } catch (cause) {
      // Keep the durable idempotency key: retrying an unknown provider outcome
      // must reuse the same operation rather than spend a second credit.
      console.error('Codex reset-credit consume failed:', cause);
      const reason = cause instanceof Error && cause.message ? cause.message.trim() : '';
      setNotice(
        reason
          ? t('Reset could not be confirmed ({{reason}}). Retrying is safe.', { reason })
          : t('Reset could not be confirmed. Retrying is safe.')
      );
    } finally {
      setResetting(false);
    }
  };
  return {
    offer,
    count,
    rows,
    keys,
    containerRef,
    infoOpen,
    confirming: confirmingKey !== null,
    resetting,
    notice,
    toggleInfo: () => setInfoOpen((open) => !open),
    ask: () => setConfirmingKey(keys[0] ?? null),
    cancel: () => setConfirmingKey(null),
    clear,
    consume,
  };
}
