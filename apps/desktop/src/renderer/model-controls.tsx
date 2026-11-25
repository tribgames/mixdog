import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DesktopModelOption,
  DesktopModelSelection,
  DesktopOrchestrationMode,
  DesktopStreamPosition,
  SessionSnapshot,
} from '../shared/contract';
import { beginBootSurface, holdBootSurface, reportBootSurfaceReady, reportBootSurfaceStage } from './boot-metrics';
import { routePreferenceStore } from './app-route-preference';
import { streamMarkAfterCall, useModelSelection } from './use-model-selection';
import { publishInheritedOrchestrationMode, useInheritedOrchestrationMode } from './orchestration-mode-store';
import type { RecordValue } from './desktop-types';
import { t } from './i18n';
import { cachedAgentTierRoute, invalidateSharedModelCatalogRequest } from './model-catalog-cache';
import { agentProvider, useAgentRoute } from './acp-agent-status';
import { useProviderModelCatalog } from './use-model-catalog';
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
import {
  invalidateSidebarReferenceForMutation,
  loadSidebarReferences,
  readSidebarReference,
} from './sidebar-reference-cache';

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
        // The host-scoped shared loader: concurrent pickers share one read.
        await loadSidebarReferences(window.mixdogDesktop, ['workflows']);
        const loaded = workflowOptions(readSidebarReference('workflows'));
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
    choices.push(
      workflowChoice(options, workflowId, workflow, {
        pending: pendingWorkflow,
        disabled,
        onSelect: (value) => send('setWorkflow', value),
      })
    );
  }
  if (mode) {
    choices.push(
      orchestrationModeChoice(mode, {
        pending: pendingMode,
        disabled,
        onSelect: (value) => send('setOrchestrationMode', value),
      })
    );
  }
  return choices;
}

type ChoiceAction = Pick<RouteSessionChoice, 'pending' | 'disabled' | 'onSelect'>;

function workflowChoice(
  options: WorkflowOption[],
  workflowId: string,
  workflow: RecordValue | null | undefined,
  action: ChoiceAction
): RouteSessionChoice {
  return {
    id: 'workflow',
    label: t('Workflow'),
    value: workflowId,
    valueLabel: String(workflow?.name || options.find((option) => option.value === workflowId)?.label || workflowId),
    options: options.map((option) => ({ value: option.value, label: option.label })),
    ...action,
  };
}

function orchestrationModeChoice(mode: DesktopOrchestrationMode, action: ChoiceAction): RouteSessionChoice {
  const modes = orchestrationModeOptions();
  return {
    id: 'orchestration-mode',
    label: t('Delegation mode'),
    value: mode,
    valueLabel: modes.find((option) => option.value === mode)?.label || mode,
    options: modes,
    ...action,
  };
}

/** A New Task draft's workflow and delegation mode as rows, as its context
 *  bar's WorkflowSelect and OrchestrationModeSelect offer them: a pick stages
 *  the draft's own. A row is left out without its handler, the workflow row
 *  also while only one workflow exists. */
