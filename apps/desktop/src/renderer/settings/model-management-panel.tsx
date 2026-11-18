import { ChevronRight, RefreshCw, Search, Star, X } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { DesktopModelOption } from '../../shared/contract';
import { errorMessage } from '../editor-pane-session-errors';
import { t } from '../i18n';
import { scrimDismiss } from '../scrim-dismiss';
import { ErrorNotice, errorSummary } from '../ErrorNotice';
import {
  connectedProviderEntries,
  customProviderDisplayNames,
  providerCatalogFailure,
  resolveProviderDisplayName,
} from '../model-catalog';
import {
  heldModelManagementCatalog,
  readModelManagementCatalog,
  subscribeModelManagementCatalog,
} from '../model-catalog-cache';
import {
  autoHiddenModelKeys,
  customModelHiddenFlags,
  explicitModelHidden,
  modelKey,
  modelListed,
  modelPreferenceChanges,
  orderModelsByRecency,
  takeRequestedModelManagementProvider,
  type ModelPreferenceChange,
  type ModelPreferenceState,
} from '../model-visibility';
import { modelDisplayName } from '../provider-display';
import { record } from '../record-utils';
import { ActionButton, Group, ListEmpty } from './capability-controls';
import { sectionLoaded, type PanelContext, type RecordValue } from './capability-data';
import { providerPageOrder } from './custom-provider-section';

/** One model row of the card, with its saved state. */
export interface ManagedModel {
  model: string;
  name: string;
  /** Left out of /model by the family limit, with no explicit choice. */
  autoHidden: boolean;
  saved: ModelPreferenceState;
}

/** A connected provider and its models, as Model management lists them. */
export interface ManagedProvider {
  id: string;
  name: string;
  kind: string;
  models: ManagedModel[];
  shown: number;
  /** Why the provider's model list failed (ErrorNotice's input); null when it did not. */
  catalogError: unknown;
  clientManagedVisibility?: boolean;
}

function providerKind(entry: RecordValue): string {
  if (entry.custom === true) return t('Custom provider');
  if (entry.group === 'oauth') return t('OAuth');
  if (entry.group === 'local') return t('Local');
  return t('API key');
}

/** Connected providers with their models (newest first) and saved states.
 *  Unconnected providers are not listed at all. */
export function modelManagementProviders(data: Record<string, unknown>): ManagedProvider[] {
  const setup = data.providerSetup;
  const catalog = orderModelsByRecency(Array.isArray(data.models) ? (data.models as DesktopModelOption[]) : []);
  const autoHidden = autoHiddenModelKeys(catalog);
  const customFlags = customModelHiddenFlags(setup);
  const names = customProviderDisplayNames(setup);
  // The Providers page's order, not the setup's api/oauth/local grouping.
  const order = providerPageOrder(record(setup));
  const rank = (entry: RecordValue) => {
    const index = order.indexOf(String(entry.id || entry.provider || ''));
    return index < 0 ? order.length : index;
  };
  const connected = connectedProviderEntries(setup).sort((a, b) => rank(a) - rank(b));
  return connected.map((entry) => {
    const id = String(entry.id || entry.provider || '');
    const hiddenFavorites = new Set(Array.isArray(entry.hiddenFavoriteModels) ? entry.hiddenFavoriteModels : []);
    const hiddenModels = new Map<string, string>();
    if (entry.custom === true) {
      for (const raw of Array.isArray(entry.models) ? entry.models : []) {
        const row = record(raw);
        if (typeof row.id === 'string' && row.hidden === true) {
          hiddenModels.set(row.id, String(row.name || row.id));
        }
      }
      for (const [model, raw] of Object.entries(record(entry.modelOverrides))) {
        const over = record(raw);
        if (over.hidden === true) {
          hiddenModels.set(model, String(over.name || hiddenModels.get(model) || model).trim() || model);
        }
        if (over.hidden === false) hiddenModels.delete(model);
      }
    }
    const models: ManagedModel[] = catalog
      .filter((option) => option.provider === id)
      .map((option) => {
        const hidden = hiddenModels.has(option.model);
        return {
          model: option.model,
          name: modelDisplayName(option.model, option.provider, option.display),
          autoHidden:
            !hidden &&
            autoHidden.has(modelKey(option.provider, option.model)) &&
            explicitModelHidden(option, customFlags) === undefined,
          saved: {
            shown: !hidden && modelListed(option, autoHidden, customFlags),
            favorite: hidden ? hiddenFavorites.has(option.model) : option.favorite === true,
          },
        };
      });
    // A hidden custom model leaves the runtime catalog; its override still
    // names it, so it can be checked again here.
    for (const [model, name] of hiddenModels) {
      if (models.some((row) => row.model === model)) continue;
      models.push({
        model,
        name,
        autoHidden: false,
        saved: { shown: false, favorite: hiddenFavorites.has(model) },
      });
    }
    return {
      id,
      name: resolveProviderDisplayName(id, names),
      kind: providerKind(entry),
      models,
      shown: models.filter((row) => row.saved.shown).length,
      catalogError: providerCatalogFailure(entry),
      clientManagedVisibility: entry.custom === true && record(setup).managedByClient === true,
    };
  });
}

