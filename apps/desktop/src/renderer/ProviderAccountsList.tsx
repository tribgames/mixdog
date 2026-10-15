import { Check, ChevronDown, ChevronUp, GripVertical, Pencil, RefreshCw } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { DesktopCapability } from '../shared/contract';
import { ErrorNotice } from './ErrorNotice';
import { t, uiFormatLocale } from './i18n';
import { useMobileBack } from './mobile-back';
import { record } from './record-utils';
import { captureRowMenuAnchor, positionRowMenu } from './row-menu-geometry';
import { displayUsagePercent, usageToneClass } from './usage-percent';
import { usageResetPresentation } from './usage-reset-time';
import { usageResetShortText, usageResetText, usageTimestamp, usageWindowLabel } from './usage-window-text';
import {
  applyAccountUsageWindows,
  refreshUsageDashboard,
  refreshUsageDashboardAfterAuth,
  subscribeUsageDashboard,
  type UsageApi,
} from './usage-dashboard-store';
import { ProviderIcon } from './provider-display';
import { invalidateSidebarReferenceForMutation } from './sidebar-reference-cache';
import './provider-accounts.css';

export const PROVIDER_ACCOUNTS_CHANGED = 'mixdog:provider-accounts-changed';
type ProviderAccount = {
  id: string;
  label: string;
  authenticated: boolean;
  reauthRequired: boolean;
  /** Provider-side identity (email / account id) when the token exposes one. */
  identity?: string;
  /** Sign-in email of the real account, when the provider exposes one. */
  email?: string;
  blockedUntil?: number;
  usage?: { windows?: UsageWindow[]; checkedAt?: number } | null;
  /** The limit holding the account: account-wide, or only one model family's
   *  meter ("7D Fable") while other models still run. */
  limit?: { scope: 'account' } | { scope: 'model'; families: string[] } | null;
};
type UsageWindow = { label?: string; usedPct: number | null; resetAt?: number | null };
type AccountPolicy = 'manual' | 'limit' | 'headroom';
/** `auto` predates `policy`; a roster without `policy` maps auto off → manual. */
type Pool = { accounts: ProviderAccount[]; selectedId: string | null; auto: boolean; policy?: AccountPolicy };

const poolPolicy = (pool: Pool): AccountPolicy => pool.policy ?? (pool.auto === false ? 'manual' : 'limit');
const lastCheckedAt = (pool: Pool): number | null => {
  const times = pool.accounts.map((row) => Number(row.usage?.checkedAt) || 0).filter((at) => at > 0);
  return times.length ? Math.max(...times) : null;
};

function checkedAge(at: number | null): string {
  if (!at) return '';
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 60) return t('Just now');
  const format = new Intl.RelativeTimeFormat(uiFormatLocale(), { numeric: 'auto' });
  if (seconds < 3600) return format.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return format.format(-Math.floor(seconds / 3600), 'hour');
  return format.format(-Math.floor(seconds / 86_400), 'day');
}

/** One row per quota window the account carries, in the sidebar usage flyout's
 *  grammar: label | meter | percent | short reset time. */
function AccountUsage({ account }: { account: ProviderAccount }) {
  const windows = account.usage?.windows ?? [];
  const refreshedAt = Number(account.usage?.checkedAt) || 0;
  let emptyNote = '';
  if (account.reauthRequired) emptyNote = t('Shown after signing in again');
  else if (windows.length === 0) emptyNote = t('Usage not checked yet');
  return (
    <div className="provider-account-usage">
      {emptyNote ? (
        <small className="empty">{emptyNote}</small>
      ) : (
        windows.map((window, index) => {
          const used = typeof window.usedPct === 'number' ? Math.max(0, Math.min(100, window.usedPct)) : null;
          const presentation = usageResetPresentation({
            percent: used,
            resetAt: usageTimestamp(window.resetAt),
            refreshedAt,
            verificationFailed: false,
          });
          const percent = presentation.percent;
          const displayed = displayUsagePercent(percent);
          const label = usageWindowLabel(window);
          const sentence = presentation.resetTextOverride === null ? usageResetText(window.resetAt) : '';
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: windows carry no id and a provider may repeat a label; the list is replaced whole, never reordered.
            <span className={usageToneClass(percent).trim() || undefined} key={`${label}:${index}`}>
              <small title={label}>{label}</small>
              <i>
                <i style={{ width: `${percent ?? 0}%` }} />
              </i>
              <b>{displayed === null ? '—' : `${displayed}%`}</b>
              <em title={sentence || undefined}>
                {presentation.resetTextOverride ?? usageResetShortText(window.resetAt)}
              </em>
            </span>
          );
        })
      )}
    </div>
  );
}

