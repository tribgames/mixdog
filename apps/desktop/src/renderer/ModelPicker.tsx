import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Plus, Search, X } from 'lucide-react';
import { createPortal } from 'react-dom';

import type { DesktopModelOption } from '../shared/contract';
import { focusTrapIndex } from './renderer-logic.mjs';
import {
  modelDisplayName,
  modelOptionDescription,
  ProviderIcon,
  providerDisplayName,
  providerDisplayRank,
} from './provider-display';
import { acquireModalLayer } from './modal-layer';

type RecordValue = Record<string, unknown>;
type PickerStage = 'providers' | 'models';

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

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

function modelKey(option: DesktopModelOption): string {
  return `model:${option.provider}:${option.model}`;
}

function providerKey(provider: string): string {
  return `provider:${provider}`;
}

interface ModelPickerProps {
  models: DesktopModelOption[];
  provider: string;
  model: string;
  triggerLabel: string;
  ariaLabel?: string;
  triggerClassName?: string;
  popoverId?: string;
  disabled?: boolean;
  catalogLoaded?: boolean;
  catalogRefreshing?: boolean;
  catalogError?: string;
  providerSetupError?: string;
  tooltip?: string;
  onOpen?: () => void;
  onSelect(option: DesktopModelOption): unknown;
  onOpenProviders?: () => void;
}