function shownLabel(shown: number, total: number): string {
  return t('{{shown}} / {{total}} shown', { shown, total });
}

export function ModelManagementPanel({ api, data, snapshot, run }: PanelContext) {
  const subscribe = useCallback((listener: () => void) => subscribeModelManagementCatalog(api, listener), [api]);
  const getModels = useCallback(() => heldModelManagementCatalog(api), [api]);
  const models = useSyncExternalStore(subscribe, getModels) ?? data.models;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [openId, setOpenId] = useState(takeRequestedModelManagementProvider);
  const setup = record(data.providerSetup);
  const ready =
    sectionLoaded(data, 'providerSetup') &&
    setup.unavailable !== true &&
    [setup.api, setup.oauth, setup.local].some(Array.isArray) &&
    Array.isArray(models);
  const pendingSetup = setup.pendingSecrets === true;
  const lastProviders = useRef(new Map<string, ManagedProvider>());
  const providers = useMemo(() => {
    // While the data reloads, the list (and any open card) stays as it was.
    if (!ready) return [...lastProviders.current.values()];
    const next = modelManagementProviders({ ...data, models });
    if (pendingSetup) {
      const seen = new Set(next.map((provider) => provider.id));
      next.push(...[...lastProviders.current.values()].filter((provider) => !seen.has(provider.id)));
    }
    lastProviders.current = new Map(next.map((provider) => [provider.id, provider]));
    return next;
  }, [data, models, ready, pendingSetup]);
  const found = providers.find((provider) => provider.id === openId) || null;
  const openSnapshot = useRef<ManagedProvider | null>(null);
  if (found) openSnapshot.current = found;
  // A provider that vanishes under an open card keeps the card (with a notice).
  const open = found ?? (openId && openSnapshot.current?.id === openId ? openSnapshot.current : null);
  if (!ready && !open) {
    return (
      <div className="settings-panel-placeholder" role="status" aria-busy="true">
        <span>{t('Loading providers…')}</span>
      </div>
    );
  }
  const active = record(snapshot);
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await readModelManagementCatalog(api, true);
    } catch (error) {
      setRefreshError(error);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <>
      <Group title={t('Connected providers')}>
        {providers.length === 0 && <ListEmpty text={t('No connected providers.')} />}
        {providers.map((provider) => (
          <button
            type="button"
            key={provider.id}
            className="model-mgmt-provider"
            data-model-provider={provider.id}
            onClick={() => setOpenId(provider.id)}
          >
            <span className="model-mgmt-provider-copy">
              <b>{provider.name}</b>
              <small>{provider.kind}</small>
              {provider.catalogError != null && (
                <small className="model-mgmt-provider-error">{errorSummary(provider.catalogError)}</small>
              )}
            </span>
            <span className="model-mgmt-provider-count">{shownLabel(provider.shown, provider.models.length)}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        ))}
      </Group>
      {open && (
        <ModelManagementCard
          key={open.id}
          provider={open}
          disconnected={!found}
          inUse={active.provider === open.id ? String(active.model || '') : ''}
          refreshing={refreshing}
          refreshError={refreshError}
          onRefresh={() => void refresh()}
          onSave={async (changes) => {
            await run('setModelPreferences', [open.id, changes], 'model-preferences', true, false, 'throw');
          }}
          onClose={() => setOpenId('')}
        />
      )}
    </>
  );
}