const POLICY_ITEMS = "[role='menuitemradio']:not(:disabled), [role='menuitem']:not(:disabled)";

/** Header control: which account the roster sends from, plus a usage refresh. */
function AccountPolicyMenu({
  policy,
  disabled,
  refreshing,
  checkedAt,
  onPolicy,
  onRefresh,
}: {
  policy: AccountPolicy;
  disabled: boolean;
  refreshing: boolean;
  checkedAt: number | null;
  onPolicy(policy: AccountPolicy): void;
  onRefresh(): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const anchor = useRef<ReturnType<typeof captureRowMenuAnchor> | null>(null);
  useMobileBack(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return undefined;
    queueMicrotask(() =>
      (
        panel.current?.querySelector<HTMLButtonElement>("[aria-checked='true']") ??
        panel.current?.querySelector<HTMLButtonElement>(POLICY_ITEMS)
      )?.focus()
    );
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const entries = [...(panel.current?.querySelectorAll<HTMLButtonElement>(POLICY_ITEMS) ?? [])];
    if (!entries.length) return;
    const current = Math.max(0, entries.indexOf(document.activeElement as HTMLButtonElement));
    let next: number;
    if (event.key === 'ArrowDown') next = (current + 1) % entries.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + entries.length) % entries.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = entries.length - 1;
    else return;
    event.preventDefault();
    entries[next]?.focus();
  };
  const options: [AccountPolicy, string, string][] = [
    ['manual', t('Manual'), t('Uses only the selected account.')],
    ['limit', t('Switch at limit'), t('Moves to the account with the most headroom when a limit is reached.')],
    ['headroom', t('Most headroom first'), t('Each new conversation starts on the account with the most usage left.')],
  ];
  const current = options.find(([value]) => value === policy) ?? options[1];
  const choose = (value: AccountPolicy) => {
    setOpen(false);
    trigger.current?.focus();
    if (value !== policy) onPolicy(value);
  };
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="settings-action provider-accounts-policy"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t('Account switching')}: ${current[1]}`}
        onClick={(event) => {
          anchor.current = captureRowMenuAnchor(event.currentTarget);
          setOpen((value) => !value);
        }}
      >
        <span className="k">{t('Switch')}</span>
        {current[1]}
        <Chevron aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            className="row-overflow-menu provider-accounts-policy-menu"
            role="menu"
            aria-label={t('Account switching')}
            onKeyDown={onKeyDown}
            style={positionRowMenu(anchor.current, 7, 1, window.innerWidth, window.innerHeight)}
          >
            {options.map(([value, title, description]) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={value === policy}
                data-account-policy={value}
                onClick={() => choose(value)}
              >
                <span className="provider-accounts-policy-check" aria-hidden="true">
                  {value === policy && <Check size={14} />}
                </span>
                <span className="provider-accounts-policy-copy">
                  <b>{title}</b>
                  <small>{description}</small>
                </span>
              </button>
            ))}
            <div className="usage-menu-separator" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              className="provider-accounts-policy-refresh"
              disabled={refreshing}
              onClick={() => {
                setOpen(false);
                onRefresh();
              }}
            >
              <span className="row-overflow-label">{t('Refresh usage')}</span>
              {checkedAt && <small>{checkedAge(checkedAt)}</small>}
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

// Last roster per provider. The rail picker remounts on every open; seeding
// from here paints instantly and the fresh read merely revalidates.
const lastPools = new Map<string, Pool>();
// Bumped by every list-adopted roster (read or mutation result): a preload
// started before it is stale and must not overwrite the newer roster.
const poolGenerations = new Map<string, number>();
const bumpPoolGeneration = (provider: string): number => {
  const next = (poolGenerations.get(provider) ?? 0) + 1;
  poolGenerations.set(provider, next);
  return next;
};

/** Settings open: seed the rosters so the Providers page paints complete cards
 *  on its first visit instead of growing under the rows below. */
export function preloadProviderAccounts(api: UsageApi | undefined, providers: string[]): Promise<unknown> {
  const invokeCapability = api?.invokeCapability;
  if (!invokeCapability) return Promise.resolve();
  return Promise.all(
    providers.map((provider) => {
      const generation = bumpPoolGeneration(provider);
      return invokeCapability({ capability: 'getProviderAccounts', args: [provider] })
        .then((response) => {
          const result = record(response.value);
          if (poolGenerations.get(provider) !== generation || !Array.isArray(result.accounts)) return;
          lastPools.set(provider, result as unknown as Pool);
        })
        .catch(() => undefined);
    })
  );
}

/** Pointer-driven reorder: the grabbed row lifts and follows the pointer; the
 *  rows it passes slide out of its way; release commits the new order. HTML5
 *  drag left the row in place under a translucent ghost (user: 아이템이
 *  들리는 게 아니다), so this owns the gesture itself. */
type DragState = {
  id: string;
  from: number;
  to: number;
  offset: number; // pointer Y − row top at grab time
  startY: number;
  rowHeight: number;
  y: number; // current pointer Y
  moved: boolean;
};
const DRAG_THRESHOLD_PX = 4;

export function ProviderAccountsList({
  api,
  provider,
  title,
  listOnly = false,
  renderActions,
  headerAction,
  onChange,
}: {
  api?: UsageApi;
  provider: string;
  title?: string;
  listOnly?: boolean;
  renderActions?(account: ProviderAccount): ReactNode;
  headerAction?: ReactNode;
  onChange?(): void;
}) {
  const [pool, setPoolState] = useState<Pool | null>(() => lastPools.get(provider) ?? null);
  const setPool = useCallback(
    (next: Pool) => {
      bumpPoolGeneration(provider);
      lastPools.set(provider, next);
      setPoolState(next);
    },
    [provider]
  );
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [drag, setDrag] = useState<DragState | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const generation = useRef(0);
  const mutating = useRef(false);
  const invoke = useCallback(
    async (capability: DesktopCapability, args: unknown[]) => {
      if (!api?.invokeCapability) throw new Error(t('Account controls are unavailable.'));
      const response = await api.invokeCapability({ capability, args });
      const result = record(response.value);
      if (!Array.isArray(result.accounts)) throw new Error(t('Account list could not be loaded.'));
      return result as unknown as Pool;
    },
    [api]
  );
  const load = useCallback(async () => {
    const stamp = ++generation.current;
    try {
      const result = await invoke('getProviderAccounts', [provider]);
      if (generation.current === stamp) {
        setPool(result);
        setError('');
      }
    } catch (cause) {
      if (generation.current === stamp) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [invoke, provider, setPool]);
  useEffect(() => {
    void load();
    const changed = () => void load();
    window.addEventListener(PROVIDER_ACCOUNTS_CHANGED, changed);
    const unsubscribe = subscribeUsageDashboard(changed);
    return () => {
      generation.current += 1;
      unsubscribe();
      window.removeEventListener(PROVIDER_ACCOUNTS_CHANGED, changed);
    };
  }, [load]);

  const change = async (value: Record<string, unknown>) => {
    if (mutating.current) return;
    mutating.current = true;
    generation.current += 1;
    setPending(true);
    setError('');
    try {
      const next = await invoke('updateProviderAccounts', [provider, value]);
      // This list calls the capability directly, outside the settings runner,
      // so it owns the provider-cache invalidation an account change implies.
      invalidateSidebarReferenceForMutation('updateProviderAccounts');
      setPool(next);
      window.dispatchEvent(new window.Event(PROVIDER_ACCOUNTS_CHANGED));
      if (value.selectedId !== undefined) {
        // Replace the old account's quota with the chosen account's own last
        // known windows, or a loading placeholder when none are known. Confirm
        // with a refresh that cannot adopt the previous account's request.
        applyAccountUsageWindows(provider, next.accounts.find((row) => row.id === next.selectedId)?.usage?.windows);
        void refreshUsageDashboardAfterAuth(api, [provider]);
      } else {
        // Order / switching policy / rename change no quota: revalidate only when the
        // shared snapshot is already stale.
        void refreshUsageDashboard(api);
      }
      onChange?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      mutating.current = false;
      setPending(false);
    }
  };
  // Re-measures every account's quota; the roster itself is unchanged.
  const refreshUsage = async () => {
    if (refreshing) return;
    const stamp = ++generation.current;
    setRefreshing(true);
    setError('');
    try {
      const next = await invoke('updateProviderAccounts', [provider, { refreshUsage: true }]);
      if (generation.current !== stamp) return;
      setPool(next);
      // The selection is unchanged, so the sidebar keeps its metadata (credits,
      // reset credits) and the shared dashboard re-measures to settle `checking`.
      void refreshUsageDashboard(api, { force: true, providers: [provider] });
    } catch (cause) {
      if (generation.current === stamp) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  };
  const reorder = (from: number, to: number) => {
    if (!pool || from === to) return;
    const order = pool.accounts.map((row) => row.id);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    void change({ order });
  };
  const commitName = (account: ProviderAccount) => {
    const next = name.trim();
    if (next && next !== account.label) void change({ rename: { id: account.id, label: next } });
    setEditing(null);
  };

  // ── Pointer reorder ──────────────────────────────────────────────────
  // The gesture lives in a ref and writes the lifted row's transform straight
  // to the DOM inside one animation frame per pointer sample. React state only
  // changes when the TARGET SLOT changes (once per row crossed) — re-rendering
  // every row on every pointermove is what made this list drag sluggishly
  // while the rest of the app felt fine (user: 프로바이더창만 유독 드래그가 느리네).
  const gesture = useRef<DragState | null>(null);
  const liftedRow = useRef<HTMLElement | null>(null);
  const frame = useRef(0);
  const paintLift = () => {
    frame.current = 0;
    const state = gesture.current;
    if (state?.moved && liftedRow.current)
      liftedRow.current.style.transform = `translateY(${state.y - state.startY}px)`;
  };
  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, index: number, id: string) => {
    if (pending || event.button !== 0 || !pool) return;
    const row = event.currentTarget.closest<HTMLElement>('li');
    if (!row) return;
    const rect = row.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    liftedRow.current = row;
    gesture.current = {
      id,
      from: index,
      to: index,
      offset: event.clientY - rect.top,
      startY: event.clientY,
      rowHeight: rect.height,
      y: event.clientY,
      moved: false,
    };
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = gesture.current;
    if (!state || !pool || !listRef.current) return;
    const moved = state.moved || Math.abs(event.clientY - state.startY) > DRAG_THRESHOLD_PX;
    if (!moved) return;
    // Target slot from the lifted row's CENTER against the list's row grid.
    const listTop = listRef.current.getBoundingClientRect().top;
    const center = event.clientY - state.offset + state.rowHeight / 2 - listTop;
    const to = Math.max(0, Math.min(pool.accounts.length - 1, Math.floor(center / state.rowHeight)));
    const slotChanged = !state.moved || to !== state.to;
    state.y = event.clientY;
    state.to = to;
    state.moved = true;
    if (slotChanged) {
      // Paint the lift synchronously with the slot change so the row never
      // shows one frame in place while its neighbours already shifted.
      if (frame.current) {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
      }
      if (liftedRow.current) liftedRow.current.style.transform = `translateY(${state.y - state.startY}px)`;
      setDrag({ ...state });
    } else if (typeof requestAnimationFrame !== 'function') {
      paintLift();
    } else if (!frame.current) {
      frame.current = requestAnimationFrame(paintLift);
    }
  };
  const clearGesture = () => {
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    }
    if (liftedRow.current) liftedRow.current.style.transform = '';
    liftedRow.current = null;
    gesture.current = null;
    setDrag(null);
  };
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = gesture.current;
    if (!state) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    const { from, to, moved } = state;
    clearGesture();
    if (moved) reorder(from, to);
  };
  const dragging = drag !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: clearGesture is recreated every render but only touches refs and a state setter; the listener must follow `dragging` only.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearGesture();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging]);
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    []
  );
  // Displaced rows between the origin and target slot shift one row height.
  // The lifted row's own transform is written to the DOM by the gesture, so
  // React must NOT set `style.transform` on it — a value here would overwrite
  // the pointer-tracked one on every slot change.
  const rowStyle = (index: number): React.CSSProperties | undefined => {
    if (!drag?.moved || index === drag.from) return undefined;
    if (drag.from < drag.to && index > drag.from && index <= drag.to)
      return { transform: `translateY(-${drag.rowHeight}px)` };
    if (drag.from > drag.to && index >= drag.to && index < drag.from)
      return { transform: `translateY(${drag.rowHeight}px)` };
    return undefined;
  };

  return (
    <section
      className={`provider-accounts ${listOnly ? 'is-list-only' : ''} ${drag?.moved ? 'is-dragging' : ''}`.trim()}
      data-account-provider={provider}
    >
      {title && (
        <header className="provider-accounts-heading">
          <span className="provider-accounts-icon">
            <ProviderIcon provider={provider} />
          </span>
          <b>{title}</b>
          {pool && pool.accounts.length > 0 && (
            <small>{t('{{count}} accounts', { count: pool.accounts.length })}</small>
          )}
          <span className="provider-accounts-heading-actions">
            {!listOnly && pool && pool.accounts.length > 1 && (
              <AccountPolicyMenu
                policy={poolPolicy(pool)}
                disabled={pending}
                refreshing={refreshing}
                checkedAt={lastCheckedAt(pool)}
                onPolicy={(policy) => void change({ policy })}
                onRefresh={() => void refreshUsage()}
              />
            )}
            {!listOnly && pool && pool.accounts.length > 0 && (
              <button
                type="button"
                className={`provider-account-add-button provider-accounts-refresh ${pool.accounts.length > 1 ? 'is-in-menu' : ''}`.trim()}
                disabled={refreshing}
                aria-label={t('Refresh usage')}
                title={t('Refresh usage')}
                onClick={() => void refreshUsage()}
              >
                <RefreshCw size={14} aria-hidden="true" />
              </button>
            )}
            {headerAction}
          </span>
        </header>
      )}
      {!pool && !error && (
        <div className="provider-accounts-notice" role="status">
          {t('Loading…')}
        </div>
      )}
      {pool && !pool.accounts.length && <div className="provider-accounts-notice">{t('No connected accounts.')}</div>}
      <ol className="provider-accounts-list" ref={listRef}>
        {pool?.accounts.map((account, index) => {
          const selected = pool.selectedId === account.id;
          const selectable = !selected && account.authenticated && !account.reauthRequired;
          const lifted = drag?.moved && drag.from === index;
          return (
            <li
              key={account.id}
              data-account-id={account.id}
              className={[
                selected && 'is-selected',
                lifted && 'is-lifted',
                !listOnly && account.reauthRequired && 'is-dim',
              ]
                .filter(Boolean)
                .join(' ')}
              style={rowStyle(index)}
            >
              <div className="provider-account-row">
                <button
                  type="button"
                  className="provider-account-grip"
                  disabled={pending}
                  aria-label={t('Reorder account {{name}}', { name: account.label })}
                  title={t('Drag or use Alt + arrow keys to reorder')}
                  onPointerDown={(event) => beginDrag(event, index, account.id)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={clearGesture}
                  onKeyDown={(event) => {
                    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                    event.preventDefault();
                    const to = index + (event.key === 'ArrowUp' ? -1 : 1);
                    if (to >= 0 && to < pool.accounts.length) reorder(index, to);
                  }}
                >
                  <GripVertical size={14} aria-hidden="true" />
                </button>
                {listOnly && (
                  <button
                    type="button"
                    className="provider-account-choice"
                    disabled={pending || !account.authenticated}
                    aria-pressed={selected}
                    onClick={() => void change({ selectedId: account.id })}
                  >
                    <span>{account.label}</span>
                    {account.reauthRequired && <small>{t('Reauth required')}</small>}
                    {selected && <Check size={14} aria-label={t('Active')} />}
                  </button>
                )}
                {!listOnly && (
                  <>
                    <div className="provider-account-identity">
                      {selectable && editing !== account.id && (
                        <button
                          type="button"
                          className="provider-account-select"
                          disabled={pending}
                          aria-label={t('Use account {{name}}', { name: account.label })}
                          onClick={() => void change({ selectedId: account.id })}
                        />
                      )}
                      <div className="provider-account-copy">
                        <div className="provider-account-title">
                          {editing === account.id ? (
                            <form
                              onSubmit={(event) => {
                                event.preventDefault();
                                commitName(account);
                              }}
                            >
                              <input
                                // biome-ignore lint/a11y/noAutofocus: inline rename opens from an explicit action and should take typing at once.
                                autoFocus
                                value={name}
                                maxLength={80}
                                aria-label={t('Account name')}
                                onChange={(event) => setName(event.target.value)}
                                onInput={(event) => setName(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape') {
                                    event.stopPropagation();
                                    setEditing(null);
                                  }
                                }}
                                onBlur={() => commitName(account)}
                              />
                            </form>
                          ) : (
                            <button
                              type="button"
                              className="provider-account-name"
                              disabled={pending}
                              aria-label={t('Rename account {{name}}', { name: account.label })}
                              title={t('Rename account')}
                              onClick={() => {
                                setEditing(account.id);
                                setName(account.label);
                              }}
                            >
                              <b>{account.label}</b>
                              <Pencil size={12} aria-hidden="true" />
                            </button>
                          )}
                          {selected && (
                            <span className="settings-status settings-status--positive">
                              <i aria-hidden="true" />
                              {t('In use')}
                            </span>
                          )}
                          {!account.reauthRequired && account.limit && (
                            <span className="settings-status settings-status--danger">
                              <i aria-hidden="true" />
                              {account.limit.scope === 'model'
                                ? t('{{name}} limit', { name: account.limit.families.join(', ') })
                                : t('Limit reached')}
                            </span>
                          )}
                          {account.reauthRequired && (
                            <span className="settings-status settings-status--danger">
                              <i aria-hidden="true" />
                              {t('Reauth required')}
                            </span>
                          )}
                        </div>
                        {(account.email || account.identity) &&
                          (account.email || account.identity) !== account.label && (
                            <small className="provider-account-meta">{account.email || account.identity}</small>
                          )}
                      </div>
                    </div>
                    <AccountUsage account={account} />
                    <div className="settings-resource-actions">
                      {selectable && (
                        <button
                          type="button"
                          className="settings-action provider-account-use"
                          disabled={pending}
                          onClick={() => void change({ selectedId: account.id })}
                        >
                          {t('Use')}
                        </button>
                      )}
                      {renderActions?.(account)}
                    </div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {error && <ErrorNotice error={error} className="provider-accounts-error" />}
    </section>
  );
}
