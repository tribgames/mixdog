import { GripVertical, Plus, X } from 'lucide-react';
import { useRef } from 'react';
import type { DesktopModelOption, DesktopModelSelection } from '../shared/contract';
import { canonicalJson } from '../shared/remote-view-resume';
import type { RecordValue } from './desktop-types';
import { ModelRouteEditor } from './ModelRouteEditor';
import { t } from './i18n';
import { canonicalRouteProvider, routeChain } from '../../../../src/runtime/shared/model-route-chain.mjs';
import './route-chain-editor.css';

export function routeChainComplete(route: RecordValue) {
  return routeChain(route).every((entry) => Boolean(entry.provider && entry.model));
}

/** The route to submit: its fallback list goes only when the rows differ from the
 *  loaded ones. A primary-only edit omits it, so the stored list (which may hold
 *  a fallback that is inactive on the new main provider) is kept as it is. */
export function routeWithEditedFallbacks<T extends RecordValue>(route: T, loaded: RecordValue): T {
  // Compared by content, row order kept: rows rebuilt with another key order are unchanged.
  if (canonicalJson(routeChain(route).slice(1)) !== canonicalJson(routeChain(loaded).slice(1))) return route;
  const { fallbacks: _unchanged, ...rest } = route;
  return rest as T;
}

export function RouteChainEditor({
  route,
  models,
  disabled,
  composerParity,
  label,
  fallbacks: allowFallbacks = true,
  providerNames,
  onChange,
}: {
  route: RecordValue;
  models: DesktopModelOption[];
  /** Setup-derived custom provider names (customProviderDisplayNames), keyed by provider id. */
  providerNames?: Record<string, string>;
  disabled: boolean;
  composerParity: boolean;
  label: string;
  /** false for single-model routes: no fallback UI, and the saved value is a plain selection. */
  fallbacks?: boolean;
  onChange(route: RecordValue): void;
}) {
  const rows = allowFallbacks ? routeChain(route) : routeChain(route).slice(0, 1);
  const list = useRef<HTMLDivElement>(null);
  const grabbed = useRef<number | null>(null);
  const save = (next: RecordValue[]) => {
    const [primary, ...fallbacks] = next;
    onChange(allowFallbacks ? { ...primary, fallbacks } : primary);
  };
  const move = (from: number, to: number) => {
    if (disabled || to < 0 || to >= rows.length || from === to) return;
    const next = [...rows];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry);
    // Follow-Main is a primary-only choice.
    if (next.slice(1).some((row) => row.provider === 'default')) return;
    save(next);
    grabbed.current = to;
  };
  const occupied = new Set(rows.map((entry) => canonicalRouteProvider(entry.provider)).filter(Boolean));
  const hasAvailableProvider = models.some(
    (model) => model.provider !== 'default' && !occupied.has(canonicalRouteProvider(model.provider))
  );
  const canAdd = routeChainComplete(route) && hasAvailableProvider;
  return (
    <div className="route-chain-editor" ref={list}>
      <header className="route-chain-heading">
        <div className="schedules-field">
          <span>{t('Model')}</span>
          {allowFallbacks && <small>{t('The first model is used first. If it fails, the next model is used.')}</small>}
        </div>
        {allowFallbacks && (
          <button
            type="button"
            className="route-chain-add"
            disabled={disabled || !canAdd}
            aria-label={t('Add fallback model')}
            title={t('Add fallback model')}
            onClick={() => save([...rows, {}])}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        )}
      </header>
      <ol className="route-chain-list">
        {rows.map((entry, index) => (
          <li
            className="route-chain-row"
            // biome-ignore lint/suspicious/noArrayIndexKey: fallback entries have no id; rows are positional (reordered by index) and edits save the whole list.
            key={index}
            data-route-index={index}
          >
            {allowFallbacks && (
              <button
                type="button"
                className="route-chain-handle"
                disabled={disabled || rows.length < 2}
                aria-label={t('Reorder model {{number}}', { number: index + 1 })}
                title={t('Drag or use Alt + arrow keys to reorder')}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  grabbed.current = index;
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (grabbed.current === null) return;
                  const elements = list.current?.querySelectorAll<HTMLElement>('.route-chain-row');
                  elements?.forEach((element, target) => {
                    const rect = element.getBoundingClientRect();
                    if (event.clientY >= rect.top && event.clientY < rect.bottom && grabbed.current !== null)
                      move(grabbed.current, target);
                  });
                }}
                onPointerUp={() => {
                  grabbed.current = null;
                }}
                onPointerCancel={() => {
                  grabbed.current = null;
                }}
                onLostPointerCapture={() => {
                  grabbed.current = null;
                }}
                onKeyDown={(event) => {
                  if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                  event.preventDefault();
                  move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
                  grabbed.current = null;
                }}
              >
                <GripVertical size={14} aria-hidden="true" />
              </button>
            )}
            <ModelRouteEditor
              ariaLabel={`${label} ${index + 1}`}
              disabled={disabled}
              composerParity={composerParity}
              providerNames={providerNames}
              // A chain row sits in a narrow panel or dialog column: the picker
              // drops down under its chip instead of flying out beside it.
              dropdown
              value={entry as unknown as DesktopModelSelection}
              models={models.filter((model) => {
                const provider = canonicalRouteProvider(model.provider);
                return (
                  (index === 0 || provider !== 'default') &&
                  (!occupied.has(provider) || provider === canonicalRouteProvider(entry.provider))
                );
              })}
              onChange={(selection) =>
                save(rows.map((row, at) => (at === index ? (selection as unknown as RecordValue) : row)))
              }
            />
            {rows.length > 1 && (
              <button
                type="button"
                className="route-chain-remove"
                disabled={disabled}
                aria-label={t('Remove model {{number}}', { number: index + 1 })}
                onClick={() => save(rows.filter((_, at) => at !== index))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ol>
      {rows.length > 1 && !routeChainComplete(route) && (
        <small className="route-chain-hint">{t('Fallback models must use different providers.')}</small>
      )}
      {allowFallbacks && !hasAvailableProvider && (
        <small className="route-chain-unavailable" role="status">
          {t('No other providers are available to add.')}
        </small>
      )}
    </div>
  );
}