export function useDraftRouteChoices({
  workflow,
  mode,
  disabled,
  onWorkflow,
  onMode,
}: {
  workflow: RecordValue | null;
  mode: DesktopOrchestrationMode | null;
  disabled: boolean;
  onWorkflow?: (workflow: { id: string; name: string }) => void;
  onMode?: (mode: DesktopOrchestrationMode) => void;
}): RouteSessionChoice[] {
  const { options, optionsSettled } = useWorkflowOptions();
  const inherited = useInheritedOrchestrationMode(!mode);
  const choices: RouteSessionChoice[] = [];
  if (onWorkflow && options.length >= 2) {
    const workflowId = String(workflow?.id || (options.find((option) => option.active) || options[0])?.value || '');
    choices.push(
      workflowChoice(options, workflowId, workflow, {
        disabled: disabled || !optionsSettled,
        onSelect: (id) => {
          if (id !== workflowId) onWorkflow({ id, name: options.find((option) => option.value === id)?.label || id });
        },
      })
    );
  }
  const selected = mode ?? inherited;
  if (onMode && selected) {
    choices.push(
      orchestrationModeChoice(selected, {
        disabled,
        onSelect: (value) => {
          if (value !== selected) onMode(value as DesktopOrchestrationMode);
        },
      })
    );
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
  const inherited = useInheritedOrchestrationMode(!mode);
  const [switching, setSwitching] = useState(false);
  const guard = useRef(false);
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
      if (result !== undefined) {
        publishInheritedOrchestrationMode(next);
        applySnapshot(result.snapshot);
      }
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

function modelChoiceSelection(
  option: DesktopModelOption,
  current: {
    provider: string;
    model: string;
    effort: string;
    fast: boolean;
    autoEffort: boolean | undefined;
    modelParameters: Record<string, string>;
    contextPercent: number;
    exactContextField: { contextTokens?: number };
  }
): DesktopModelSelection {
  const { effort, autoEffort, exactContextField } = current;
  const values = option.effortOptions.map((entry) => entry.value);
  const sameModel = option.provider === current.provider && option.model === current.model;
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
    if (sameModel) requestedFast = current.fast;
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
    sameModel ? current.modelParameters : remembered?.modelParameters || {}
  );
  const optionMaxWindow = modelMaxContextWindow(option);
  const nextContextPercent = sameModel
    ? current.contextPercent
    : Number(remembered?.contextPercent) ||
      Number(option.savedContextPercent) ||
      defaultContextPercent(modelContextWindow(option), optionMaxWindow);
  const nextFast =
    requestedFast === undefined
      ? undefined
      : modelFastAvailable(option, nextEffort, nextModelParameters) && requestedFast;
  return {
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
}

const NOTHING_LEFT_OUT: ReadonlySet<string> = new Set();

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
  onOpenSettings,
  onDraftModelSelection,
  onRoutePreferenceApplied,
  sessionId,
  answersModelPickerRequests = false,
  sheetAlign,
  sheetPlacement,
  sessionChoices,
  triggerRowLabel,
}: {
  /** A conversation's workflow / delegation rows (useSessionRouteChoices). */
  sessionChoices?: RouteSessionChoice[];
  /** The side the sheet opens toward (RouteEditor `placement`). */
  sheetPlacement?: 'above' | 'below';
  /** The trigger is the session panel's row of this name. */
  triggerRowLabel?: string;
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
  onDraftModelSelection?: (selection: DesktopModelSelection) => void;
  onRoutePreferenceApplied?: (selection: DesktopModelSelection, options?: { modelChoice?: boolean }) => void;
}) {
  const {
    models,
    setModels,
    providerSetup,
    setProviderSetup,
    catalogError,
    providerSetupError,
    catalogLoaded,
    startupCatalogSettled,
    catalogRefreshing,
    loadCatalog,
  } = useProviderModelCatalog();
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
  // from it. The RAW catalog answers those cases.
  // A route saved under an external agent's own id of one tier is that model with the tier as its effort.
  const agentTier = cachedAgentTierRoute(provider, model);
  const known =
    selected || models.find((option) => option.provider === provider && option.model === model) || agentTier?.row;
  // A route on an external agent is the agent's whatever the catalog holds now; the controls it has no use for
  // are left out, not disabled.
  const agentRoute = useAgentRoute(provider, model, known);
  const awaitingRoute = !known && !agentRoute && !startupCatalogSettled;
  const notApplicable = agentRoute?.notApplicable ?? NOTHING_LEFT_OUT;
  const autoEffortRoute = useAutoEffortRoute(
    known?.autoEffortCapable === true && !notApplicable.has('autoEffort'),
    autoEffort,
    (enabled) => changeAutoEffort(enabled),
    known !== undefined
  );
  useEffect(() => {
    reportBootSurfaceStage('model-controls', modelBootKey, 'module');
    if (!awaitingRoute) reportBootSurfaceReady('model-controls', modelBootKey, 'shell');
  }, [awaitingRoute, modelBootKey]);
  const fastCapable = known?.fastCapable ?? sourceFastCapable;
  const preferred = preferredModelParameters(known, modelParameters || {});
  // No service tier on an active Fast route means priority, even if the catalog remembers Ultrafast.
  const selectedModelParameters =
    sessionId && modelOffersUltrafast(known)
      ? { ...preferred, serviceTier: modelParameters?.serviceTier ?? 'priority' }
      : preferred;
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
  const fastControlVisible = shouldShowFastControl(fastCapable, known?.fastCapable) && !notApplicable.has('fast');
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
  const knownModelName = known ? modelDisplayName(known.model, known.provider, known.display || '') : t('Select model');
  const triggerModel = agentRoute ? agentRoute.display : knownModelName;

  useEffect(() => {
    if (model && !startupCatalogSettled) return;
    reportBootSurfaceStage('model-controls', modelBootKey, 'data');
  }, [model, modelBootKey, startupCatalogSettled]);

  const route = async (
    selection: DesktopModelSelection,
    modelChoice = false,
    write = () => window.mixdogDesktop.setModelRoute(selection, sessionId) as Promise<unknown>
  ) => {
    if (modelUnavailable) return false;
    if (onDraftModelSelection) {
      onDraftModelSelection(selection);
      return true;
    }
    const token = begin(selection);
    latestRouteToken.current = token;
    let mark: DesktopStreamPosition | null = null;
    let applied = false;
    try {
      // The answer only says the write was taken: the value shown is the stream's (useModelSelection).
      const answered = await invokeResult(write);
      if (answered !== undefined) {
        applied = true;
        mark = await streamMarkAfterCall(sessionId);
        if (latestRouteToken.current === token) {
          onRoutePreferenceApplied?.(selection, modelChoice ? { modelChoice: true } : undefined);
        }
      }
    } finally {
      settle(token, mark);
    }
    return applied;
  };
  const chooseModel = (option: DesktopModelOption) =>
    route(
      modelChoiceSelection(option, {
        provider,
        model,
        effort,
        fast: displayedFast,
        autoEffort,
        modelParameters: selectedModelParameters,
        contextPercent: normalizedContextPercent,
        exactContextField,
      }),
      !(option.provider === provider && option.model === model)
    ); // The /model row menu saves through Model management's own capability; the
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
  const changeSpeed = async (speed: RouteSpeed) => {
    if (tuningUnavailable) return;
    const offersTier = modelOffersUltrafast(known);
    const next = speedRouteFields(speed, modelParameters ?? {}, offersTier);
    await route(
      {
        provider,
        model,
        ...(effort ? { effort } : {}),
        fast: next.fast,
        ...autoEffortField,
        modelParameters: routeModelParameters(next.modelParameters, maxContextWindow),
        contextPercent: normalizedContextPercent,
        ...exactContextField,
      },
      false,
      offersTier ? undefined : () => window.mixdogDesktop.setFast(next.fast, sessionId)
    );
  };
  const changeEffort = async (effort: string) => {
    if (tuningUnavailable) return;
    const nextFast = fastCapable
      ? modelFastAvailable(known, effort, selectedModelParameters) && displayedFast
      : undefined;
    // A picked level is explicit: it turns the route's Auto effort off (the
    // runtime's setEffort does the same), or Auto would replace it next turn.
    const pickedAutoEffort = hostRouteAutoEffort() ? { autoEffort: false } : {};
    await route(
      {
        provider,
        model,
        effort,
        ...(nextFast === undefined ? {} : { fast: nextFast }),
        ...pickedAutoEffort,
        modelParameters: routeModelParameters(modelParameters ?? {}, maxContextWindow),
        contextPercent: normalizedContextPercent,
        ...exactContextField,
      },
      false,
      nextFast === false && displayedFast
        ? undefined
        : async () => {
            const result = await window.mixdogDesktop.invokeCapability<string | false>({
              capability: 'setEffort',
              args: [effort],
              ...(sessionId ? { sessionId } : {}),
            });
            if (result.value === false) throw new Error(`Effort ${effort} is not available for ${provider}/${model}`);
            return result;
          }
    );
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
    if (onDraftModelSelection) {
      onDraftModelSelection(selection);
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
        effort={notApplicable.has('effort') ? '' : effort || agentTier?.effort || ''}
        effortOptions={notApplicable.has('effort') ? [] : known?.effortOptions || []}
        fast={displayedFast && !notApplicable.has('fast')}
        fastVisible={fastControlVisible}
        fastAvailable={fastAvailable}
        contextVisible={maxContextWindow > 0 && !notApplicable.has('contextWindow')}
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
          // An agent's models are managed where the agent is: its card among the providers.
          if (target && agentProvider(target)) {
            onOpenSettings('providers');
            return;
          }
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
        placement={sheetPlacement}
        triggerRowLabel={triggerRowLabel}
      />
    </div>
  );
});
