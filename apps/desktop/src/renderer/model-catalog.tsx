import { Check, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { DesktopModelOption } from '../shared/contract';
import { t } from './i18n';
import { PaneSurfaceGate } from './PaneSurfaceGate';
import { record } from './record-utils';
import {
  modelDisplayName,
  modelOptionDescription,
  ProviderIcon,
  providerDisplayName,
  providerDisplayRank,
} from './provider-display';

type RecordValue = Record<string, unknown>;
const RECENT_MODELS_KEY = 'mixdog.desktop-recent-models';
const RECENT_MODELS_LIMIT = 5;

function providerSetupEntries(value: unknown): Array<RecordValue & { group: 'api' | 'oauth' | 'local' }> {
  const setup = record(value);
  return (['api', 'oauth', 'local'] as const).flatMap((group) => {
    const entries = setup[group];
    return Array.isArray(entries) ? entries.map(record)
      .map((entry) => ({ ...entry, group } as RecordValue & { group: typeof group })) : [];
  });
}

export function filterConfiguredModels(
  models: DesktopModelOption[],
  providerSetup: unknown,
  providerSetupError = '',
): DesktopModelOption[] {
  if (providerSetup == null || providerSetupError) return models;
  const entries = providerSetupEntries(providerSetup);
  return models.filter((model) => {
    const provider = entries.find((entry) =>
      String(entry.id || entry.provider || '') === model.provider);
    if (!provider) return false;
    return provider.group === 'local'
      ? provider.detected === true && provider.enabled === true
      : provider.authenticated === true;
  });
}

/** Touch surfaces raise the on-screen keyboard on focus. */
function coarsePointer(): boolean {
  try {
    return window.matchMedia?.('(pointer: coarse)').matches ?? false;
  } catch {
    return false;
  }
}

function modelKey(option: DesktopModelOption, scope = ''): string {
  return `${scope}model:${option.provider}:${option.model}`;
}

function readRecentModelKeys(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_MODELS_KEY) || '[]');
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string')
      .slice(0, RECENT_MODELS_LIMIT) : [];
  } catch {
    return [];
  }
}

function writeRecentModelKeys(keys: string[]): void {
  try {
    window.localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(keys));
  } catch {
    // Selection still works when storage is unavailable.
  }
}

