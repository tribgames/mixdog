import { Info, Plus } from 'lucide-react';
import { RailPinIcon } from './RailPinIcon';
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { invalidateSidebarReferenceForMutation } from './sidebar-reference-cache';

import { PaneSurfaceGate } from './PaneSurfaceGate';
import { InitialSurface } from './InitialSurface';
import { t } from './i18n';
import { ProviderIcon } from './provider-display';
import { record } from './record-utils';
import {
  getUsageDashboardSnapshot,
  holdUsageDashboardCadence,
  publishUsageDashboard,
  refreshUsageDashboard,
  subscribeUsageDashboard,
  withUsageTimeout,
  type UsageApi,
  type UsageRecord,
} from './usage-dashboard-store';
import { displayUsagePercent, usageToneClass } from './usage-percent';
import { formatUsageResetRemaining, usageResetPresentation } from './usage-reset-time';
import { useUsageResetVerification } from './use-usage-reset-verification';
import { ProviderAccountPicker } from './ProviderAccountPicker';
import { focusQuotaUsage } from './usage-surface-mode';
import { prefetchQuotaUsage } from './quota-usage-cache';
import { SUBSCRIPTIONS, type Subscription } from './subscription-providers';

const SIDEBAR_CODEX_RESET_ATTEMPT_KEY = 'mixdog.desktop.codex-reset-attempt.v1';
const SIDEBAR_CODEX_RESET_TIMEOUT_MS = 90_000;

function rows(value: unknown): UsageRecord[] {
  const dashboard = record(value);
  return Array.isArray(dashboard.rows) ? dashboard.rows.map(record) : [];
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(parsed) ? null : parsed;
}

