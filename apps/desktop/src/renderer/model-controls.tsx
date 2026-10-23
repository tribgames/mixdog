import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DesktopModelOption,
  DesktopModelSelection,
  DesktopOrchestrationMode,
  SessionSnapshot,
} from '../shared/contract';
import { beginBootSurface, holdBootSurface, reportBootSurfaceReady, reportBootSurfaceStage } from './boot-metrics';
import { routePreferenceStore } from './app-route-preference';
import { useModelSelection } from './use-model-selection';
import type { RecordValue } from './desktop-types';
import { isDesktopProvidersUnavailableError, useDesktopProvidersRetry } from './desktop-provider-retry';
import { t } from './i18n';
import {
  SHARED_MODEL_CATALOG_MAX_AGE_MS,
  readCachedModelCatalog,
  requestModelCatalog,
  invalidateSharedModelCatalogRequest,
  subscribeModelCatalogInvalidation,
} from './model-catalog-cache';
import { catalogProviderNames, customProviderDisplayNames, filterConfiguredModels } from './model-catalog';
import {
  effortForModelChoice,
  modelOffersUltrafast,
  preferredModelParameters,
  type RouteSpeed,
  speedRouteFields,
} from './model-route-utils';
import { RouteEditor } from './RouteEditor';
import type { RouteSessionChoice } from './route-editor-panes';
import { routedExactContextTokens } from './route-editor-context';
import { hostRouteAutoEffort, routeAutoEffortCapable, useAutoEffortRoute } from './auto-effort-store';
import { OpenSelect } from './OpenSelect';
import { InitialSurface } from './InitialSurface';
import { modelContextWindow, modelDisplayName, modelFastAvailable, modelMaxContextWindow } from './provider-display';
import { shouldShowFastControl } from './renderer-logic.mjs';
import type { SettingsSection } from './slash-commands';
import {
  freshWorkflowOptions,
  seededWorkflowOptions,
  storeWorkflowOptions,
  subscribeWorkflowOptions,
  workflowOptions,
  type WorkflowOption,
} from './workflow-options-cache';

import {
  applyModelPreferenceToModels,
  applyModelPreferenceToSetup,
  listedModels,
  orderModelsByRecency,
  requestModelManagementProvider,
  type ModelPreferenceChange,
} from './model-visibility';
import { invalidateCapabilitySettings } from './settings/capability-data';
import { invalidateSidebarReferenceForMutation } from './sidebar-reference-cache';

// Model-style trigger for changing the active session workflow. With a
// `sessionId` (an existing session's composer) the pick switches that session
// alone (from its next turn while one runs); the configured default for new
// sessions stays.
export const WorkflowSelect = memo(function WorkflowSelect({
  workflow,
  disabled,
  invokeResult,
  applySnapshot,
  onDraftChange,
  sessionId,
}: {
  workflow?: RecordValue | null;
  disabled: boolean;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  onDraftChange?: (workflow: { id: string; name: string }) => void;
  sessionId?: string;
}) {
  const { options, optionsSettled } = useWorkflowOptions();
  const [switching, setSwitching] = useState(false);
  const switchGuard = useRef(false);
  beginBootSurface('workflow-controls', 'catalog');
  // The seeded list already answers whether this control belongs in the row, so
  // a workspace that has loaded one before is ready on its first frame.
  const workflowReady = optionsSettled || options.length > 0;
  useEffect(() => {
    reportBootSurfaceStage('workflow-controls', 'catalog', 'module');
    if (!workflowReady) return;
    reportBootSurfaceReady('workflow-controls', 'catalog', 'shell');
  }, [workflowReady]);
  useEffect(() => {
    if (!optionsSettled) return;
    reportBootSurfaceStage('workflow-controls', 'catalog', 'data');
  }, [optionsSettled]);
  // A fresh desktop draft intentionally has no workflow override: the engine
  // will use its configured active workflow. Preserve listWorkflows.active so
  // the picker names that real inherited value instead of presenting the old
  // non-existent "Workflow" placeholder as though it were selected.
  const inherited = options.find((option) => option.active) || options[0];
  const selectedId = String(workflow?.id || inherited?.value || '');
  const selected = options.find((option) => option.value === selectedId);
  const changeWorkflow = async (id: string) => {
    if (disabled || switchGuard.current || !id || id === selectedId) return;
    if (onDraftChange) {
      onDraftChange({
        id,
        name: options.find((option) => option.value === id)?.label || id,
      });
      return;
    }
    switchGuard.current = true;
    setSwitching(true);
    try {
      const result = await invokeResult(() =>
        window.mixdogDesktop.invokeCapability<string>(
          sessionId
            ? { capability: 'setWorkflow', args: [id, { scope: 'session' }], sessionId }
            : { capability: 'setWorkflow', args: [id] }
        )
      );
      if (result !== undefined) applySnapshot(result.snapshot);
    } finally {
      switchGuard.current = false;
      setSwitching(false);
    }
  };
  // A workspace with one pack has nothing to choose, so the control leaves the
  // context row entirely instead of opening a menu with a single row. It never
  // reserves a slot either: appearing and then vanishing would shift the row.
  if (options.length < 2) return null;
  return (
    <div className="composer-route-workflow">
      <OpenSelect
        variant="route"
        className="workflow-context-select"
        ariaLabel={t('Workflow')}
        tooltip={t('Select workflow')}
        disabled={disabled || switching || !optionsSettled}
        value={selectedId}
        displayValue={String(workflow?.name || selected?.label || selectedId)}
        onChange={(value) => void changeWorkflow(value)}
        options={options}
      />
    </div>
  );
});