export function ModelCatalog({
  models,
  provider,
  model,
  active = true,
  catalogLoaded = true,
  catalogRefreshing = false,
  catalogError = '',
  providerSetupError = '',
  onSelect,
  onOpenProviders,
  onClose,
}: {
  models: DesktopModelOption[];
  provider: string;
  model: string;
  active?: boolean;
  catalogLoaded?: boolean;
  catalogRefreshing?: boolean;
  catalogError?: string;
  providerSetupError?: string;
  onSelect(option: DesktopModelOption): unknown;
  onOpenProviders?: () => void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [activeRowKey, setActiveRowKey] = useState('');
  const [recentModelKeys, setRecentModelKeys] = useState<string[]>(readRecentModelKeys);
  const dialog = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const modelList = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    setRecentModelKeys(readRecentModelKeys());
    // Opening the list must not summon the keyboard on a phone: it covered
    // half the catalog before a single row was read (user: 검색창 터치도 안
    // 했는데 바로 타이핑창 열리게 하지 말고). The field waits for a tap.
    if (!coarsePointer()) search.current?.focus({ preventScroll: true });
    modelList.current?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'center' });
  }, [active]);
  useEffect(() => {
    if (active && modelList.current) modelList.current.scrollTop = 0;
  }, [active, query]);

  const providerEntries = useMemo(() => {
    const entries = new Map<string, DesktopModelOption[]>();
    for (const option of models) {
      const options = entries.get(option.provider) || [];
      options.push(option);
      entries.set(option.provider, options);
    }
    return [...entries].sort(([left], [right]) =>
      providerDisplayRank(left) - providerDisplayRank(right) ||
      providerDisplayName(left).localeCompare(providerDisplayName(right)) ||
      left.localeCompare(right));
  }, [models]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchesQuery = (option: DesktopModelOption) => !normalizedQuery ||
    `${option.model} ${option.display} ${modelDisplayName(option.model, option.provider, option.display)} ${modelOptionDescription(option)}`
      .toLocaleLowerCase().includes(normalizedQuery);
  const visibleProviderEntries = providerEntries
    .map(([entryProvider, options]) => [entryProvider, options.filter(matchesQuery)] as const)
    .filter(([, options]) => options.length > 0);
  const recentModels = recentModelKeys.flatMap((key) => {
    const option = models.find((entry) => modelKey(entry) === key);
    return option && matchesQuery(option) ? [option] : [];
  });
  const renderedKeys = [
    ...recentModels.map((option) => modelKey(option, 'recent:')),
    ...visibleProviderEntries.flatMap(([, options]) => options.map((option) => modelKey(option))),
  ];

  useEffect(() => {
    if (!active) return;
    const recent = recentModels.find((option) =>
      option.provider === provider && option.model === model);
    if (recent) {
      setActiveRowKey(modelKey(recent, 'recent:'));
      return;
    }
    const visibleModels = visibleProviderEntries.flatMap(([, options]) => options);
    const preferred = visibleModels.find((option) =>
      option.provider === provider && option.model === model) || visibleModels[0];
    setActiveRowKey(preferred ? modelKey(preferred) : '');
  }, [active, model, normalizedQuery, models, provider, recentModelKeys]);

  const focusRow = (index: number) => {
    const options = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>(
      '.model-list [role="option"]',
    ) || []);
    const target = options[Math.max(0, Math.min(index, options.length - 1))];
    if (!target) return;
    setActiveRowKey(target.dataset.rowKey || '');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  };
  const navigateRows = (event: React.KeyboardEvent, fromSearch = false) => {
    if (event.key === 'Enter' && fromSearch) {
      const target = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>(
        '.model-list [role="option"]',
      ) || []).find((option) => option.dataset.rowKey === activeRowKey);
      if (target) {
        event.preventDefault();
        target.click();
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>(
      '.model-list [role="option"]',
    ) || []);
    if (!options.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') return focusRow(0);
    if (event.key === 'End') return focusRow(options.length - 1);
    if (fromSearch) {
      const initialized = options.findIndex((option) => option.dataset.rowKey === activeRowKey);
      return focusRow(initialized >= 0 ? initialized : event.key === 'ArrowDown' ? 0 : options.length - 1);
    }
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    focusRow(current + (event.key === 'ArrowDown' ? 1 : -1));
  };
  const choose = async (option: DesktopModelOption) => {
    const previous = recentModelKeys;
    const key = modelKey(option);
    const next = [key, ...previous.filter((entry) => entry !== key)].slice(0, RECENT_MODELS_LIMIT);
    setRecentModelKeys(next);
    writeRecentModelKeys(next);
    try {
      const selected = await onSelect(option);
      if (selected === false) {
        setRecentModelKeys(previous);
        writeRecentModelKeys(previous);
        return;
      }
    } catch {
      setRecentModelKeys(previous);
      writeRecentModelKeys(previous);
      return;
    } finally {
      onClose();
    }
  };
  const renderModelOption = (option: DesktopModelOption, scope = '') => {
    const selected = option.provider === provider && option.model === model;
    const key = modelKey(option, scope);
    return <button type="button" className="model-option-row" role="option"
      aria-selected={selected} key={key} data-row-key={key}
      data-active={activeRowKey === key} tabIndex={activeRowKey === key ? 0 : -1}
      onKeyDown={(event) => navigateRows(event)}
      onMouseMove={() => setActiveRowKey(key)}
      onClick={() => void choose(option)}>
      <span className="model-row-copy">
        <span className="model-row-title"><strong>
          {modelDisplayName(option.model, option.provider, option.display)}
          {scope === 'recent:' && <span className="model-row-source">
            {' (' + providerDisplayName(option.provider) + ')'}
          </span>}
        </strong></span>
      </span>
      {selected && <span className="route-selection-check">
        <Check size={14} aria-hidden="true" />
      </span>}
    </button>;
  };

  return <section ref={dialog} className="model-catalog-panel"
    role="dialog" aria-modal="false" aria-label={t('Select model')} tabIndex={-1}>
    <div className="model-catalog-body">
      <PaneSurfaceGate ready={catalogLoaded || models.length > 0} label={t('Loading models…')}>
        <div className="model-catalog-list">
          <div className="model-search-wrapper">
            <div className="model-search">
              <div className="model-search-container">
                <Search size={16} aria-hidden="true" />
                <input ref={search} type="text" value={query}
                  placeholder={t('Search models…')} aria-label={t('Search models')}
                  autoComplete="off" spellCheck={false}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => navigateRows(event, true)} />
              </div>
              {query && <button type="button" data-component="icon-button"
                onClick={() => { setQuery(''); search.current?.focus(); }}
                aria-label={t('Clear picker search')}><X size={14} /></button>}
            </div>
            {onOpenProviders && <button type="button" className="model-provider-add"
              aria-label={t('Add provider')} data-tooltip={t('Add provider')}
              onClick={onOpenProviders}><Plus size={16} aria-hidden="true" /></button>}
          </div>
          <div ref={modelList} className="model-list" role="listbox" aria-label={t('Available models')}>
            {catalogError && <p className="model-notice model-notice--error" role="alert">
              {t('Model catalog unavailable: {{error}}', { error: catalogError })}
            </p>}
            {providerSetupError && <p className="model-notice" role="status">
              {t('Provider status is temporarily unavailable. Try again.')}
            </p>}
            {renderedKeys.length === 0 && <p className="model-empty">
              {catalogRefreshing || !catalogLoaded
                ? t('Loading models…')
                : normalizedQuery ? t('No matching models.') : t('No connected provider models.')}
            </p>}
            {recentModels.length > 0 && <section className="model-group model-group--recent">
              <h3>RECENT</h3>
              <div className="model-items">{recentModels.map((option) => renderModelOption(option, 'recent:'))}</div>
            </section>}
            {visibleProviderEntries.map(([entryProvider, options]) =>
              <section className="model-group model-group--provider" key={entryProvider}>
                <h3><span className="model-provider-heading">
                  <ProviderIcon provider={entryProvider} />
                  <span>{providerDisplayName(entryProvider)}</span>
                </span></h3>
                <div className="model-items">{options.map((option) => renderModelOption(option))}</div>
              </section>)}
          </div>
        </div>
      </PaneSurfaceGate>
    </div>
  </section>;
}