function timestamp(value: unknown): number | null {
  const parsed = number(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
}

function subscriptionRow(dashboard: unknown, subscription: Subscription): UsageRecord {
  return (
    rows(dashboard).find((row) => {
      const id = String(row.id || '').toLowerCase();
      const label = String(row.label || '').toLowerCase();
      const group = String(row.group || '').toLowerCase();
      if (subscription.key === 'opencode-go') {
        return id === 'opencode-go' || label.includes('opencode go');
      }
      if (subscription.key === 'cursor') {
        return id === 'cursor-oauth' || label.includes('cursor oauth');
      }
      if (subscription.key === 'antigravity') {
        return id === 'antigravity-oauth' || label.includes('antigravity');
      }
      if (group !== 'oauth') return false;
      if (subscription.key === 'codex') return /openai|codex/.test(`${id} ${label}`);
      if (subscription.key === 'claude') return /anthropic|claude/.test(`${id} ${label}`);
      return /grok|xai/.test(`${id} ${label}`);
    }) || {}
  );
}

function quotaWindows(row: UsageRecord): UsageRecord[] {
  return Array.isArray(row.windows) ? row.windows.map(record) : [];
}

function quotaWindowKey(window: UsageRecord, index: number): string {
  return String(window.id || window.window || window.period || window.label || `window:${index}`);
}

function resetCreditKey(credit: UsageRecord, index: number): string {
  return String(
    credit.id ||
      credit.creditId ||
      (timestamp(credit.expiresAt) ? `expires:${timestamp(credit.expiresAt)}` : `credit:${index}`)
  );
}

function subscriptionConnected(row: UsageRecord): boolean {
  return row.authenticated === true || quotaWindows(row).length > 0;
}

function windowLabel(window: UsageRecord): string {
  const label = String(window.label || 'Quota').trim();
  if (/^(?:w|wk|week|weekly)$/i.test(label)) return 'W';
  if (/^(?:mo|mon|month|monthly)$/i.test(label)) return 'M';
  if (/^flsh$/i.test(label)) return 'FLASH';
  return label.toUpperCase();
}

function usedPercent(window: UsageRecord): number | null {
  const value = number(window.usedPct);
  return value === null ? null : Math.max(0, Math.min(100, value));
}

/** Rail pin mode (user: 핀모드): one entry per brand that has quota data —
 *  its icon plus the final quota window's usage, picked by longest period:
 *  monthly (M) → weekly (7D/W) → daily/hourly. Unknown windows fall back to
 *  the provider's final entry. */
interface UsagePinEntry {
  key: string;
  label: string;
  provider: string;
  percent: number;
}

const PIN_WINDOW_PRIORITY = [
  /^(?:M|MO|MON|MONTH|MONTHLY)$/i,
  /^(?:7D|W|WK|WEEK|WEEKLY)$/i,
  /^(?:\d+H|\d+D|D|DAY|DAILY)$/i,
];

function pinPercent(windows: UsageRecord[], provider: string): number | null {
  const candidates = windows.flatMap((window) => {
    const percent = usedPercent(window);
    return percent === null ? [] : [{ label: String(window.label || '').trim(), percent }];
  });
  if (!candidates.length) return null;
  const preferredLabel = provider === 'cursor-oauth' ? 'Basic' : '';
  if (preferredLabel) {
    const preferred = candidates.find((candidate) => candidate.label.toLowerCase() === preferredLabel.toLowerCase());
    if (preferred) return preferred.percent;
  }
  for (const pattern of PIN_WINDOW_PRIORITY) {
    const hit = candidates.find((candidate) => pattern.test(candidate.label));
    if (hit) return hit.percent;
  }
  return candidates[candidates.length - 1].percent;
}

export function usagePinEntries(dashboard: unknown): UsagePinEntry[] {
  return SUBSCRIPTIONS.flatMap((subscription) => {
    const percent = pinPercent(quotaWindows(subscriptionRow(dashboard, subscription)), subscription.provider);
    if (percent === null) return [];
    return [
      {
        key: subscription.key,
        label: subscription.label,
        provider: subscription.provider,
        percent,
      },
    ];
  });
}

// Tidied schedule copy (user: 리셋시간 문구 정리): lowercase duration units
// read as time, not as quota-window labels (5H/W/M stay uppercase).
function resetSchedule(value: unknown): { state: 'due' | 'soon' | 'in' | ''; time: string } {
  const resetAt = timestamp(value);
  if (resetAt === null) return { state: '', time: '' };
  const remaining = resetAt - Date.now();
  if (remaining <= 0) return { state: 'due', time: '' };
  const time = formatUsageResetRemaining(remaining);
  return time ? { state: 'in', time } : { state: 'soon', time: '' };
}

function resetText(value: unknown): string {
  const schedule = resetSchedule(value);
  if (schedule.state === 'due') return t('Reset due');
  if (schedule.state === 'in') return t('Resets in {{time}}', { time: schedule.time });
  return schedule.state === 'soon' ? t('Resets soon') : '';
}

function resetExpiryText(value: unknown): string {
  const schedule = resetSchedule(value);
  if (schedule.state === 'due') return t('Expiry due');
  if (schedule.state === 'in') return t('Expires in {{time}}', { time: schedule.time });
  return schedule.state === 'soon' ? t('Expires soon') : '';
}

/** Every quota window carries its OWN schedule (user: 각각 항목마다 초기화시간
 *  개별로 하나씩): a compact duration that closes the meter row after the
 *  percentage, with the full sentence kept in the row tooltip.
 *  The duration units are notation, not prose, so they stay untranslated like
 *  the 5d/13h reading itself. */
function resetShortText(value: unknown): string {
  const schedule = resetSchedule(value);
  if (schedule.state === 'due') return '—';
  if (schedule.state === 'in') return schedule.time;
  return schedule.state === 'soon' ? '<1h' : '—';
}

function resetCredits(row: UsageRecord): UsageRecord {
  return record(row.resetCredits);
}

function availableResetCredits(value: UsageRecord): UsageRecord[] {
  const availableCount = Math.max(0, Math.floor(number(value.availableCount) || 0));
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

function creditsOf(row: UsageRecord): UsageRecord | null {
  return row.credits && typeof row.credits === 'object' ? record(row.credits) : null;
}

const MONEY = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

function CreditLine({
  credits,
  on,
  exhausted,
  onToggle,
}: {
  credits: UsageRecord;
  on: boolean;
  exhausted: boolean;
  onToggle(next: boolean): void;
}) {
  const usd = credits.unit === 'usd';
  const balance = number(credits.balance);
  const limit = number(credits.monthlyLimit);
  let value: string;
  if (credits.unlimited === true) value = t('Unlimited');
  else if (balance === null) value = '—';
  else if (usd) value = `$${balance.toLocaleString('en-US', MONEY)}`;
  else value = Math.round(balance).toLocaleString('en-US');
  const inUse = on && exhausted;
  return (
    <div className="sidebar-usage-credit">
      <small>{t('Credits')}</small>
      <span className="sidebar-usage-credit-value">
        <b className={inUse ? 'is-in-use' : undefined}>{value}</b>
        {usd && limit !== null && (
          <small className="sidebar-usage-credit-limit">
            {' · '}
            {t('Monthly limit')} ${limit.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </small>
        )}
        {inUse && <em className="sidebar-usage-credit-badge">{t('In use')}</em>}
      </span>
      <button
        type="button"
        role="switch"
        className="sidebar-usage-credit-switch"
        aria-checked={on}
        aria-label={t('Use credits')}
        onClick={() => onToggle(!on)}
      />
    </div>
  );
}

export function SidebarUsage({
  api = window.mixdogDesktop,
  sidebarOpen = true,
  pinned = false,
  onTogglePin,
  onOpenStats,
  onAddProviders,
}: {
  api?: UsageApi;
  sidebarOpen?: boolean;
  /** Rail pin mode: the header toggle swaps the rail's pie glyph for the
   *  per-brand icon + % stack (user: 핀모드). */
  pinned?: boolean;
  onTogglePin?(): void;
  /** Opens the usage surface: this panel answers what is LEFT, that one how
   *  it was spent — in tokens, or on a subscription's own meter. */
  onOpenStats?(): void;
  onAddProviders?(): void;
}) {
  // The popup mounts and unmounts with the flyout; the snapshot, the in-flight
  // request and the refresh cadence all live in the shared store, so opening
  // paints the last known rows immediately and only revalidates.
  const snapshot = useSyncExternalStore(subscribeUsageDashboard, getUsageDashboardSnapshot);
  const dashboard = snapshot.dashboard;
  const rowsPresent = rows(dashboard).length > 0;
  const anyConnected = SUBSCRIPTIONS.some((subscription) =>
    subscriptionConnected(subscriptionRow(dashboard, subscription))
  );
  const resetAts = rows(dashboard)
    .flatMap((row) => quotaWindows(row))
    .map((window) => timestamp(window.resetAt))
    .filter((value): value is number => value !== null);
  const failedResetAts = useUsageResetVerification({
    api,
    resetAts,
    refreshedAt: snapshot.refreshedAt,
  });
  // A seedless first paint announces LOADING until the store reports a live
  // result or a final unavailable state. Painting "Not connected" while the
  // very first request is still outstanding claimed an answer nobody has yet.
  // Cached rows always win: revalidation never downgrades them to Loading.
  const awaitingFirstUsage = !rowsPresent && (snapshot.status === 'idle' || snapshot.status === 'loading');
  const [resetConfirming, setResetConfirming] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetNotice, setResetNotice] = useState('');

  // One cadence for the renderer: the rail holds it too, so a popup remount
  // never restarts the five-minute timer and never re-requests.
  useEffect(() => holdUsageDashboardCadence(api), [api]);

  // A provider name or meter opens its own subscription usage: the name with
  // that provider's first window, a meter with its window selected.
  const quotaTrigger = (provider: string, window = '') => {
    if (!onOpenStats) return {};
    const open = () => {
      focusQuotaUsage({ provider, window });
      onOpenStats();
    };
    // What the click opens is read while the pointer is still on its way.
    const readAhead = () => prefetchQuotaUsage(api, { provider, window });
    return {
      role: 'button',
      tabIndex: 0,
      onMouseEnter: readAhead,
      onFocus: readAhead,
      onClick: open,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      },
    };
  };

  // Opening revalidates a stale snapshot only (fresh data inside the TTL paints
  // as-is, an in-flight request is shared) and reads ahead the subscription
  // usage ℹ️ opens on; closing clears reset confirmation.
  const statsAvailable = Boolean(onOpenStats);
  useEffect(() => {
    if (sidebarOpen) {
      void refreshUsageDashboard(api);
      if (statsAvailable) prefetchQuotaUsage(api);
    } else {
      setResetConfirming(null);
      setResetNotice('');
    }
  }, [api, sidebarOpen, statsAvailable]);

  // Preserve the provider's individual expiry rows. The consume endpoint does
  // not accept a credit id, so every Use action safely means "consume one
  // currently available credit"; the refreshed provider list decides which
  // concrete row remains afterward.
  const codexRow = subscriptionRow(dashboard, SUBSCRIPTIONS[0]);
  const codexResetCredits = resetCredits(codexRow);
  const codexResetCount = Math.max(0, Math.floor(number(codexResetCredits.availableCount) || 0));
  const codexResetRows = availableResetCredits(codexResetCredits);
  const codexResetKeys = codexResetRows.map(resetCreditKey);
  const codexResetKeySignature = codexResetKeys.join('\u0000');
  const codexResetOffer = String(codexResetCredits.offerRevision || '');
  // biome-ignore lint/correctness/useExhaustiveDependencies: codexResetKeySignature is the stable string form of codexResetKeys, so the effect re-runs only when the key set changes
  useEffect(() => {
    if (resetConfirming && !codexResetKeys.includes(resetConfirming)) {
      setResetConfirming(null);
    }
  }, [codexResetKeySignature, resetConfirming]);
  const [resetInfoOpen, setResetInfoOpen] = useState(false);
  const resetRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!sidebarOpen) setResetInfoOpen(false);
  }, [sidebarOpen]);
  useEffect(() => {
    if (!resetInfoOpen) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!resetRef.current?.contains(event.target as Node)) setResetInfoOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setResetInfoOpen(false);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [resetInfoOpen]);
  const [creditSwitch, setCreditSwitch] = useState<Record<string, boolean>>({});
  const toggleCredits = async (provider: string, next: boolean) => {
    if (typeof api?.invokeCapability !== 'function') return;
    setCreditSwitch((current) => ({ ...current, [provider]: next }));
    const settle = () =>
      setCreditSwitch((current) => {
        const { [provider]: _settled, ...rest } = current;
        return rest;
      });
    try {
      await api.invokeCapability({
        capability: 'updateProviderAccounts',
        args: [provider, { useCredits: next }],
      });
      invalidateSidebarReferenceForMutation('updateProviderAccounts');
      await refreshUsageDashboard(api, { force: true });
    } catch (cause) {
      console.error('Provider credits toggle failed:', cause);
    }
    settle();
  };
  const consumeCodexReset = async () => {
    if (!codexResetOffer || codexResetCount < 1 || resetting || typeof api?.invokeCapability !== 'function') return;
    const idempotencyKey = codexResetAttempt(codexResetOffer);
    setResetting(true);
    setResetNotice('');
    try {
      const response = await withUsageTimeout(
        api.invokeCapability({
          capability: 'consumeCodexRateLimitResetCredit',
          args: [
            {
              expectedOfferRevision: codexResetOffer,
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
        setResetNotice(t('Reset could not be confirmed. Retrying is safe.'));
        return;
      }
      // The OUTCOME settles the redeem; the rebuilt dashboard is a courtesy
      // payload. When it arrives it lands in the shared snapshot and its cache
      // (not popup-local state); when the runtime's refresh budget expired,
      // the store revalidates instead of calling a spent credit unconfirmed.
      if (!publishUsageDashboard(result.dashboard)) {
        void refreshUsageDashboard(api, { force: true });
      }
      clearCodexResetAttempt(codexResetOffer);
      setResetConfirming(null);
      setResetNotice(resetOutcomeNotice(result.status, outcome));
    } catch (cause) {
      // Keep the durable idempotency key: retrying an unknown provider outcome
      // must reuse the same operation rather than spend a second credit.
      console.error('Codex reset-credit consume failed:', cause);
      const reason = cause instanceof Error && cause.message ? cause.message.trim() : '';
      setResetNotice(
        reason
          ? t('Reset could not be confirmed ({{reason}}). Retrying is safe.', { reason })
          : t('Reset could not be confirmed. Retrying is safe.')
      );
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="sidebar-usage" aria-label={t('Providers')}>
      {/* Same title-row grammar as the rail panels (Sessions/Projects…):
          36px header, 28px action boxes, 16px glyphs. */}
      <header className="sidebar-usage-heading session-panel-header">
        <span className="session-panel-title">{t('Providers')}</span>
        <div className="session-panel-header-actions">
          {/* Nothing to pin without a connected subscription. */}
          {onTogglePin && anyConnected && (
            <button
              type="button"
              className={`session-panel-action sidebar-usage-pin ${pinned ? 'is-active' : ''}`}
              aria-pressed={pinned}
              aria-label={pinned ? t('Unpin usage from the rail') : t('Pin usage to the rail')}
              data-tooltip={pinned ? t('Unpin usage from the rail') : t('Pin usage to the rail')}
              onClick={onTogglePin}
            >
              <RailPinIcon pinned={pinned} size={14} />
            </button>
          )}
          {onOpenStats && (
            <button
              type="button"
              className="session-panel-action sidebar-usage-stats"
              aria-label={t('Show usage')}
              data-tooltip={t('Show usage')}
              onClick={onOpenStats}
            >
              <Info size={16} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="session-panel-action sidebar-provider-add"
            aria-label={t('Connect provider')}
            data-tooltip={t('Connect provider')}
            disabled={!onAddProviders}
            onClick={onAddProviders}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <PaneSurfaceGate ready={!awaitingFirstUsage} label={t('Loading usage…')} fallback={<InitialSurface />}>
        <div className="sidebar-usage-content">
          <div id="sidebar-usage-list" className="sidebar-usage-list">
            {/* Flat roster: header (icon · name · soonest reset) with
            EVERY quota window inline beneath — nothing left to drill into. */}
            {SUBSCRIPTIONS.map((subscription) => {
              const row = subscriptionRow(dashboard, subscription);
              const windows = quotaWindows(row);
              const checking = row.status === 'checking';
              // Only connected providers are listed, so a row here always
              // reads as connected and never as a first-load placeholder.
              if (!subscriptionConnected(row)) return null;
              return (
                <div
                  className="sidebar-usage-row"
                  key={subscription.key}
                  data-usage-provider={subscription.key}
                  aria-busy={checking}
                >
                  <span className="sidebar-usage-line">
                    <span className="sidebar-usage-provider-icon">
                      <ProviderIcon provider={subscription.provider} />
                    </span>
                    <b {...quotaTrigger(subscription.provider)}>{subscription.label}</b>
                    {subscription.provider.endsWith('-oauth') && (
                      <ProviderAccountPicker api={api} provider={subscription.provider} />
                    )}
                    {windows.length === 0 && !checking && <small>{t('Connected')}</small>}
                  </span>
                  <span className="sidebar-usage-meters">
                    {windows.map((window, index) => {
                      const percent = usedPercent(window);
                      const resetAt = timestamp(window.resetAt);
                      const resetPresentation = usageResetPresentation({
                        percent,
                        resetAt,
                        refreshedAt: snapshot.refreshedAt,
                        verificationFailed: resetAt !== null && failedResetAts.has(resetAt),
                      });
                      const effectivePercent = resetPresentation.percent;
                      const displayedPercent = displayUsagePercent(effectivePercent);
                      const tone = usageToneClass(effectivePercent);
                      const resetSentence =
                        resetPresentation.resetTextOverride === null ? resetText(window.resetAt) : '';
                      return (
                        <span
                          className={`sidebar-usage-meter${tone}`}
                          key={quotaWindowKey(window, index)}
                          {...quotaTrigger(subscription.provider, String(window.label || ''))}
                        >
                          <small title={windowLabel(window)}>{windowLabel(window)}</small>
                          <i>
                            <i style={{ width: `${effectivePercent ?? 0}%` }} />
                          </i>
                          <b>{displayedPercent === null ? '—' : `${displayedPercent}%`}</b>
                          <em title={resetSentence || undefined}>
                            {resetPresentation.resetTextOverride ?? resetShortText(window.resetAt)}
                          </em>
                        </span>
                      );
                    })}
                    {windows.length === 0 && (
                      <span className="sidebar-usage-meter sidebar-usage-meter-empty">
                        <small>{checking ? t('Loading usage…') : t('No current quota window')}</small>
                      </span>
                    )}
                  </span>
                  {creditsOf(row) && (
                    <CreditLine
                      credits={creditsOf(row) as UsageRecord}
                      on={creditSwitch[subscription.provider] ?? row.useCredits === true}
                      exhausted={windows.some((window) => (usedPercent(window) ?? 0) >= 100)}
                      onToggle={(next) => void toggleCredits(subscription.provider, next)}
                    />
                  )}
                  {subscription.key === 'codex' && codexResetOffer && codexResetCount > 0 && (
                    <div className="sidebar-usage-reset-credit" ref={resetRef}>
                      <div className="sidebar-usage-reset-line">
                        <small>{t('Reset credits')}</small>
                        <span className="sidebar-usage-credit-value">
                          <b>{t('{{count}} left', { count: codexResetCount })}</b>
                          <button
                            type="button"
                            className="sidebar-usage-reset-info"
                            aria-label={t('Reset credit details')}
                            aria-expanded={resetInfoOpen}
                            onClick={() => setResetInfoOpen((open) => !open)}
                          >
                            <Info size={14} aria-hidden="true" />
                          </button>
                        </span>
                        <button
                          type="button"
                          className="sidebar-usage-reset-use"
                          disabled={resetting}
                          onClick={() => setResetConfirming(codexResetKeys[0] ?? null)}
                        >
                          {t('Use')}
                        </button>
                      </div>
                      {resetInfoOpen && (
                        <ul className="sidebar-usage-reset-popover" role="dialog" aria-label={t('Reset credits')}>
                          {codexResetRows.map((credit, index) => {
                            const expiresAt = timestamp(credit.expiresAt);
                            const soon = expiresAt !== null && expiresAt - Date.now() <= 7 * 24 * 3_600_000;
                            return (
                              <li key={codexResetKeys[index]}>
                                <span>{t('Reset credit {{index}}', { index: index + 1 })}</span>
                                <small className={soon ? 'is-soon' : undefined}>
                                  {resetExpiryText(credit.expiresAt) || t('Expiry unavailable')}
                                </small>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {resetConfirming !== null && (
                        <div className="sidebar-usage-reset-confirmation">
                          <p>
                            {t(
                              'This uses one available reset credit and immediately resets eligible Codex rate-limit windows.'
                            )}
                          </p>
                          <div className="sidebar-usage-reset-actions">
                            <button type="button" disabled={resetting} onClick={() => setResetConfirming(null)}>
                              {t('Cancel')}
                            </button>
                            <button type="button" disabled={resetting} onClick={() => void consumeCodexReset()}>
                              {resetting ? t('Using…') : t('Confirm')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {resetNotice && (
            <p className="sidebar-usage-reset-notice" role="status">
              {resetNotice}
            </p>
          )}
        </div>
      </PaneSurfaceGate>
    </section>
  );
}
