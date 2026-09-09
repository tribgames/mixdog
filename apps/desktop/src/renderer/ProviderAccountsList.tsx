import { Check, GripVertical, Pencil } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { DesktopCapability } from '../shared/contract';
import { t } from './i18n';
import { record } from './record-utils';
import { refreshUsageDashboard, subscribeUsageDashboard, type UsageApi } from './usage-dashboard-store';
import { ProviderIcon } from './provider-display';
import './provider-accounts.css';

export const PROVIDER_ACCOUNTS_CHANGED = 'mixdog:provider-accounts-changed';
export type ProviderAccount = {
  id: string; label: string; authenticated: boolean; reauthRequired: boolean;
  /** Provider-side identity (email / account id) when the token exposes one. */
  identity?: string;
  blockedUntil?: number;
  usage?: { windows?: { label?: string; usedPct: number | null; resetAt?: number }[] };
};
type Pool = { accounts: ProviderAccount[]; selectedId: string | null; auto: boolean };

// Last roster per provider. The rail picker remounts on every open; seeding
// from here paints instantly and the fresh read merely revalidates.
const lastPools = new Map<string, Pool>();

/** Pointer-driven reorder: the grabbed row lifts and follows the pointer; the
 *  rows it passes slide out of its way; release commits the new order. HTML5
 *  drag left the row in place under a translucent ghost (user: 아이템이
 *  들리는 게 아니다), so this owns the gesture itself. */
type DragState = {
  id: string;
  from: number;
  to: number;
  offset: number;      // pointer Y − row top at grab time
  startY: number;
  rowHeight: number;
  y: number;           // current pointer Y
  moved: boolean;
};
const DRAG_THRESHOLD_PX = 4;

