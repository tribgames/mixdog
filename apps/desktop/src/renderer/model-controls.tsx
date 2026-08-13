import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopApi, DesktopModelOption, DesktopModelSelection, SessionSnapshot } from "../shared/contract";
import {
  beginBootSurface,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";
import { type RecordValue } from "./desktop-types";
import { FastModeToggle } from "./FastModeToggle";
import { t } from "./i18n";
import { readCachedModelCatalog, writeCachedModelCatalog } from "./model-catalog-cache";
import { ModelPicker } from "./ModelPicker";
import { OpenSelect } from "./OpenSelect";
import { modelDisplayName } from "./provider-display";
import { shouldShowFastControl } from "./renderer-logic.mjs";
import { type SettingsSection } from "./slash-commands";
import { asRecord } from "./text-format";

// @ts-ignore -- shared TUI source has no declaration file.
import { normalizeModelOptions as normalizeTuiModelOptions } from "../../../../src/tui/app/model-options.mjs";

export function providerSetupEntries(value: unknown): Array<RecordValue & { group: "api" | "oauth" | "local" }> {
  const setup = asRecord(value);
  return (["api", "oauth", "local"] as const).flatMap((group) => {
    const rows = setup?.[group];
    return Array.isArray(rows) ? rows.map(asRecord)
      .filter((row): row is RecordValue => Boolean(row))
      .map((row) => ({ ...row, group } as RecordValue & { group: typeof group })) : [];
  });
}

export function providerSetupState(value: unknown, provider: string) {
  const entry = providerSetupEntries(value)
    .find((row) => String(row.id || row.provider || "") === provider);
  if (!entry) return { known: false, configured: false };
  const configured = entry.group === "local"
    ? entry.detected === true && entry.enabled === true
    : entry.authenticated === true;
  return {
    known: true,
    configured,
  };
}

// Workflow packs change rarely; share one fetched option list across composer
// remounts (session/tab switches) with a short TTL.
type WorkflowOption = { value: string; label: string; active: boolean };
export let workflowOptionsCache: { at: number; options: WorkflowOption[] } | null = null;
// Workflow pack edits (and tests) must not serve a stale option list for the
// remaining TTL window.
export function invalidateWorkflowOptionsCache() {
  workflowOptionsCache = null;
}

type SharedModelCatalogRequest = {
  api: DesktopApi;
  startedAt: number;
  full: Promise<DesktopModelOption[]>;
  setup: Promise<unknown>;
};

const SHARED_MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
let sharedModelCatalogRequest: SharedModelCatalogRequest | null = null;

function requestModelCatalog(api: DesktopApi): SharedModelCatalogRequest {
  const current = sharedModelCatalogRequest;
  if (current
    && current.api === api
    && Date.now() - current.startedAt < SHARED_MODEL_CATALOG_MAX_AGE_MS) {
    return current;
  }
  const full = Promise.resolve().then(() =>
    api.listProviderModels?.({ quick: false }) ?? [])
    .then((models) => writeCachedModelCatalog(Array.isArray(models) ? models : []).models);
  const setup = api.invokeCapability
    ? Promise.resolve().then(() => api.invokeCapability<unknown>({
        capability: "getProviderSetup",
        args: [],
      })).then((result) => result.value)
    : Promise.resolve(null);
  const request = {
    api,
    startedAt: Date.now(),
    full,
    setup,
  };
  sharedModelCatalogRequest = request;
  return request;
}

// Model-style trigger for changing the active session workflow.
export const WorkflowSelect = memo(function WorkflowSelect({
  workflow, disabled, invokeResult, applySnapshot, onDraftChange,
}: {
  workflow?: RecordValue | null;
  disabled: boolean;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  onDraftChange?: (workflow: { id: string; name: string }) => void;
}) {
  const [options, setOptions] = useState<WorkflowOption[]>(
    workflowOptionsCache?.options || [],
  );
  const [optionsSettled, setOptionsSettled] = useState(Boolean(workflowOptionsCache));
  const [switching, setSwitching] = useState(false);
  const switchGuard = useRef(false);
  beginBootSurface("workflow-controls", "catalog");
  useEffect(() => {
    if (workflowOptionsCache && Date.now() - workflowOptionsCache.at < 300_000) {
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
        const rows = Array.isArray(result?.value) ? result.value : [];
        const loaded = rows
          .map((row) => ({
            value: String(row?.id || ''),
            label: String(row?.name || row?.label || row?.id || ''),
            active: row?.active === true,
          }))
          .filter((option) => option.value);
        if (!cancelled && loaded.length) {
          workflowOptionsCache = { at: Date.now(), options: loaded };
          setOptions(loaded);
        }
      } catch {
        // Optional chrome settles to the configured engine default.
      } finally {
        if (!cancelled) setOptionsSettled(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!optionsSettled) return;
    reportBootSurfaceStage("workflow-controls", "catalog", "data");
    reportBootSurfaceReady("workflow-controls", "catalog");
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
      const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<string>({
        capability: 'setWorkflow',
        args: [id],
      }));
      if (result !== undefined) applySnapshot(result.snapshot);
    } finally {
      switchGuard.current = false;
      setSwitching(false);
    }
  };
  if (options.length === 0) return null;
  return <div className="composer-route-workflow">
    <OpenSelect variant="route" className="workflow-context-select"
      ariaLabel="Workflow" disabled={disabled || switching}
      value={selectedId}
      displayValue={String(workflow?.name || selected?.label || selectedId)}
      onChange={(value) => void changeWorkflow(value)}
      options={options} />
  </div>;
});

export const ModelSelector = memo(function ModelSelector({
  provider, model, effort, fast, fastCapable, modelDisabled, tuningDisabled,
  invokeResult, applySnapshot, onOpenSettings, onDraftSelection,
  onFastPreferenceApplied, sessionId,
}: {
  provider: string;
  model: string;
  effort: string;
  fast: boolean;
  fastCapable: boolean;
  modelDisabled: boolean;
  tuningDisabled: boolean;
  /** The pane's session. Route changes address it directly, so a background
   *  pane can change ITS model without the window's focus deciding. */
  sessionId?: string;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  onDraftSelection?: (selection: DesktopModelSelection) => void;
  onFastPreferenceApplied?: (selection: DesktopModelSelection) => void;
}) {
  const [cachedCatalog] = useState(readCachedModelCatalog);
  const [models, setModels] = useState<DesktopModelOption[]>(cachedCatalog.models);
  const [providerSetup, setProviderSetup] = useState<unknown>(null);
  const [catalogError, setCatalogError] = useState("");
  const [providerSetupError, setProviderSetupError] = useState("");
  const [catalogLoaded, setCatalogLoaded] = useState(cachedCatalog.models.length > 0);
  const [startupCatalogSettled, setStartupCatalogSettled] = useState(
    cachedCatalog.models.length > 0,
  );
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [routing, setRouting] = useState(false);
  const [optimisticFast, setOptimisticFast] = useState<boolean | null>(null);
  const catalogInFlight = useRef<Promise<void> | null>(null);
  const routingGuard = useRef(false);
  const restoreAfterRoute = useRef<HTMLElement | null>(null);
  const restoreFastAfterDisabled = useRef(false);
  const fastWasDisabled = useRef(false);
  const fastFocusMovedWhileDisabled = useRef(false);
  const effortControl = useRef<HTMLDivElement>(null);
  const fastControl = useRef<HTMLDivElement>(null);
  const modelBootKey = `${provider || "none"}:${model || "none"}`;
  beginBootSurface("model-controls", modelBootKey);
  const modelUnavailable = modelDisabled || routing;
  const tuningUnavailable = tuningDisabled || routing;
  const displayedFast = optimisticFast ?? fast;
  const catalogModels = useMemo(() => {
    const unique = new Map<string, DesktopModelOption>();
    for (const option of models) {
      if (option?.provider && option?.model) unique.set(`${option.provider}:${option.model}`, option);
    }
    const normalized = normalizeTuiModelOptions(
      [...unique.values()].map((option) => ({ ...option, id: option.model })),
    ) as Array<DesktopModelOption & { id?: string }>;
    return normalized.map((entry) => {
      const { id: _id, ...option } = entry;
      return option as DesktopModelOption;
    });
  }, [models]);
  const selected = catalogModels.find((option) =>
    option.provider === provider && option.model === model);
  // The picker list is trimmed (family limits) and starts empty on a cold
  // catalog, so a perfectly valid route — a schedule/webhook session opened
  // right after it ran — could not be named from it (user: 세션 생성 시 쓴
  // 모델이 그대로 표기되게). The RAW catalog answers those cases.
  const known = selected || models.find((option) =>
    option.provider === provider && option.model === model);
  const fastAvailable = shouldShowFastControl(fastCapable, known?.fastCapable);
  const selectableModels = useMemo(() => {
    if (providerSetup == null || providerSetupError) return catalogModels;
    return catalogModels.filter((option) => providerSetupState(providerSetup, option.provider).configured);
  }, [catalogModels, providerSetup, providerSetupError]);
  const selectedEffort = known?.effortOptions.find((option) => option.value === effort);
  // A route the loaded catalog does not know at all stays "Select model": an
  // unknown/retired persisted id must never read as a selectable model.
  const triggerModel = known
    ? modelDisplayName(known.model, known.provider, known.display || "")
    : model && !catalogLoaded
      ? modelDisplayName(model, provider)
      : t("Select model");

  const loadCatalog = useCallback(async () => {
    if (catalogInFlight.current) return catalogInFlight.current;
    const api = window.mixdogDesktop;
    if (!api?.listProviderModels) {
      setCatalogLoaded(true);
      setStartupCatalogSettled(true);
      return;
    }
    const request = (async () => {
      const failures: string[] = [];
      try {
        setCatalogRefreshing(true);
        setCatalogError("");
        setProviderSetupError("");
        const shared = requestModelCatalog(api);
        const setupRequest = shared.setup
            .then((setup) => { setProviderSetup(setup); })
            .catch((reason) => {
              console.warn("[model-catalog] provider setup refresh failed", reason);
              setProviderSetupError("unavailable");
            })
        ;
        try {
          const full = await shared.full;
          if (Array.isArray(full)) {
            // Only complete catalog snapshots reach the picker. The previous
            // complete snapshot remains visible while boot/24h refresh runs.
            setModels(full);
          }
        } catch (reason) {
          failures.push(reason instanceof Error ? reason.message : String(reason || "Model catalog failed."));
        }
        await setupRequest;
      } finally {
        setCatalogError([...new Set(failures)].join(" "));
        setCatalogLoaded(true);
        setCatalogRefreshing(false);
        setStartupCatalogSettled(true);
      }
    })().finally(() => { catalogInFlight.current = null; });
    catalogInFlight.current = request;
    return request;
  }, [invokeResult]);

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
    // One boot request and one 24h timer per mounted control. The module-level
    // request and daemon catalog epoch deduplicate panes and sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (model && !startupCatalogSettled) return;
    reportBootSurfaceStage("model-controls", modelBootKey, "data");
    reportBootSurfaceReady("model-controls", modelBootKey);
  }, [model, modelBootKey, startupCatalogSettled]);

  useEffect(() => {
    if (optimisticFast !== null && optimisticFast === fast) setOptimisticFast(null);
  }, [fast, optimisticFast]);

  useEffect(() => {
    if (routing || !restoreAfterRoute.current) return;
    const target = restoreAfterRoute.current;
    restoreAfterRoute.current = null;
    target.focus({ preventScroll: true });
  }, [routing]);

  useEffect(() => {
    if (tuningDisabled) {
      fastWasDisabled.current = true;
      fastFocusMovedWhileDisabled.current = false;
      const trackFocus = (event: FocusEvent) => {
        // Disabling the focused button can move focus to the document body
        // without user intent. Preserve the restore request for that browser
        // fallback, but respect any explicit move to another control.
        if (event.target !== document.body
          && event.target !== document.documentElement
          && event.target !== fastControl.current?.querySelector('button')) {
          fastFocusMovedWhileDisabled.current = true;
        }
      };
      document.addEventListener('focusin', trackFocus, true);
      return () => document.removeEventListener('focusin', trackFocus, true);
    }
    if (!fastWasDisabled.current) return;
    fastWasDisabled.current = false;
    if (!restoreFastAfterDisabled.current) return;
    if (!fastFocusMovedWhileDisabled.current) {
      fastControl.current?.querySelector('button')?.focus({ preventScroll: true });
    }
    restoreFastAfterDisabled.current = false;
  }, [tuningDisabled]);

  const route = async (selection: DesktopModelSelection, restoreTarget: HTMLElement | null = null) => {
    if (modelUnavailable || routingGuard.current) return false;
    if (onDraftSelection) {
      onDraftSelection(selection);
      window.queueMicrotask(() => restoreTarget?.focus({ preventScroll: true }));
      return true;
    }
    routingGuard.current = true;
    restoreAfterRoute.current = restoreTarget;
    setRouting(true);
    let applied = false;
    try {
      const next = await invokeResult(
        () => window.mixdogDesktop.setModelRoute(selection, sessionId),
      );
      if (next !== undefined) {
        applySnapshot(next);
        applied = true;
      }
    } finally {
      routingGuard.current = false;
      setRouting(false);
    }
    return applied;
  };
  const chooseModel = (option: DesktopModelOption) => {
    const values = option.effortOptions.map((entry) => entry.value);
    const sameModel = option.provider === provider && option.model === model;
    const nextEffort = sameModel && effort && values.includes(effort)
      ? effort
      : option.savedEffort && values.includes(option.savedEffort)
        ? option.savedEffort
        : ['high', 'medium', 'low', 'none', 'xhigh', 'max', 'ultra'].find((value) => values.includes(value)) || values[0];
    const nextFast = option.fastCapable
      ? sameModel
        ? displayedFast
        : typeof option.savedFast === 'boolean'
          ? option.savedFast
          : option.fastPreferred
      : undefined;
    return route({
      provider: option.provider,
      model: option.model,
      ...(nextEffort ? { effort: nextEffort } : {}),
      ...(nextFast === undefined ? {} : { fast: nextFast }),
    });
  };
  const changeFast = async (enabled: boolean) => {
    if (tuningUnavailable || routingGuard.current) return;
    if (onDraftSelection && provider && model) {
      onDraftSelection({
        provider,
        model,
        ...(effort ? { effort } : {}),
        fast: enabled,
      });
      return;
    }
    setOptimisticFast(enabled);
    routingGuard.current = true;
    try {
      const next = await invokeResult(() => window.mixdogDesktop.setFast(enabled, sessionId));
      if (next !== undefined) {
        applySnapshot(next);
        if (provider && model) {
          onFastPreferenceApplied?.({
            provider,
            model,
            ...(effort ? { effort } : {}),
            fast: enabled,
          });
        }
      }
    } finally {
      setOptimisticFast(null);
      routingGuard.current = false;
    }
  };
  const changeEffort = async (effort: string) => {
    if (tuningUnavailable || routingGuard.current) return;
    if (onDraftSelection && provider && model) {
      onDraftSelection({
        provider,
        model,
        effort,
        ...(fastCapable ? { fast: displayedFast } : {}),
      });
      return;
    }
    routingGuard.current = true;
    restoreAfterRoute.current = effortControl.current?.querySelector('button') || null;
    setRouting(true);
    try {
      const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<string>({
        capability: 'setEffort',
        args: [effort],
        ...(sessionId ? { sessionId } : {}),
      }));
      if (result !== undefined) applySnapshot(result.snapshot);
    } finally {
      routingGuard.current = false;
      setRouting(false);
    }
  };

  return <div className="route-controls">
    <ModelPicker models={selectableModels} provider={provider} model={model}
      triggerLabel={triggerModel} disabled={modelUnavailable}
      catalogLoaded={catalogLoaded} catalogRefreshing={catalogRefreshing}
      catalogError={catalogError} providerSetupError={providerSetupError}
      tooltip={catalogLoaded && selectableModels.length === 0 ? t("Add a provider to load models") : t("Choose model")}
      onSelect={chooseModel}
      onOpenProviders={() => onOpenSettings("providers")} />
    {known && known.effortOptions.length > 0 && (
      <div ref={effortControl} className="effort-control">
        <OpenSelect variant="route" ariaLabel={t("Reasoning effort")}
          disabled={tuningUnavailable} value={selectedEffort?.value || ""}
          localizeLabels={false}
          onChange={(value) => void changeEffort(value)} options={[
            ...(!selectedEffort ? [{ value: '', label: 'Effort', disabled: true }] : []),
            ...known.effortOptions,
          ]} />
      </div>
    )}
    {fastAvailable && (
      <div ref={fastControl} className="fast-control"
        aria-busy={optimisticFast !== null || undefined}
        onFocusCapture={() => { restoreFastAfterDisabled.current = true; }}>
        <FastModeToggle enabled={displayedFast} disabled={tuningUnavailable}
          onChange={(enabled) => void changeFast(enabled)} />
      </div>
    )}
  </div>;
});