type ModelFilter = 'all' | 'shown' | 'hidden' | 'inuse';

const FILTERS: ReadonlyArray<readonly [ModelFilter, string]> = [
  ['all', 'All'],
  ['shown', 'Shown'],
  ['hidden', 'Hidden'],
  ['inuse', 'In use'],
];

const PAGE_SIZE = 100;

/** The provider's card over the list (settings detail dialog): X / Cancel
 *  discard, Save applies every pending change at once. */
export function ModelManagementCard({
  provider,
  disconnected = false,
  inUse,
  refreshing,
  refreshError,
  onRefresh,
  onSave,
  onClose,
}: {
  provider: ManagedProvider;
  /** The provider left the connected list while the card was open. */
  disconnected?: boolean;
  /** The model the current route runs on this provider, '' when none. */
  inUse: string;
  refreshing: boolean;
  refreshError: unknown;
  onRefresh(): void;
  onSave(changes: ModelPreferenceChange[]): Promise<void>;
  onClose(): void;
}) {
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ModelFilter>('all');
  const [edits, setEdits] = useState<ReadonlyMap<string, Partial<ModelPreferenceState>>>(new Map());
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const stateOf = (row: ManagedModel) => ({ ...row.saved, ...edits.get(row.model) });
  const changes = modelPreferenceChanges(
    new Map(provider.models.map((row) => [row.model, row.saved])),
    new Map(provider.models.map((row) => [row.model, stateOf(row)]))
  );
  const shown = provider.models.filter((row) => stateOf(row).shown).length;
  const failedEmpty = provider.catalogError != null && provider.models.length === 0;
  const needle = query.trim().toLocaleLowerCase();
  const rows = provider.models.filter((row) => {
    if (needle && !`${row.name} ${row.model}`.toLocaleLowerCase().includes(needle)) return false;
    if (filter === 'shown') return stateOf(row).shown;
    if (filter === 'hidden') return !stateOf(row).shown;
    if (filter === 'inuse') return row.model === inUse;
    return true;
  });
  const edit = (targets: readonly ManagedModel[], patch: Partial<ModelPreferenceState>) =>
    setEdits((current) => {
      const next = new Map(current);
      for (const row of targets) {
        const draft = { ...current.get(row.model), ...patch };
        if (patch.shown === row.saved.shown) delete draft.shown;
        if (patch.favorite === row.saved.favorite) delete draft.favorite;
        next.set(row.model, draft);
      }
      return next;
    });
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave(changes);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    // Scrim click-to-dismiss; keyboard dismissal is the close button and Escape.
    <div
      className="settings-oauth-layer"
      {...scrimDismiss(() => {
        if (!saving) onClose();
      })}
    >
      <section
        className="settings-oauth-dialog model-mgmt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-settings-nested-dialog
        data-model-card={provider.id}
      >
        <header>
          <div>
            <h3 id={titleId}>{provider.name}</h3>
          </div>
          <button type="button" aria-label={t('Close')} data-settings-nested-close disabled={saving} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="model-mgmt-dialog-body">
          <div className="model-mgmt-head">
            <h4>{t('Models')}</h4>
            <p>{shownLabel(shown, provider.models.length)}</p>
          </div>
          <div className="model-mgmt-tools">
            <div className="model-mgmt-tools-top">
              <label className="model-mgmt-search">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  placeholder={t('Search model name or ID')}
                  aria-label={t('Search models')}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setLimit(PAGE_SIZE);
                  }}
                />
              </label>
              <ActionButton disabled={refreshing || saving} onClick={onRefresh}>
                <RefreshCw size={14} aria-hidden="true" />
                {t('Refresh models')}
              </ActionButton>
            </div>
            <fieldset className="model-mgmt-chips" aria-label={t('Filter')}>
              {FILTERS.map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => {
                    setFilter(value);
                    setLimit(PAGE_SIZE);
                  }}
                >
                  {t(label)}
                </button>
              ))}
            </fieldset>
            <div className="model-mgmt-bulk">
              <span>{t('{{count}} items', { count: rows.length })}</span>
              <ActionButton
                disabled={saving || provider.clientManagedVisibility || rows.length === 0}
                onClick={() => edit(rows, { shown: true })}
              >
                {t('Select all')}
              </ActionButton>
              <ActionButton
                disabled={saving || provider.clientManagedVisibility || rows.length === 0}
                onClick={() => edit(rows, { shown: false })}
              >
                {t('Deselect all')}
              </ActionButton>
            </div>
          </div>
          {disconnected && (
            <p className="settings-error" role="status">
              {t('Not connected')}
            </p>
          )}
          {refreshError != null && <ErrorNotice error={refreshError} role="status" />}
          {provider.catalogError != null && <ErrorNotice error={provider.catalogError} role="status" />}
          {rows.length === 0 ? (
            // A failed list is explained by the notice above; "No matching models" would hide it.
            !failedEmpty && (
              <div className="model-mgmt-empty">
                <b>{needle ? t('No models match “{{query}}”', { query: query.trim() }) : t('No matching models.')}</b>
                {needle && <ActionButton onClick={() => setQuery('')}>{t('Clear search')}</ActionButton>}
              </div>
            )
          ) : (
            <ul className="model-mgmt-list">
              {rows.slice(0, limit).map((row) => {
                const state = stateOf(row);
                return (
                  <li
                    key={row.model}
                    className="model-mgmt-row"
                    data-model-row={row.model}
                    data-shown={state.shown ? 'true' : 'false'}
                  >
                    <input
                      type="checkbox"
                      checked={state.shown}
                      disabled={saving || provider.clientManagedVisibility}
                      aria-label={t('Show {{name}} in /model', { name: row.name })}
                      onChange={(event) => edit([row], { shown: event.target.checked })}
                    />
                    <span className="model-mgmt-main">
                      <span className="model-mgmt-name">{row.name}</span>
                      {row.name !== row.model && <code className="model-mgmt-id">{row.model}</code>}
                    </span>
                    <span className="model-mgmt-badges">
                      {row.model === inUse && (
                        <span className="model-mgmt-badge" data-tone="ok">
                          <i aria-hidden="true" />
                          {t('In use')}
                        </span>
                      )}
                      {!state.shown && row.autoHidden && (
                        <span
                          className="model-mgmt-badge"
                          title={t('Hidden automatically because a newer model of the same family exists.')}
                        >
                          {t('Auto-hidden (family)')}
                        </span>
                      )}
                      {!state.shown && !row.autoHidden && <span className="model-mgmt-badge">{t('Hidden')}</span>}
                    </span>
                    <button
                      type="button"
                      className="model-mgmt-star"
                      aria-pressed={state.favorite}
                      aria-label={t('{{name}} favorite', { name: row.name })}
                      disabled={saving}
                      onClick={() => edit([row], { favorite: !state.favorite })}
                    >
                      <Star size={16} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {rows.length > limit && (
            <div className="model-mgmt-more">
              <ActionButton onClick={() => setLimit(rows.length)}>
                {t('Show {{count}} more', { count: rows.length - limit })}
              </ActionButton>
            </div>
          )}
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          {changes.length > 0 && (
            <span className="model-mgmt-changed" role="status">
              {t('{{count}} changed', { count: changes.length })}
            </span>
          )}
          <button type="button" disabled={saving} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={saving || changes.length === 0}
            onClick={() => void save()}
          >
            {t('Save')}
          </button>
        </footer>
      </section>
    </div>
  );
}
