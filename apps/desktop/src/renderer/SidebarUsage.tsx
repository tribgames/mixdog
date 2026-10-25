import { Info, Plus } from 'lucide-react';
import { SidebarUsageMenu } from './SidebarUsageMenu';
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react';
import { invalidateSidebarReferenceForMutation } from './sidebar-reference-cache';

import { PaneSurfaceGate } from './PaneSurfaceGate';
import { InitialSurface } from './InitialSurface';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
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
import { usageResetPresentation } from './usage-reset-time';
import {
  usageResetSchedule as resetSchedule,
  usageResetText as resetText,
  usageTimestamp as timestamp,
  usageWindowLabel as windowLabel,
} from './usage-window-text';
import { useUsageResetVerification } from './use-usage-reset-verification';
import { ProviderAccountPicker } from './ProviderAccountPicker';
import { focusQuotaUsage } from './usage-surface-mode';
import { prefetchQuotaUsage } from './quota-usage-cache';
import { SUBSCRIPTIONS } from './subscription-providers';
import {
  quotaWindows,
  subscriptionRow,
  usageNumber as number,
  usageRows as rows,
  usageAccountName,
  usedPercent,
  type UsageRailBars,
  type UsageRailSlots,
} from './usage-pin-entries';
import { expandableAccounts, useUsageAccountPools, type UsageAccount } from './usage-account-pools';

export { usagePinEntries, type UsageRailBars, type UsageRailSlots } from './usage-pin-entries';

const SIDEBAR_CODEX_RESET_ATTEMPT_KEY = 'mixdog.desktop.codex-reset-attempt.v1';
const SIDEBAR_CODEX_RESET_TIMEOUT_MS = 90_000;

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