export function ProviderAccountsList({ api, provider, title, listOnly = false, renderActions, headerAction, onChange }: {
  api?: UsageApi; provider: string; title?: string;
  listOnly?: boolean;
  renderActions?(account: ProviderAccount): ReactNode;
  headerAction?: ReactNode; onChange?(): void;
}) {
  const [pool, setPoolState] = useState<Pool | null>(() => lastPools.get(provider) ?? null);
  const setPool = useCallback((next: Pool) => { lastPools.set(provider, next); setPoolState(next); }, [provider]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [drag, setDrag] = useState<DragState | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const generation = useRef(0);
  const mutating = useRef(false);
  const invoke = useCallback(async (capability: DesktopCapability, args: unknown[]) => {
    if (!api?.invokeCapability) throw new Error(t('Account controls are unavailable.'));
    const response = await api.invokeCapability({ capability, args });
    const result = record(response.value);
    if (!Array.isArray(result.accounts)) throw new Error(t('Account list could not be loaded.'));
    return result as unknown as Pool;
  }, [api]);
  const load = useCallback(async () => {
    const stamp = ++generation.current;
    try {
      const result = await invoke('getProviderAccounts', [provider]);
      if (generation.current === stamp) { setPool(result); setError(''); }
    } catch (cause) {
      if (generation.current === stamp) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [invoke, provider, setPool]);
  useEffect(() => {
    void load();
    const changed = () => void load();
    window.addEventListener(PROVIDER_ACCOUNTS_CHANGED, changed);
    const unsubscribe = listOnly ? subscribeUsageDashboard(changed) : () => {};
    return () => {
      generation.current += 1;
      unsubscribe();
      window.removeEventListener(PROVIDER_ACCOUNTS_CHANGED, changed);
    };
  }, [load, listOnly]);

  const change = async (value: Record<string, unknown>) => {
    if (mutating.current) return;
    mutating.current = true;
    generation.current += 1;
    setPending(true);
    setError('');
    try {
      setPool(await invoke('updateProviderAccounts', [provider, value]));
      window.dispatchEvent(new window.Event(PROVIDER_ACCOUNTS_CHANGED));
      void refreshUsageDashboard(api, { force: true });
      onChange?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      mutating.current = false;
      setPending(false);
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
    if (state?.moved && liftedRow.current) liftedRow.current.style.transform = `translateY(${state.y - state.startY}px)`;
  };
  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, index: number, id: string) => {
    if (pending || event.button !== 0 || !pool) return;
    const row = event.currentTarget.closest<HTMLElement>('li');
    if (!row) return;
    const rect = row.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    liftedRow.current = row;
    gesture.current = { id, from: index, to: index, offset: event.clientY - rect.top, startY: event.clientY,
      rowHeight: rect.height, y: event.clientY, moved: false };
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
      if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
      if (liftedRow.current) liftedRow.current.style.transform = `translateY(${state.y - state.startY}px)`;
      setDrag({ ...state });
    } else if (typeof requestAnimationFrame !== 'function') {
      paintLift();
    } else if (!frame.current) {
      frame.current = requestAnimationFrame(paintLift);
    }
  };
  const clearGesture = () => {
    if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
    if (liftedRow.current) liftedRow.current.style.transform = '';
    liftedRow.current = null;
    gesture.current = null;
    setDrag(null);
  };
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = gesture.current;
    if (!state) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    const { from, to, moved } = state;
    clearGesture();
    if (moved) reorder(from, to);
  };
  const cancelDrag = () => clearGesture();
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') clearGesture(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging]);
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);
  // Displaced rows between the origin and target slot shift one row height.
  // The lifted row's own transform is written to the DOM by the gesture, so
  // React must NOT set `style.transform` on it — a value here would overwrite
  // the pointer-tracked one on every slot change.
  const rowStyle = (index: number): React.CSSProperties | undefined => {
    if (!drag?.moved || index === drag.from) return undefined;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return { transform: `translateY(-${drag.rowHeight}px)` };
    if (drag.from > drag.to && index >= drag.to && index < drag.from) return { transform: `translateY(${drag.rowHeight}px)` };
    return undefined;
  };

  return <section className={`provider-accounts ${listOnly ? 'is-list-only' : ''} ${drag?.moved ? 'is-dragging' : ''}`.trim()}
    data-account-provider={provider}>
    {title && <header className="provider-accounts-heading">
      <span className="provider-accounts-icon"><ProviderIcon provider={provider} /></span>
      <b>{t(title)}</b>
      {pool && pool.accounts.length > 0 && <small>{t('{{count}} accounts', { count: pool.accounts.length })}</small>}
      <span className="provider-accounts-heading-actions">
        {!listOnly && pool && pool.accounts.length > 1 && <label className="provider-accounts-auto"
          title={t('Move to the next account in this order when the current one is unavailable.')}>
          <span>{t('Auto-switch')}</span>
          <span className="mixdog-settings__switch compact-switch">
            <input type="checkbox" aria-label={t('Switch accounts automatically')} checked={pool.auto} disabled={pending}
              onChange={(event) => void change({ auto: event.target.checked })} /><span aria-hidden="true" />
          </span>
        </label>}
        {headerAction}
      </span>
    </header>}
    {!pool && !error && <div className="provider-accounts-notice" role="status">{t('Loading…')}</div>}
    {pool && !pool.accounts.length && <div className="provider-accounts-notice">{t('No connected accounts.')}</div>}
    <ol className="provider-accounts-list" ref={listRef}>
      {pool?.accounts.map((account, index) => {
        const selected = pool.selectedId === account.id;
        const lifted = drag?.moved && drag.from === index;
        return <li key={account.id} data-account-id={account.id}
          className={`${selected ? 'is-selected' : ''} ${lifted ? 'is-lifted' : ''}`.trim()}
          style={rowStyle(index)}>
          <div className="provider-account-row">
            <button type="button" className="provider-account-grip" disabled={pending}
              aria-label={t('Reorder account {{name}}', { name: t(account.label) })}
              title={t('Drag or use Alt + arrow keys to reorder')}
              onPointerDown={(event) => beginDrag(event, index, account.id)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={cancelDrag}
              onKeyDown={(event) => {
                if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                const to = index + (event.key === 'ArrowUp' ? -1 : 1);
                if (to >= 0 && to < pool.accounts.length) reorder(index, to);
              }}>
              <GripVertical size={14} aria-hidden="true" />
            </button>
            {listOnly
              ? <button type="button" className="provider-account-choice" disabled={pending || !account.authenticated}
                aria-pressed={selected} onClick={() => void change({ selectedId: account.id })}>
                <span>{t(account.label)}</span>
                {account.reauthRequired && <small>{t('Reauth required')}</small>}
                {selected && <Check size={14} aria-label={t('Active')} />}
              </button>
              : <>
                <div className="provider-account-identity">
                  {!selected && account.authenticated && !account.reauthRequired && editing !== account.id &&
                    <button type="button" className="provider-account-select" disabled={pending}
                      aria-label={t('Use account {{name}}', { name: t(account.label) })}
                      onClick={() => void change({ selectedId: account.id })} />}
                  <div className="provider-account-copy">
                    <div className="provider-account-title">
                      {editing === account.id
                        ? <form onSubmit={(event) => { event.preventDefault(); commitName(account); }}>
                          <input autoFocus value={name} maxLength={80} aria-label={t('Account name')}
                            onChange={(event) => setName(event.target.value)}
                            onInput={(event) => setName(event.currentTarget.value)}
                            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(null); } }}
                            onBlur={() => commitName(account)} />
                        </form>
                        : <button type="button" className="provider-account-name" disabled={pending}
                          aria-label={t('Rename account {{name}}', { name: t(account.label) })}
                          title={t('Rename account')} onClick={() => { setEditing(account.id); setName(account.label); }}>
                          <b>{t(account.label)}</b><Pencil size={12} aria-hidden="true" />
                        </button>}
                      {selected && <span className="settings-status settings-status--positive"><i aria-hidden="true" />{t('In use')}</span>}
                      {account.reauthRequired && <span className="settings-status settings-status--danger"><i aria-hidden="true" />{t('Reauth required')}</span>}
                    </div>
                    {account.identity && account.identity !== account.label &&
                      <small className="provider-account-meta">{account.identity}</small>}
                  </div>
                </div>
                <div className="settings-resource-actions">
                  {!selected && account.authenticated && !account.reauthRequired &&
                    <button type="button" className="settings-action" disabled={pending}
                      onClick={() => void change({ selectedId: account.id })}>{t('Use')}</button>}
                  {renderActions?.(account)}
                </div>
              </>}
          </div>
        </li>;
      })}
    </ol>
    {error && <div className="provider-accounts-error" role="alert">{t(error)}</div>}
  </section>;
}
