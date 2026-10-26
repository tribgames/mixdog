import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { type PointerEvent, type RefObject, useRef } from 'react';

import { t } from './i18n';
import { ProviderIcon } from './provider-display';
import { RouteSelectionCheck } from './route-editor-panes';
import {
  authTypeLabel,
  type StudioModelEntry,
  type StudioOptionRow,
  type StudioSliderRow,
  studioModelLanes,
} from './studio-route-menu-model';

/** Safe hover: once a pane is open, only a dwell on another row switches, so
 *  the pointer can travel across intermediate rows into the open flyout. */
export function useStudioRowHoverSwitch() {
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const dwell = (run: () => void) => {
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      run();
    }, 140);
  };
  return { timer, clear, dwell };
}

/** One sheet row: its label and current value, opening its pane beside (or
 *  inside) the sheet on hover or click. */
export function StudioSheetRow({
  id,
  label,
  value,
  disabled = false,
  pane,
  rowButtons,
  hover,
  openPane,
}: {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
  pane: string | null;
  rowButtons: RefObject<Record<string, HTMLButtonElement | null>>;
  hover: { clear(): void; dwell(run: () => void): void };
  openPane(id: string): void;
}) {
  return (
    <button
      ref={(node) => {
        rowButtons.current[id] = node;
      }}
      type="button"
      className="route-sheet-row"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={pane === id}
      disabled={disabled}
      onPointerEnter={(event: PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === 'touch' || pane === id || disabled) return;
        if (pane) {
          hover.dwell(() => openPane(id));
          return;
        }
        openPane(id);
      }}
      onPointerLeave={hover.clear}
      onClick={() => {
        hover.clear();
        // Click always OPENS (hover already opened it — a toggle would close
        // the flyout under the very click that targeted it).
        if (pane !== id) openPane(id);
      }}
    >
      <span className="route-sheet-label">{label}</span>
      <span className="route-sheet-value">{value}</span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  );
}

/** A drilled pane replaced the sheet, so its first row walks back up one
 *  level; a flyout that opened beside the sheet keeps the plain title. */
export function StudioPaneHeader({ drill, label, onBack }: { drill: boolean; label: string; onBack(): void }) {
  return drill ? (
    <button type="button" className="route-sheet-back" aria-label={t('Back')} onClick={onBack}>
      <ChevronLeft size={14} aria-hidden="true" />
      <span>{label}</span>
    </button>
  ) : (
    <div className="route-sheet-flyout-title">{label}</div>
  );
}

/** The model pane: a search over the catalog, the optional Auto choice, and
 *  the models grouped by lane. */
export function StudioModelPane({
  entries,
  lane,
  model,
  auto,
  modelQuery,
  setModelQuery,
  onSelect,
  closeAll,
}: {
  entries: StudioModelEntry[];
  lane: string;
  model: string;
  auto?: { label: string; selected: boolean; onSelect(): void };
  modelQuery: string;
  setModelQuery(value: string): void;
  onSelect(entry: StudioModelEntry): void;
  closeAll(): void;
}) {
  const modelSearch = useRef<HTMLInputElement>(null);
  const { autoVisible, visibleLanes } = studioModelLanes(entries, modelQuery, auto?.label);
  return (
    <div className="model-catalog-list">
      <div className="model-search-wrapper">
        <div className="model-search">
          <div className="model-search-container">
            <Search size={16} aria-hidden="true" />
            <input
              ref={modelSearch}
              type="text"
              value={modelQuery}
              placeholder={t('Search models…')}
              aria-label={t('Search models')}
              autoComplete="off"
              spellCheck={false}
              onInput={(event) => setModelQuery(event.currentTarget.value)}
            />
          </div>
          {modelQuery && (
            <button
              type="button"
              data-component="icon-button"
              onClick={() => {
                setModelQuery('');
                modelSearch.current?.focus();
              }}
              aria-label={t('Clear picker search')}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="model-list">
        {auto && autoVisible && (
          <button
            type="button"
            className="model-option-row"
            role="menuitemradio"
            aria-checked={auto.selected}
            onClick={() => {
              auto.onSelect();
              closeAll();
            }}
          >
            <span className="model-row-copy">
              <span className="model-row-title">
                <strong>{auto.label}</strong>
              </span>
            </span>
            {auto.selected && <RouteSelectionCheck />}
          </button>
        )}
        {visibleLanes.map((group) => (
          <section className="model-group model-group--provider" key={group.id}>
            <h3>
              <span className="model-provider-heading">
                <ProviderIcon provider={group.id} />
                <span>{group.label}</span>
                <small>{authTypeLabel(group.authType)}</small>
              </span>
            </h3>
            <div className="model-items">
              {group.items.map((entry) => {
                const active = !entry.unavailable && entry.lane === lane && entry.model === model;
                return (
                  <button
                    type="button"
                    key={`${entry.lane}/${entry.model}`}
                    className="model-option-row"
                    role="menuitemradio"
                    aria-checked={active}
                    disabled={Boolean(entry.unavailable)}
                    data-unavailable={entry.unavailable ? '' : undefined}
                    data-tooltip={entry.unavailable ? undefined : t('Select model')}
                    onClick={() => {
                      onSelect(entry);
                      closeAll();
                    }}
                  >
                    <span className="model-row-copy">
                      <span className="model-row-title">
                        <strong>{entry.label}</strong>
                      </span>
                      {entry.model && <small className="studio-model-id">{entry.model}</small>}
                      {entry.description && <small className="studio-model-description">{entry.description}</small>}
                    </span>
                    {entry.unavailable && <small className="model-row-unavailable">{entry.unavailable}</small>}
                    {active && <RouteSelectionCheck />}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {visibleLanes.length === 0 && !autoVisible && <p className="model-empty">{t('No matching models.')}</p>}
      </div>
    </div>
  );
}

/** A lane option pane: one radio row per value; picking the current value is a no-op. */
export function StudioOptionPane({ row }: { row: StudioOptionRow }) {
  return row.options.map((option) => {
    const selected = option.value === row.value;
    return (
      <button
        type="button"
        key={option.value}
        className="route-sheet-option"
        role="menuitemradio"
        aria-checked={selected}
        disabled={row.disabled}
        onClick={() => {
          if (!selected) row.onPick(option.value);
        }}
      >
        <span>{option.label}</span>
        {selected && <RouteSelectionCheck />}
      </button>
    );
  });
}

/** The duration pane: a range input with its value in seconds. */
export function StudioSliderPane({ slider }: { slider: StudioSliderRow }) {
  return (
    <label className="route-sheet-slider">
      <input
        type="range"
        min={slider.min}
        max={slider.max}
        value={slider.value}
        disabled={slider.disabled}
        aria-label={t('Duration seconds')}
        onChange={(event) => {
          // Read the value BEFORE any state updater runs (chat-composer
          // slider crash note: currentTarget clears by then).
          const next = Number(event.currentTarget.value);
          slider.onChange(next);
        }}
      />
      <span>{slider.value}s</span>
    </label>
  );
}