function resetExpiryText(value: unknown): string {
  const schedule = resetSchedule(value);
  if (schedule.state === 'due') return t('Expiry due');
  if (schedule.state === 'in') return t('Expires in {{time}}', { time: schedule.time });
  return schedule.state === 'soon' ? t('Expires soon') : '';
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

function ResetCreditPanel({
  containerRef,
  count,
  rows,
  keys,
  infoOpen,
  confirming,
  resetting,
  onToggleInfo,
  onAsk,
  onCancel,
  onConfirm,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  count: number;
  rows: UsageRecord[];
  keys: string[];
  infoOpen: boolean;
  confirming: boolean;
  resetting: boolean;
  onToggleInfo(): void;
  onAsk(): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <div className="sidebar-usage-reset-credit" ref={containerRef}>
      <div className="sidebar-usage-reset-line">
        <small>{t('Reset credits')}</small>
        <span className="sidebar-usage-credit-value">
          <b>{t('{{count}} left', { count })}</b>
          <button
            type="button"
            className="sidebar-usage-reset-info"
            aria-label={t('Reset credit details')}
            aria-expanded={infoOpen}
            onClick={onToggleInfo}
          >
            <Info size={14} aria-hidden="true" />
          </button>
        </span>
        <button type="button" className="sidebar-usage-reset-use" disabled={resetting} onClick={onAsk}>
          {t('Use')}
        </button>
      </div>
      {infoOpen && (
        <ul className="sidebar-usage-reset-popover" role="dialog" aria-label={t('Reset credits')}>
          {rows.map((credit, index) => {
            const expiresAt = timestamp(credit.expiresAt);
            const soon = expiresAt !== null && expiresAt - Date.now() <= 7 * 24 * 3_600_000;
            return (
              <li key={keys[index]}>
                <span>{t('Reset credit {{index}}', { index: index + 1 })}</span>
                <small className={soon ? 'is-soon' : undefined}>
                  {resetExpiryText(credit.expiresAt) || t('Expiry unavailable')}
                </small>
              </li>
            );
          })}
        </ul>
      )}
      {confirming && (
        <div className="sidebar-usage-reset-confirmation">
          <p>{t('This uses one available reset credit and immediately resets eligible Codex rate-limit windows.')}</p>
          <div className="sidebar-usage-reset-actions">
            <button type="button" disabled={resetting} onClick={onCancel}>
              {t('Cancel')}
            </button>
            <button type="button" disabled={resetting} onClick={onConfirm}>
              {resetting ? t('Using…') : t('Confirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SidebarUsage({
  api = window.mixdogDesktop,
  sidebarOpen = true,
  pinned = false,
  onTogglePin,
  railBars = 'long',
  onRailBarsChange,
  accountsExpanded = false,
  onAccountsExpandedChange,
  railSlots = '5',
  onRailSlotsChange,
  onOpenStats,
  onAddProviders,
}: {
  api?: UsageApi;
  sidebarOpen?: boolean;
  /** Rail pin mode: the header toggle swaps the rail's pie glyph for the
   *  per-brand icon + % stack. */
  pinned?: boolean;
  onTogglePin?(): void;
  /** Which bars the pinned rail draws per brand. */
  railBars?: UsageRailBars;
  onRailBarsChange?(next: UsageRailBars): void;
  /** Lists every account of a multi-account provider, here and on the rail. */
  accountsExpanded?: boolean;
  onAccountsExpandedChange?(next: boolean): void;
  /** Most slots the rail shows while accounts are expanded. */
  railSlots?: UsageRailSlots;
  onRailSlotsChange?(next: UsageRailSlots): void;
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
  const accountPools = useUsageAccountPools(
    api,
    SUBSCRIPTIONS.filter(
      (subscription) =>
        subscription.provider.endsWith('-oauth') && subscriptionConnected(subscriptionRow(dashboard, subscription))
    ).map((subscription) => subscription.provider),
    sidebarOpen
  );
  const [resetConfirming, setResetConfirming] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetNotice, setResetNotice] = useState('');

  // One cadence for the renderer: the rail holds it too, so a popup remount
  // never restarts the five-minute timer and never re-requests.
  useEffect(() => holdUsageDashboardCadence(api), [api]);

  // A provider name or meter opens its own subscription usage: the name with
  // that provider's first window, a meter with its window selected.
  const quotaTrigger = (provider: string, window = '', account = '') => {
    if (!onOpenStats) return {};
    const open = () => {
      focusQuotaUsage({ provider, window, account });
      onOpenStats();
    };
    // What the click opens is read while the pointer is still on its way.
    const readAhead = () => prefetchQuotaUsage(api, { provider, window, account });
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

  // A registered account's name opens that account's own usage chart; it is a
  // real button, so only the click and hover read-ahead come from the trigger.
  const accountTrigger = (provider: string, account: string) => {
    const { onMouseEnter, onFocus, onClick } = quotaTrigger(provider, '', account) as {
      onMouseEnter?(): void;
      onFocus?(): void;
      onClick?(): void;
    };
    return { onMouseEnter, onFocus, onClick };
  };

  // The quota windows of one provider row or one of its accounts.
  const renderMeters = (windows: UsageRecord[], provider: string, account = '') =>
    windows.map((window, index) => {
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
      const resetSentence = resetPresentation.resetTextOverride === null ? resetText(window.resetAt) : '';
      return (
        <span
          className={`sidebar-usage-meter${tone}`}
          key={quotaWindowKey(window, index)}
          {...quotaTrigger(provider, String(window.label || ''), account)}
        >
          <small title={windowLabel(window)}>{windowLabel(window)}</small>
          <em title={resetSentence || undefined}>{resetPresentation.resetTextOverride ?? resetText(window.resetAt)}</em>
          <b>{displayedPercent === null ? '—' : `${displayedPercent}%`}</b>
          <i>
            <i style={{ width: `${effectivePercent ?? 0}%` }} />
          </i>
        </span>
      );
    });

  // "Resets in X" for an account the runtime holds under a limit; empty when it
  // has none (a credit-enabled account at 100% reports no limit). The reset is
  // the block's end, else the soonest still-pending reset of an exhausted window.
  const accountLimitText = (account: UsageAccount): string => {
    if (!account.limited) return '';
    const now = Date.now();
    const pending = [
      account.blockedUntil,
      ...account.windows
        .filter((window) => (usedPercent(window) ?? 0) >= 100)
        .map((window) => timestamp(window.resetAt)),
    ].filter((at): at is number => at !== null && at > now);
    if (!pending.length) return '';
    return resetText(account.blockedUntil && account.blockedUntil > now ? account.blockedUntil : Math.min(...pending));
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
  const codexResetCount = availableResetCount(codexResetCredits);
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
  useMobileBack(resetConfirming !== null, () => {
    if (!resetting) setResetConfirming(null);
  });
  useMobileBack(resetInfoOpen, () => setResetInfoOpen(false));
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
    <section className="sidebar-usage" aria-label={t('Usage')}>
      {/* Same title-row grammar as the rail panels (Sessions/Projects…):
          36px header, 28px action boxes, 16px glyphs. */}
      <header className="sidebar-usage-heading session-panel-header">
        <span className="session-panel-title">{t('Usage')}</span>
        <div className="session-panel-header-actions">
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
          {/* Nothing to pin without a connected subscription. */}
          {onTogglePin && anyConnected && (
            <SidebarUsageMenu
              pinned={pinned}
              onTogglePin={onTogglePin}
              railBars={railBars}
              onRailBarsChange={onRailBarsChange}
              accountsExpanded={accountsExpanded}
              onAccountsExpandedChange={onAccountsExpandedChange}
              railSlots={railSlots}
              onRailSlotsChange={onRailSlotsChange}
            />
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
              const credits = creditsOf(row);
              const checking = row.status === 'checking';
              const pool = accountPools.get(subscription.provider);
              const listedAccounts = expandableAccounts(pool);
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
                    {listedAccounts.length > 0 && accountsExpanded && (
                      <small className="sidebar-usage-account-count">
                        {t('{{n}} accounts', { n: listedAccounts.length })}
                      </small>
                    )}
                    {subscription.provider.endsWith('-oauth') && (
                      <ProviderAccountPicker
                        api={api}
                        provider={subscription.provider}
                        label={
                          listedAccounts.length > 0 && !accountsExpanded
                            ? t('{{name}} · {{n}} accounts', {
                                name: usageAccountName(
                                  listedAccounts.find((account) => account.id === pool?.selectedId) ?? listedAccounts[0]
                                ),
                                n: listedAccounts.length,
                              })
                            : undefined
                        }
                      />
                    )}
                    {windows.length === 0 && !checking && <small>{t('Connected')}</small>}
                  </span>
                  {listedAccounts.length > 0 && accountsExpanded ? (
                    listedAccounts.map((account) => {
                      const limitText = accountLimitText(account);
                      return (
                        <div className="sidebar-usage-account" key={account.id} data-usage-account={account.id}>
                          <span className="sidebar-usage-account-line">
                            <button
                              type="button"
                              className="sidebar-usage-account-name"
                              title={t('Open usage for {{name}}', { name: usageAccountName(account) })}
                              disabled={!onOpenStats}
                              {...accountTrigger(subscription.provider, account.id)}
                            >
                              {usageAccountName(account)}
                            </button>
                            {account.label.trim() && account.email.trim() && (
                              <small className="sidebar-usage-account-email" title={account.email.trim()}>
                                {account.email.trim()}
                              </small>
                            )}
                            {account.id === pool?.selectedId && (
                              <span className="sidebar-usage-account-inuse">{t('In use')}</span>
                            )}
                            {limitText && <small className="sidebar-usage-account-limit">{limitText}</small>}
                          </span>
                          <span className="sidebar-usage-meters">
                            {renderMeters(account.windows, subscription.provider, account.id)}
                            {account.windows.length === 0 && (
                              <span className="sidebar-usage-meter sidebar-usage-meter-empty">
                                <small>{t('No usage limits to show')}</small>
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <span className="sidebar-usage-meters">
                      {renderMeters(windows, subscription.provider)}
                      {windows.length === 0 && (
                        <span className="sidebar-usage-meter sidebar-usage-meter-empty">
                          <small>{checking ? t('Loading usage…') : t('No usage limits to show')}</small>
                        </span>
                      )}
                    </span>
                  )}
                  {credits && (
                    <CreditLine
                      credits={credits}
                      on={creditSwitch[subscription.provider] ?? row.useCredits === true}
                      exhausted={windows.some((window) => (usedPercent(window) ?? 0) >= 100)}
                      onToggle={(next) => void toggleCredits(subscription.provider, next)}
                    />
                  )}
                  {subscription.key === 'codex' && codexResetOffer && codexResetCount > 0 && (
                    <ResetCreditPanel
                      containerRef={resetRef}
                      count={codexResetCount}
                      rows={codexResetRows}
                      keys={codexResetKeys}
                      infoOpen={resetInfoOpen}
                      confirming={resetConfirming !== null}
                      resetting={resetting}
                      onToggleInfo={() => setResetInfoOpen((open) => !open)}
                      onAsk={() => setResetConfirming(codexResetKeys[0] ?? null)}
                      onCancel={() => setResetConfirming(null)}
                      onConfirm={() => void consumeCodexReset()}
                    />
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