/** The workflow catalog every workflow picker shares (workflow-options-cache). */
function useWorkflowOptions() {
  const [options, setOptions] = useState<WorkflowOption[]>(seededWorkflowOptions);
  const [optionsSettled, setOptionsSettled] = useState(() => freshWorkflowOptions() !== null);
  const [reloadNonce, setReloadNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is a deliberate trigger that forces the workflow list to reload.
  useEffect(() => {
    const shared = freshWorkflowOptions();
    if (shared) {
      setOptions(shared);
      setOptionsSettled(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.mixdogDesktop.invokeCapability<RecordValue[]>({
          capability: 'listWorkflows',
          args: [],
        });
        const loaded = workflowOptions(result?.value);
        if (!cancelled && loaded.length) {
          storeWorkflowOptions(loaded);
          setOptions(loaded);
        }
      } catch {
        // Optional chrome settles to the configured engine default.
      } finally {
        if (!cancelled) setOptionsSettled(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadNonce]);
  // On a phone the first read can land before the relay leg is up, and an
  // empty result was final: the picker settled to nothing and REMOVED itself
  // until a remount (user: 모바일에서 오래 비어 있다). An empty catalog is
  // never cached, so re-running the read on a recovered connection is the
  // whole repair. The guard keeps a healthy session from re-reading on every
  // resync. A pack edit reloads unconditionally — the new pack may be the
  // second one, which is what brings this control into the row.
  useEffect(() => {
    const reload = () => setReloadNonce((nonce) => nonce + 1);
    const retry = () => {
      if (freshWorkflowOptions()?.length) return;
      reload();
    };
    const unsubscribe = subscribeWorkflowOptions(reload);
    window.addEventListener('mixdog:remote-state-gap', retry);
    window.addEventListener('mixdog:remote-reconnected', retry);
    return () => {
      unsubscribe();
      window.removeEventListener('mixdog:remote-state-gap', retry);
      window.removeEventListener('mixdog:remote-reconnected', retry);
    };
  }, []);
  return { options, optionsSettled };
}

/** The delegation choices, labelled as the New Task chip lists them. */
function orchestrationModeOptions(): Array<{ value: DesktopOrchestrationMode; label: string; description: string }> {
  return [
    { value: 'none', label: t('Solo'), description: t('No delegation') },
    { value: 'focused', label: t('Assisted'), description: t('Supporting delegation') },
    { value: 'balanced', label: t('Collaborative'), description: t('Balanced delegation') },
    { value: 'swarm', label: t('Swarm'), description: t('Maximum delegation') },
  ];
}

/**
 * A conversation's workflow and delegation mode as rows of its route menu.
 * A pick switches that session alone — at once between turns, from the next
 * response while one runs (`pending` until it applies, never refused); the
 * configured defaults for new tasks stay. The workflow row is left out while
 * only one workflow exists.
 */
export function useSessionRouteChoices({
  sessionId,
  workflow,
  mode,
  pendingWorkflow = false,
  pendingMode = false,
  disabled,
  invokeResult,
  applySnapshot,
}: {
  sessionId: string;
  workflow?: RecordValue | null;
  mode?: DesktopOrchestrationMode | null;
  pendingWorkflow?: boolean;
  pendingMode?: boolean;
  disabled: boolean;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
}): RouteSessionChoice[] {
  const { options } = useWorkflowOptions();
  if (!sessionId) return [];
  const send = (capability: 'setWorkflow' | 'setOrchestrationMode', value: string) =>
    void invokeResult(() =>
      window.mixdogDesktop.invokeCapability({ capability, args: [value, { scope: 'session' }], sessionId })
    ).then((result) => {
      if (result !== undefined) applySnapshot(result.snapshot);
    });
  const choices: RouteSessionChoice[] = [];
  if (options.length >= 2) {
    const workflowId = String(workflow?.id || options.find((option) => option.active)?.value || '');
    choices.push({
      id: 'workflow',
      label: t('Workflow'),
      value: workflowId,
      valueLabel: String(workflow?.name || options.find((option) => option.value === workflowId)?.label || workflowId),
      options: options.map((option) => ({ value: option.value, label: option.label })),
      pending: pendingWorkflow,
      disabled,
      onSelect: (value) => send('setWorkflow', value),
    });
  }
  if (mode) {
    const modes = orchestrationModeOptions();
    choices.push({
      id: 'orchestration-mode',
      label: t('Delegation mode'),
      value: mode,
      valueLabel: modes.find((option) => option.value === mode)?.label || mode,
      options: modes,
      pending: pendingMode,
      disabled,
      onSelect: (value) => send('setOrchestrationMode', value),
    });
  }
  return choices;
}

export const OrchestrationModeSelect = memo(function OrchestrationModeSelect({
  mode,
  disabled,
  invokeResult,
  applySnapshot,
  onDraftChange,
}: {
  mode?: DesktopOrchestrationMode | null;
  disabled: boolean;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  onDraftChange?: (mode: DesktopOrchestrationMode) => void;
}) {
  const [inherited, setInherited] = useState<DesktopOrchestrationMode | null>(null);
  const [switching, setSwitching] = useState(false);
  const guard = useRef(false);
  useEffect(() => {
    if (mode) return;
    let cancelled = false;
    void window.mixdogDesktop
      .invokeCapability<DesktopOrchestrationMode>({
        capability: 'getOrchestrationMode',
        args: [],
      })
      .then((result) => {
        if (!cancelled) setInherited(result.value);
      })
      .catch(() => {
        // Keep the unknown control disabled; do not claim an unconfirmed mode.
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);
  const selected = mode ?? inherited;
  const change = async (value: string) => {
    if (disabled || guard.current || value === selected) return;
    const next = value as DesktopOrchestrationMode;
    if (onDraftChange) {
      onDraftChange(next);
      return;
    }
    guard.current = true;
    setSwitching(true);
    try {
      const result = await invokeResult(() =>
        window.mixdogDesktop.invokeCapability({
          capability: 'setOrchestrationMode',
          args: [next],
        })
      );
      if (result !== undefined) applySnapshot(result.snapshot);
    } finally {
      guard.current = false;
      setSwitching(false);
    }
  };
  return (
    <div className="composer-route-workflow">
      {selected ? (
        <OpenSelect
          variant="route"
          className="context-pill-select orchestration-mode-select"
          ariaLabel={t('Orchestration Mode')}
          tooltip={t('Delegation mode')}
          disabled={disabled || switching}
          value={selected}
          onChange={(value) => void change(value)}
          options={orchestrationModeOptions()}
        />
      ) : (
        <InitialSurface variant="control" />
      )}
    </div>
  );
});

/** The context slider owns the window whenever it is available, so a
 *  provider's own context-window parameter (Cursor 272K/1M) never travels with
 *  a route: Cursor derives its variant from selectedContextWindow, and a stale
 *  272k parameter alongside a raised window has no valid max-mode variant. */
function routeModelParameters(parameters: Record<string, string>, maxContextWindow: number): Record<string, string> {
  if (!(maxContextWindow > 0)) return parameters;
  return Object.fromEntries(Object.entries(parameters).filter(([id]) => id !== 'context'));
}

/** The model's default window as a slider stop: a multiple of 10 within
 *  10–100, or 100 when the model has no adjustable window. */
export function defaultContextPercent(defaultWindow: number, maxWindow: number): number {
  if (!(maxWindow > 0)) return 100;
  return Math.max(10, Math.min(100, Math.round((defaultWindow / maxWindow) * 10) * 10));
}

/** A requested Context percent as a slider stop: a multiple of 10 within 10–100. */
export function contextSliderPercent(requested: number): number {
  return Math.max(10, Math.min(100, Math.round(requested / 10) * 10));
}

/** Tokens a slider stop routes; the default stop keeps the model's own default window. */
export function contextTokensForPercent(
  percent: number,
  contextWindow: { defaultPercent: number; defaultTokens: number; maxTokens: number }
): number {
  return percent === contextWindow.defaultPercent
    ? contextWindow.defaultTokens
    : Math.floor((contextWindow.maxTokens * percent) / 100);
}

export const ModelSelector = memo(function ModelSelector({
  provider: sourceProvider,
  model: sourceModel,
  effort: sourceEffort,
  fast: sourceFast,
  fastCapable: sourceFastCapable,
  autoEffort: sourceAutoEffort,
  modelParameters: sourceModelParameters,
  contextPercent: sourceContextPercent,
  contextTokens: sourceContextTokens,
  modelDisabled,
  tuningDisabled,
  invokeResult,
  applySnapshot,
  onOpenSettings,
  onDraftSelection,
  onRoutePreferenceApplied,
  sessionId,
  answersModelPickerRequests = false,
  sheetAlign,
  sessionChoices,
}: {
  /** A conversation's workflow / delegation rows (useSessionRouteChoices). */
  sessionChoices?: RouteSessionChoice[];
  /** True only for the focused, visible conversation pane. */
  answersModelPickerRequests?: boolean;
  /** The pill edge its sheet lines up with (RouteEditor `align`). */
  sheetAlign?: 'start' | 'end';
  provider: string;
  model: string;
  effort: string;
  fast: boolean;
  fastCapable: boolean;
  /** The route's own Auto reasoning flag; absent means on. */
  autoEffort?: boolean;
  modelParameters?: Record<string, string>;
  contextPercent?: number;
  /** Exact context window; overrides contextPercent. */
  contextTokens?: number;
  modelDisabled: boolean;
  tuningDisabled: boolean;
  /** The pane's session. Route changes address it directly, so a background
   *  pane can change ITS model without the window's focus deciding. */
  sessionId?: string;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  onDraftSelection?: (selection: DesktopModelSelection) => void;
  onRoutePreferenceApplied?: (selection: DesktopModelSelection, options?: { modelChoice?: boolean }) => void;
}) {
  const [cachedCatalog] = useState(readCachedModelCatalog);
  const [models, setModels] = useState<DesktopModelOption[]>(cachedCatalog.models);
  const [providerSetup, setProviderSetup] = useState<unknown>(null);
  const [catalogError, setCatalogError] = useState('');
  const [providerSetupError, setProviderSetupError] = useState('');
  // A server window whose desktop proxy is away retries on the shared cadence.
  const [desktopProvidersAway, setDesktopProvidersAway] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(cachedCatalog.models.length > 0);
  const [startupCatalogSettled, setStartupCatalogSettled] = useState(cachedCatalog.models.length > 0);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const { selection, begin, settle } = useModelSelection(sessionId || '', {
    provider: sourceProvider,
    model: sourceModel,
    effort: sourceEffort,
    fast: sourceFast,
    ...(typeof sourceAutoEffort === 'boolean' ? { autoEffort: sourceAutoEffort } : {}),
    modelParameters: sourceModelParameters,
    contextPercent: sourceContextPercent,
    ...(sourceContextTokens ? { contextTokens: sourceContextTokens } : {}),
  });
  const {
    provider,
    model,
    effort = '',
    fast = false,
    autoEffort,
    modelParameters,
    contextPercent,
    contextTokens: selectedContextTokens,
  } = selection;
  // Every route write carries the route's known Auto flag, like `fast`.
  // An older host rejects the field, so it travels only to a host that takes it.
  const autoEffortField = hostRouteAutoEffort() && typeof autoEffort === 'boolean' ? { autoEffort } : {};
  const catalogInFlight = useRef<Promise<void> | null>(null);
  // Newest request wins. An older reply may land after a newer choice, so only
  // the current token may publish its snapshot; useModelSelection already
  // ignores a stale settle.
  const latestRouteToken = useRef(0);
  const modelBootKey = `${provider || 'none'}:${model || 'none'}`;
  beginBootSurface('model-controls', modelBootKey);
  // A restored session renders its controls before its route is known
  // (`none:none`), then re-keys on the route: the superseded key must not
  // hold the boot cover waiting for a ready no render will report.
  useEffect(() => holdBootSurface('model-controls', modelBootKey), [modelBootKey]);
  // An in-flight write no longer locks the controls. The selection is previewed
  // locally the moment it is clicked, so disabling the picker until the runtime
  // replied only made it look frozen — and swallowed the next click.
  const modelUnavailable = modelDisabled;
  const tuningUnavailable = tuningDisabled;
  const displayedFast = fast;
  // The whole catalog, newest first per provider. Which rows /model lists is
  // Model management's call (selectableModels); a hidden model in use still
  // names the trigger from here.
  const catalogModels = useMemo(() => orderModelsByRecency(models), [models]);
  const selected = catalogModels.find((option) => option.provider === provider && option.model === model);
  // The catalog starts empty on a cold start, so a perfectly valid route — a
  // schedule/webhook session opened right after it ran — could not be named
  // from it (user: 세션 생성 시 쓴 모델이 그대로 표기되게). The RAW catalog
  // answers those cases.
  const known = selected || models.find((option) => option.provider === provider && option.model === model);
  const awaitingRoute = !known && !startupCatalogSettled;
  const autoEffortRoute = useAutoEffortRoute(known?.autoEffortCapable === true, autoEffort, (enabled) =>
    changeAutoEffort(enabled)
  );
  useEffect(() => {
    reportBootSurfaceStage('model-controls', modelBootKey, 'module');
    if (!awaitingRoute) reportBootSurfaceReady('model-controls', modelBootKey, 'shell');
  }, [awaitingRoute, modelBootKey]);
  const fastCapable = known?.fastCapable ?? sourceFastCapable;
  const selectedModelParameters = preferredModelParameters(known, modelParameters || {});
  const defaultContextWindow = known ? modelContextWindow(known) : 0;
  const maxContextWindow = known ? modelMaxContextWindow(known) : 0;
  const contextDefaultPercent = defaultContextPercent(defaultContextWindow, maxContextWindow);
  const normalizedContextPercent = contextSliderPercent(
    Number(contextPercent) || Number(known?.savedContextPercent) || contextDefaultPercent
  );
  const exactContextTokens = routedExactContextTokens(selectedContextTokens, defaultContextWindow, maxContextWindow);
  const contextTokens =
    exactContextTokens ||
    contextTokensForPercent(normalizedContextPercent, {
      defaultPercent: contextDefaultPercent,
      defaultTokens: defaultContextWindow,
      maxTokens: maxContextWindow,
    });
  const exactContextField = exactContextTokens ? { contextTokens: exactContextTokens } : {};
  const routedModelParameters = routeModelParameters(selectedModelParameters, maxContextWindow);
  const routedParameterFields = Object.keys(routedModelParameters).length
    ? { modelParameters: routedModelParameters }
    : {};
  const fastControlVisible = shouldShowFastControl(fastCapable, known?.fastCapable);
  const fastAvailable = fastControlVisible && modelFastAvailable(known, effort, selectedModelParameters);
  const selectableModels = useMemo(
    () =>
      listedModels(
        filterConfiguredModels(catalogModels, providerSetup, providerSetupError),
        catalogModels,
        providerSetup
      ),
    [catalogModels, providerSetup, providerSetupError]
  );
  const providerNames = useMemo(
    () => catalogProviderNames(catalogModels, customProviderDisplayNames(providerSetup)),
    [catalogModels, providerSetup]
  );
  // A route the loaded catalog does not know at all stays "Select model": an
  // unknown/retired persisted id must never read as a selectable model.
  const triggerModel = known ? modelDisplayName(known.model, known.provider, known.display || '') : t('Select model');

  const loadCatalog = useCallback(async (force = false) => {
    if (!force && catalogInFlight.current) return catalogInFlight.current;
    const api = window.mixdogDesktop;
    if (!api?.listProviderModels) {
      setCatalogLoaded(true);
      setStartupCatalogSettled(true);
      return;
    }
    const request = (async () => {
      setCatalogRefreshing(true);
      setCatalogError('');
      setProviderSetupError('');
      setDesktopProvidersAway(false);
      const shared = requestModelCatalog(api);
      let fullApplied = false;
      const setupRequest = shared.setup
        .then((setup) => {
          if (shared.isCurrent()) setProviderSetup(setup);
        })
        .catch((reason) => {
          if (!shared.isCurrent()) return;
          console.warn('[model-catalog] provider setup refresh failed', reason);
          setProviderSetupError('unavailable');
          setDesktopProvidersAway(isDesktopProvidersUnavailableError(reason));
        });
      const fullRequest = shared.full
        .then((full) => {
          if (!shared.isCurrent() || !Array.isArray(full)) return;
          fullApplied = true;
          // An empty answer is a retryable boot miss: keep the list on screen
          // until the retry brings a real one.
          setModels((current) => (full.length === 0 && current.length > 0 ? current : full));
          setCatalogError('');
        })
        .catch((reason) => {
          if (!shared.isCurrent()) return;
          // The quick or persisted catalog stays usable. A background refresh
          // failure must not become a boot-time error surface.
          console.warn('[model-catalog] full catalog refresh failed', reason);
        })
        .finally(() => {
          if (!shared.isCurrent()) return;
          setCatalogRefreshing(false);
          setStartupCatalogSettled(true);
        });
      try {
        const quick = await shared.quick;
        // A reused shared request may already have resolved both answers.
        // Its thin quick rows must not overwrite the full catalog above.
        if (shared.isCurrent() && !fullApplied && Array.isArray(quick) && quick.length > 0) {
          setModels((current) => {
            const merged = new Map(current.map((option) => [`${option.provider}:${option.model}`, option]));
            for (const option of quick) {
              merged.set(`${option.provider}:${option.model}`, option);
            }
            return [...merged.values()];
          });
        }
      } catch (reason) {
        if (!shared.isCurrent()) return;
        console.warn('[model-catalog] quick catalog refresh failed', reason);
        setCatalogError(reason instanceof Error ? reason.message : String(reason || 'Model catalog failed.'));
      } finally {
        if (shared.isCurrent()) {
          setCatalogLoaded(true);
        }
      }
      void Promise.allSettled([fullRequest, setupRequest]);
    })().finally(() => {
      if (catalogInFlight.current === request) catalogInFlight.current = null;
    });
    catalogInFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | null = null;
    const scheduleRefresh = () => {
      if (cancelled) return;
      refreshTimer = window.setTimeout(async () => {
        await loadCatalog();
        scheduleRefresh();
      }, SHARED_MODEL_CATALOG_MAX_AGE_MS);
    };
    void loadCatalog().then(scheduleRefresh);
    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
    // One boot request and one 24h timer per mounted control (loadCatalog is
    // stable). The module-level request and daemon catalog epoch deduplicate
    // panes and sessions.
  }, [loadCatalog]);

  useEffect(
    () =>
      subscribeModelCatalogInvalidation(() => {
        void loadCatalog(true);
      }),
    [loadCatalog]
  );

  useDesktopProvidersRetry(desktopProvidersAway, invalidateSharedModelCatalogRequest);

  useEffect(() => {
    if (model && !startupCatalogSettled) return;
    reportBootSurfaceStage('model-controls', modelBootKey, 'data');
  }, [model, modelBootKey, startupCatalogSettled]);

  const route = async (selection: DesktopModelSelection, modelChoice = false) => {
    if (modelUnavailable) return false;
    if (onDraftSelection) {
      onDraftSelection(selection);
      return true;
    }
    const token = begin(selection);
    latestRouteToken.current = token;
    let applied = false;
    try {
      const next = await invokeResult(() => window.mixdogDesktop.setModelRoute(selection, sessionId));
      if (next) {
        applied = next.provider === selection.provider && next.model === selection.model;
        settle(token, next);
        if (latestRouteToken.current === token) {
          applySnapshot(next);
          if (applied) onRoutePreferenceApplied?.(selection, modelChoice ? { modelChoice: true } : undefined);
        }
      }
    } finally {
      if (!applied) settle(token);
    }
    return applied;
  };
  const chooseModel = (option: DesktopModelOption) => {
    const values = option.effortOptions.map((entry) => entry.value);
    const sameModel = option.provider === provider && option.model === model;
    const remembered = routePreferenceStore.get(option.provider, option.model);
    const nextEffort = effortForModelChoice({
      values,
      sameModel,
      current: effort,
      saved: option.savedEffort,
      remembered: remembered?.effort,
    });
    let requestedFast: boolean | undefined;
    if (option.fastCapable) {
      if (sameModel) requestedFast = displayedFast;
      else if (typeof remembered?.fast === 'boolean') requestedFast = remembered.fast;
      else if (typeof option.savedFast === 'boolean') requestedFast = option.savedFast;
      else requestedFast = option.fastPreferred;
    }
    let nextAutoEffort: boolean | undefined;
    if (routeAutoEffortCapable(option)) {
      if (sameModel) nextAutoEffort = autoEffort !== false;
      else if (typeof remembered?.autoEffort === 'boolean') nextAutoEffort = remembered.autoEffort;
      else nextAutoEffort = option.savedAutoEffort ?? true;
    }
    const nextModelParameters = preferredModelParameters(
      option,
      sameModel ? selectedModelParameters : remembered?.modelParameters || {}
    );
    const optionMaxWindow = modelMaxContextWindow(option);
    const nextContextPercent = sameModel
      ? normalizedContextPercent
      : Number(remembered?.contextPercent) ||
        Number(option.savedContextPercent) ||
        defaultContextPercent(modelContextWindow(option), optionMaxWindow);
    const nextFast =
      requestedFast === undefined
        ? undefined
        : modelFastAvailable(option, nextEffort, nextModelParameters) && requestedFast;
    const selection: DesktopModelSelection = {
      provider: option.provider,
      model: option.model,
      ...(nextEffort ? { effort: nextEffort } : {}),
      ...(nextFast === undefined ? {} : { fast: nextFast }),
      ...(nextAutoEffort === undefined ? {} : { autoEffort: nextAutoEffort }),
      ...(option.modelParameterOptions?.length
        ? { modelParameters: routeModelParameters(nextModelParameters, optionMaxWindow) }
        : {}),
      ...(optionMaxWindow > 0 ? { contextPercent: nextContextPercent } : {}),
      ...(optionMaxWindow > 0 && sameModel ? exactContextField : {}),
    };
    return route(selection, !sameModel);
  };
  // The /model row menu saves through Model management's own capability; the
  // list updates at once and the re-read that follows confirms it.
  const setModelPreference = async (option: DesktopModelOption, change: Omit<ModelPreferenceChange, 'model'>) => {
    const api = window.mixdogDesktop;
    const saved: ModelPreferenceChange = { model: option.model, ...change };
    setModels((current) => applyModelPreferenceToModels(current, option.provider, saved));
    setProviderSetup((current: unknown) => applyModelPreferenceToSetup(current, option.provider, saved));
    try {
      await api.invokeCapability({ capability: 'setModelPreferences', args: [option.provider, [saved]] });
      invalidateSidebarReferenceForMutation('setModelPreferences');
      invalidateCapabilitySettings(api, 'setModelPreferences');
    } catch (reason) {
      console.warn('[model-catalog] saving model preference failed', reason);
      invalidateSharedModelCatalogRequest();
    }
  };
  const changeFast = async (enabled: boolean) => {
    if (tuningUnavailable) return;
    if (onDraftSelection && provider && model) {
      onDraftSelection({
        provider,
        model,
        ...(effort ? { effort } : {}),
        fast: enabled,
        ...autoEffortField,
        contextPercent: normalizedContextPercent,
        ...exactContextField,
      });
      return;
    }
    const token = begin({ provider, model, fast: enabled });
    latestRouteToken.current = token;
    let accepted = false;
    try {
      const next = await invokeResult(() => window.mixdogDesktop.setFast(enabled, sessionId));
      if (next !== undefined) {
        accepted = next?.fast === enabled;
        settle(token, next);
        if (latestRouteToken.current === token) applySnapshot(next);
        if (accepted && provider && model && latestRouteToken.current === token) {
          onRoutePreferenceApplied?.({
            provider,
            model,
            ...(effort ? { effort } : {}),
            fast: enabled,
          });
        }
      }
    } finally {
      if (!accepted) settle(token);
    }
  };
  const changeSpeed = async (speed: RouteSpeed) => {
    if (!known || !modelOffersUltrafast(known)) {
      await changeFast(speed !== 'standard');
      return;
    }
    if (tuningUnavailable) return;
    const next = speedRouteFields(speed, selectedModelParameters, true);
    await route({
      provider,
      model,
      ...(effort ? { effort } : {}),
      fast: next.fast,
      ...autoEffortField,
      modelParameters: routeModelParameters(next.modelParameters, maxContextWindow),
      contextPercent: normalizedContextPercent,
      ...exactContextField,
    });
  };
  const changeEffort = async (effort: string) => {
    if (tuningUnavailable) return;
    const nextFast = fastCapable
      ? modelFastAvailable(known, effort, selectedModelParameters) && displayedFast
      : undefined;
    // A picked level is explicit: it turns the route's Auto effort off (the
    // runtime's setEffort does the same), or Auto would replace it next turn.
    const pickedAutoEffort = hostRouteAutoEffort() ? { autoEffort: false } : {};
    if (onDraftSelection && provider && model) {
      onDraftSelection({
        provider,
        model,
        effort,
        ...(nextFast === undefined ? {} : { fast: nextFast }),
        ...pickedAutoEffort,
        ...routedParameterFields,
        contextPercent: normalizedContextPercent,
        ...exactContextField,
      });
      return;
    }
    if (nextFast === false && displayedFast) {
      await route({
        provider,
        model,
        effort,
        fast: false,
        ...pickedAutoEffort,
        ...routedParameterFields,
        contextPercent: normalizedContextPercent,
        ...exactContextField,
      });
      return;
    }
    const token = begin({
      provider,
      model,
      effort,
      ...(nextFast === undefined ? {} : { fast: nextFast }),
      ...pickedAutoEffort,
    });
    latestRouteToken.current = token;
    let accepted = false;
    try {
      const result = await invokeResult(() =>
        window.mixdogDesktop.invokeCapability<string | false>({
          capability: 'setEffort',
          args: [effort],
          ...(sessionId ? { sessionId } : {}),
        })
      );
      if (result !== undefined && result.value !== false) {
        settle(token, result.snapshot);
        accepted = true;
        if (latestRouteToken.current === token) {
          applySnapshot(result.snapshot);
          onRoutePreferenceApplied?.({
            provider,
            model,
            effort,
            ...(nextFast === undefined ? {} : { fast: nextFast }),
            ...pickedAutoEffort,
            ...routedParameterFields,
            contextPercent: normalizedContextPercent,
            ...exactContextField,
          });
        }
      }
    } finally {
      if (!accepted) settle(token);
    }
  };

  const changeContext = async (nextContextPercent: number, nextContextTokens?: number) => {
    if (!known || !maxContextWindow || tuningUnavailable) return;
    await route({
      provider,
      model,
      ...(effort ? { effort } : {}),
      ...(fastControlVisible ? { fast: displayedFast } : {}),
      ...autoEffortField,
      ...routedParameterFields,
      contextPercent: nextContextPercent,
      ...(nextContextTokens ? { contextTokens: nextContextTokens } : {}),
    });
  };
  // This route's Auto reasoning switch: the route changes, never the master.
  const changeAutoEffort = async (enabled: boolean) => {
    if (!known || tuningUnavailable || !provider || !model) return;
    const selection: DesktopModelSelection = {
      provider,
      model,
      ...(effort ? { effort } : {}),
      ...(fastControlVisible ? { fast: displayedFast } : {}),
      autoEffort: enabled,
      ...routedParameterFields,
      contextPercent: normalizedContextPercent,
      ...exactContextField,
    };
    if (onDraftSelection) {
      onDraftSelection(selection);
      return;
    }
    await route(selection);
  };
  const changeModelParameter = async (id: string, value: string) => {
    if (!known || tuningUnavailable) return;
    const nextModelParameters = { ...selectedModelParameters, [id]: value };
    const nextFast = fastControlVisible
      ? modelFastAvailable(known, effort, nextModelParameters) && displayedFast
      : undefined;
    await route({
      provider,
      model,
      ...(effort ? { effort } : {}),
      ...(nextFast === undefined ? {} : { fast: nextFast }),
      ...autoEffortField,
      modelParameters: routeModelParameters(nextModelParameters, maxContextWindow),
      contextPercent: normalizedContextPercent,
      ...exactContextField,
    });
  };

  if (awaitingRoute)
    return (
      <div className="route-controls">
        <InitialSurface variant="control" />
      </div>
    );
  return (
    <div className="route-controls">
      <RouteEditor
        models={selectableModels}
        providerNames={providerNames}
        provider={provider}
        model={model}
        triggerModel={triggerModel}
        effort={effort}
        effortOptions={known?.effortOptions || []}
        fast={displayedFast}
        fastVisible={fastControlVisible}
        fastAvailable={fastAvailable}
        contextVisible={maxContextWindow > 0}
        contextPercent={normalizedContextPercent}
        contextDefaultPercent={contextDefaultPercent}
        contextTokens={contextTokens}
        contextExactTokens={exactContextTokens}
        contextMaxTokens={maxContextWindow}
        contextDefaultTokens={defaultContextWindow}
        modelParameterOptions={known?.modelParameterOptions || []}
        modelParameters={selectedModelParameters}
        catalogLoaded={catalogLoaded}
        catalogRefreshing={catalogRefreshing}
        catalogError={catalogError}
        providerSetupError={providerSetupError}
        modelDisabled={modelUnavailable}
        tuningDisabled={tuningUnavailable}
        tooltip={
          catalogLoaded && selectableModels.length === 0 ? t('Add a provider to load models') : t('Choose model')
        }
        onSelectModel={chooseModel}
        onChangeEffort={(value) => void changeEffort(value)}
        onChangeSpeed={(speed) => void changeSpeed(speed)}
        onChangeContext={(value, tokens) => void changeContext(value, tokens)}
        onChangeModelParameter={(id, value) => void changeModelParameter(id, value)}
        onOpenProviders={() => onOpenSettings('providers')}
        onOpenModelManagement={(target) => {
          if (target) requestModelManagementProvider(target);
          onOpenSettings('model-management');
        }}
        onSetModelPreference={setModelPreference}
        onOpenModelPane={() => void loadCatalog()}
        autoEffort={autoEffortRoute.autoEffort}
        onChangeAutoEffort={autoEffortRoute.onChangeAutoEffort}
        onOpenSheet={autoEffortRoute.onOpenSheet}
        sessionChoices={sessionChoices}
        answersModelPickerRequests={answersModelPickerRequests}
        align={sheetAlign}
      />
    </div>
  );
});