export function ModelPicker({
  models,
  provider,
  model,
  triggerLabel,
  ariaLabel = 'Choose model',
  triggerClassName = 'model-trigger',
  popoverId,
  disabled = false,
  catalogLoaded = true,
  catalogRefreshing = false,
  catalogError = '',
  providerSetupError = '',
  tooltip = 'Choose model',
  onOpen,
  onSelect,
  onOpenProviders,
}: ModelPickerProps) {
  const generatedId = useId().replace(/:/g, '');
  const dialogId = popoverId || `model-selector-${generatedId}`;
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<PickerStage>('providers');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [query, setQuery] = useState('');
  const [activeRowKey, setActiveRowKey] = useState('');
  // Match the TUI freshness boundary: once a non-empty catalog is rendered,
  // do not reorder it under the pointer. A background refresh is adopted on
  // the next open instead.
  const [openModels, setOpenModels] = useState<DesktopModelOption[]>([]);
  const stageRef = useRef<PickerStage>('providers');
  stageRef.current = stage;
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const pickerLayer = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const modelList = useRef<HTMLDivElement>(null);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setStage('providers');
    setSelectedProvider('');
    setQuery('');
    setActiveRowKey('');
    setOpenModels([]);
    if (restoreFocus) {
      window.setTimeout(() => trigger.current?.focus({ preventScroll: true }), 0);
    }
  }, []);

  const backToProviders = useCallback(() => {
    setStage('providers');
    setSelectedProvider('');
    setQuery('');
    setActiveRowKey('');
    window.setTimeout(() => search.current?.focus({ preventScroll: true }), 0);
  }, []);

  const showProviderModels = useCallback((nextProvider: string) => {
    setSelectedProvider(nextProvider);
    setStage('models');
    setQuery('');
    setActiveRowKey('');
    window.setTimeout(() => search.current?.focus({ preventScroll: true }), 0);
  }, []);

  useEffect(() => {
    if (!open || openModels.length > 0 || models.length === 0) return;
    setOpenModels(models);
  }, [models, open, openModels.length]);

  useEffect(() => {
    if (!open) return;
    const backgrounds = [
      document.querySelector<HTMLElement>('.app-shell'),
      trigger.current?.closest<HTMLElement>('.mixdog-settings'),
    ].filter((entry, index, values): entry is HTMLElement =>
      Boolean(entry) && values.indexOf(entry) === index);
    const layer = acquireModalLayer(backgrounds);
    layer.attachSurface(pickerLayer.current);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!dialog.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (stageRef.current === 'models') backToProviders();
        else close(true);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || []);
      if (!focusable.length) {
        event.preventDefault();
        dialog.current?.focus();
        return;
      }
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      focusable[focusTrapIndex(current, focusable.length, event.shiftKey)]?.focus();
    };
    search.current?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      layer.release();
    };
  }, [backToProviders, close, open]);

  useLayoutEffect(() => {
    if (!open || !modelList.current) return;
    modelList.current.scrollTop = 0;
  }, [open, query, selectedProvider, stage]);

  useEffect(() => {
    if (disabled && open) close();
  }, [close, disabled, open]);

  const providerEntries = useMemo(() => {
    const entries = new Map<string, DesktopModelOption[]>();
    for (const option of openModels) {
      const options = entries.get(option.provider) || [];
      options.push(option);
      entries.set(option.provider, options);
    }
    return [...entries].sort(([left], [right]) =>
      providerDisplayRank(left) - providerDisplayRank(right) ||
      providerDisplayName(left).localeCompare(providerDisplayName(right)) ||
      left.localeCompare(right));
  }, [openModels]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProviders = providerEntries.filter(([entryProvider, options]) => !normalizedQuery ||
    `${entryProvider} ${providerDisplayName(entryProvider)} ${options.map((option) =>
      `${option.model} ${option.display} ${modelDisplayName(option.model, option.provider, option.display)}`).join(' ')}`
      .toLocaleLowerCase().includes(normalizedQuery));
  const providerModels = providerEntries.find(([entryProvider]) =>
    entryProvider === selectedProvider)?.[1] || [];
  const visibleModels = providerModels.filter((option) => !normalizedQuery ||
    `${option.model} ${option.display} ${modelDisplayName(option.model, option.provider, option.display)} ${modelOptionDescription(option)}`
      .toLocaleLowerCase().includes(normalizedQuery));
  const renderedKeys = stage === 'providers'
    ? visibleProviders.map(([entryProvider]) => providerKey(entryProvider))
    : visibleModels.map(modelKey);

  useEffect(() => {
    if (!open) return;
    if (stage === 'providers') {
      const preferred = visibleProviders.find(([entryProvider]) => entryProvider === provider) || visibleProviders[0];
      setActiveRowKey(preferred ? providerKey(preferred[0]) : '');
      return;
    }
    const preferred = visibleModels.find((option) =>
      option.provider === provider && option.model === model) || visibleModels[0];
    setActiveRowKey(preferred ? modelKey(preferred) : '');
  }, [model, normalizedQuery, open, openModels, provider, selectedProvider, stage]);

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
    close();
    try {
      await onSelect(option);
    } finally {
      window.setTimeout(() => trigger.current?.focus({ preventScroll: true }), 0);
    }
  };

  return <>
    <button ref={trigger} type="button" className={triggerClassName}
      disabled={disabled} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={dialogId} data-tooltip={tooltip} data-tooltip-side="top"
      onClick={() => {
        if (open) close();
        else {
          onOpen?.();
          setStage('providers');
          setSelectedProvider('');
          setQuery('');
          setActiveRowKey('');
          setOpenModels(models);
          setOpen(true);
        }
      }}>
      <span>{triggerLabel}</span>
      <ChevronDown size={13} />
    </button>
    {open && createPortal(
      <div ref={pickerLayer} className="model-picker-layer" onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}>
        <section ref={dialog} id={dialogId} className="model-picker-dialog"
          data-component="dialog" data-stage={stage} role="dialog" aria-modal="true"
          aria-labelledby={`${dialogId}-title`} tabIndex={-1}>
          <header className="model-picker-header" data-slot="dialog-header">
            {stage === 'models' && <button type="button" className="model-back"
              aria-label="Back to providers" data-tooltip="Back to providers"
              onClick={backToProviders}>
              <ChevronLeft size={16} aria-hidden="true" />
            </button>}
            <h2 id={`${dialogId}-title`} data-slot="dialog-title">
              {stage === 'providers' ? 'Select model' : providerDisplayName(selectedProvider)}
            </h2>
            {onOpenProviders && <button type="button" className="model-provider-add" aria-label="Add provider"
              data-tooltip="Add provider" onClick={() => {
                close();
                onOpenProviders();
              }}>
              <Plus size={16} aria-hidden="true" />
            </button>}
          </header>
          <div className="model-picker-body" data-slot="dialog-body">
            <div className="model-picker-list" data-component="list">
              <div className="model-search-wrapper" data-slot="list-search-wrapper">
                <div className="model-search" data-slot="list-search">
                  <div className="model-search-container" data-slot="list-search-container">
                    <Search size={16} aria-hidden="true" />
                    <input ref={search} type="text" value={query} data-slot="list-search-input"
                      placeholder={stage === 'providers'
                        ? 'Search providers…'
                        : `Search ${providerDisplayName(selectedProvider)} models…`}
                      aria-label={stage === 'providers' ? 'Search providers' : 'Search models'}
                      autoComplete="off" spellCheck={false}
                      onInput={(event) => setQuery(event.currentTarget.value)}
                      onKeyDown={(event) => navigateRows(event, true)} />
                  </div>
                  {query && <button type="button" data-component="icon-button"
                    onClick={() => { setQuery(''); search.current?.focus(); }} aria-label="Clear picker search">
                    <X size={14} />
                  </button>}
                </div>
              </div>
              <div ref={modelList} className="model-list" data-slot="list-scroll" role="listbox"
                aria-label={stage === 'providers'
                  ? 'Available providers'
                  : `Models from ${providerDisplayName(selectedProvider)}`}>
                {catalogError && <p className="model-notice model-notice--error" role="alert">
                  Model catalog unavailable: {catalogError}
                </p>}
                {providerSetupError && <p className="model-notice" role="status">
                  Provider status unavailable: {providerSetupError}
                </p>}
                {stage === 'providers' ? <>
                  {visibleProviders.length === 0 && <p className="model-empty">
                    {catalogRefreshing || !catalogLoaded
                      ? 'Loading providers…'
                      : normalizedQuery ? 'No matching providers.' : 'No connected provider models.'}
                  </p>}
                  <div className="model-items model-provider-items" data-slot="list-items">
                    {visibleProviders.map(([entryProvider, options]) => {
                      const active = entryProvider === provider;
                      const key = providerKey(entryProvider);
                      const current = active
                        ? options.find((option) => option.model === model)
                        : undefined;
                      return <button type="button" className="model-provider-row" role="option"
                        aria-selected={active} key={key} data-row-key={key}
                        data-active={activeRowKey === key} tabIndex={activeRowKey === key ? 0 : -1}
                        onKeyDown={(event) => navigateRows(event)}
                        onMouseMove={() => setActiveRowKey(key)}
                        onClick={() => showProviderModels(entryProvider)}>
                        <ProviderIcon className="provider-icon" provider={entryProvider} />
                        <span className="model-row-copy">
                          <strong>{providerDisplayName(entryProvider)}</strong>
                          <small>{current
                            ? `Current · ${modelDisplayName(current.model, current.provider, current.display)}`
                            : `${options.length} ${options.length === 1 ? 'model' : 'models'}`}</small>
                        </span>
                        {current && <Check size={15} aria-hidden="true" />}
                        <ChevronRight className="model-provider-chevron" size={15} aria-hidden="true" />
                      </button>;
                    })}
                  </div>
                </> : <>
                  <div className="model-list-heading" aria-hidden="true">
                    <ProviderIcon className="provider-icon" provider={selectedProvider} />
                    <span>{providerDisplayName(selectedProvider)}</span>
                    <small>{providerModels.length} {providerModels.length === 1 ? 'model' : 'models'}</small>
                  </div>
                  {visibleModels.length === 0 && <p className="model-empty">No matching models.</p>}
                  <div className="model-items" data-slot="list-items">
                    {visibleModels.map((option) => {
                      const active = option.provider === provider && option.model === model;
                      const key = modelKey(option);
                      return <button type="button" className="model-option-row" role="option"
                        aria-selected={active} key={key} data-row-key={key}
                        data-active={activeRowKey === key} tabIndex={activeRowKey === key ? 0 : -1}
                        onKeyDown={(event) => navigateRows(event)}
                        onMouseMove={() => setActiveRowKey(key)}
                        onClick={() => void choose(option)}>
                        <span className="model-row-copy">
                          <span className="model-row-title">
                            <strong>{modelDisplayName(option.model, option.provider, option.display)}</strong>
                            {option.latest && <small className="model-tag">Latest</small>}
                          </span>
                          <small>{modelOptionDescription(option)}</small>
                        </span>
                        {active && <span className="list-item-selected-icon" data-slot="list-item-selected-icon">
                          <Check size={16} aria-hidden="true" />
                        </span>}
                      </button>;
                    })}
                  </div>
                </>}
                {catalogRefreshing && renderedKeys.length > 0 &&
                  <p className="model-loading" role="status">Updating model catalog…</p>}
              </div>
            </div>
          </div>
        </section>
      </div>,
      document.body,
    )}
  </>;
}
