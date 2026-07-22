import React, { Component, Suspense, lazy, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Code2, Command, FileDiff, Folder, GitCompare, Layers3, LoaderCircle, Mic, PanelLeft, PanelRight, Plus, RotateCcw, ShieldAlert, Sparkles, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { MxIcon } from "./MxIcon";
import type { DesktopCapability, DesktopModelOption, DesktopModelSelection, DesktopPromptAttachment, DesktopPromptContent, DesktopProjectSummary, DesktopSessionSummary, DesktopSubmitOptions, DesktopUpdaterState, EngineSnapshot } from "../shared/contract";
import { approvalInstanceKey, draftAfterSubmission, followAfterScroll, isApprovalDismissKey, isScrollIntentKey, mergeTranscript, normalizeApplyPatch, parseUnifiedDiff, reconcileTurnFailures, shouldNavigatePromptHistory, toolInputRows, transcriptTurnKeys } from "./renderer-logic.mjs";
import { type RecordValue, type Project, type TranscriptItem, type Approval, type Toast, type Snapshot, EMPTY_SNAPSHOT, EMPTY_TRANSCRIPT_ITEMS, hasActiveSnapshotWork, workingSessionIdsForSnapshot } from "./desktop-types";
import { asRecord, displayProject, navigationKey, newDraftSelection, textOf, publicThinkingSummary, oneLine, queueText, formatElapsed, formatIdleDuration, TURN_LOCKED_SLASH_COMMANDS, copyTextToClipboard } from "./text-format";
import { imagePreviewCache, imagePreviewKey, registerImagePreview, lastVisibleTranscriptItemIndex, estimatedTranscriptRowHeight, TRANSCRIPT_VIRTUALIZE_THRESHOLD, TRANSCRIPT_VIRTUAL_OVERSCAN } from "./transcript-metrics";
import { DiffView, TerminalPane } from "./lazy-widgets";
import { OpenSelect } from "./OpenSelect";
import { ModelPicker } from "./ModelPicker";
import { modelDisplayName } from "./provider-display";
import { readCachedModelCatalog, writeCachedModelCatalog } from "./model-catalog-cache";
import { SLASH_COMMANDS, type CommandSurface as CommandSurfaceName, type SettingsSection } from "./slash-commands";
import { acquireModalLayer } from "./modal-layer";
import { applyDesktopTheme, applyDesktopThemePreference, clearDesktopThemePreference, getDesktopThemePreference } from "./desktop-theme";
import { TurnReviewBar } from "./TurnReview";

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
export let workflowOptionsCache: { at: number; options: Array<{ value: string; label: string }> } | null = null;

// Right-aligned composer group: the workflow (mode) picker sits with the Send
// button while model/effort/fast stay left-aligned.
export const WorkflowSelect = memo(function WorkflowSelect({ workflow, disabled, invokeResult, applySnapshot }: {
  workflow?: RecordValue | null;
  disabled: boolean;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: EngineSnapshot | null) => void;
}) {
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>(
    workflowOptionsCache?.options || [],
  );
  const [switching, setSwitching] = useState(false);
  const switchGuard = useRef(false);
  useEffect(() => {
    if (workflowOptionsCache && Date.now() - workflowOptionsCache.at < 300_000) return;
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
          }))
          .filter((option) => option.value);
        if (!cancelled && loaded.length) {
          workflowOptionsCache = { at: Date.now(), options: loaded };
          setOptions(loaded);
        }
      } catch { /* the workflow picker is optional chrome; the settings panel remains the fallback */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const changeWorkflow = async (id: string) => {
    if (disabled || switchGuard.current || !id || id === String(workflow?.id || '')) return;
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
  return <div className="effort-control workflow-control">
    <OpenSelect ariaLabel="Workflow" disabled={disabled || switching}
      value={String(workflow?.id || '')}
      displayValue={String(workflow?.name || workflow?.id || 'Workflow')}
      onChange={(value) => void changeWorkflow(value)}
      options={[
        ...(!workflow?.id ? [{ value: '', label: 'Workflow', disabled: true }] : []),
        ...options,
      ]} />
  </div>;
});

export const ModelSelector = memo(function ModelSelector({ provider, model, effort, fast, fastCapable, modelDisabled, tuningDisabled, invokeResult, applySnapshot, onOpenSettings }: {
  provider: string;
  model: string;
  effort: string;
  fast: boolean;
  fastCapable: boolean;
  modelDisabled: boolean;
  tuningDisabled: boolean;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: EngineSnapshot | null) => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
}) {
  const [cachedCatalog] = useState(readCachedModelCatalog);
  const [models, setModels] = useState<DesktopModelOption[]>(cachedCatalog.models);
  const [providerSetup, setProviderSetup] = useState<unknown>(null);
  const [catalogError, setCatalogError] = useState("");
  const [providerSetupError, setProviderSetupError] = useState("");
  const [catalogLoaded, setCatalogLoaded] = useState(cachedCatalog.models.length > 0);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [routing, setRouting] = useState(false);
  const [optimisticFast, setOptimisticFast] = useState<boolean | null>(null);
  const automaticCatalogAttempted = useRef(false);
  const catalogInFlight = useRef<Promise<void> | null>(null);
  const catalogLoadedAt = useRef(cachedCatalog.updatedAt);
  const routingGuard = useRef(false);
  const restoreAfterRoute = useRef<HTMLElement | null>(null);
  const restoreFastAfterDisabled = useRef(false);
  const fastWasDisabled = useRef(false);
  const fastFocusMovedWhileDisabled = useRef(false);
  const effortControl = useRef<HTMLDivElement>(null);
  const fastControl = useRef<HTMLButtonElement>(null);
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
  const selectableModels = useMemo(() => {
    if (providerSetup == null || providerSetupError) return catalogModels;
    return catalogModels.filter((option) => providerSetupState(providerSetup, option.provider).configured);
  }, [catalogModels, providerSetup, providerSetupError]);
  const selectedEffort = selected?.effortOptions.find((option) => option.value === effort);
  const triggerModel = selected
    ? modelDisplayName(selected.model, selected.provider, selected.display || "")
    : "Select model";

  const loadCatalog = useCallback(async (force = false) => {
    if (catalogInFlight.current) return catalogInFlight.current;
    const listModels = window.mixdogDesktop?.listProviderModels;
    if (!listModels) {
      setCatalogLoaded(true);
      return;
    }
    const request = (async () => {
      const failures: string[] = [];
      try {
        setCatalogRefreshing(true);
        setCatalogError("");
        setProviderSetupError("");
        const setupRequest = window.mixdogDesktop?.invokeCapability
          ? window.mixdogDesktop.invokeCapability<unknown>({
              capability: "getProviderSetup",
              args: force ? [{ refresh: true }] : [],
            })
            .then((setup) => { setProviderSetup(setup.value); })
            .catch((reason) => {
              setProviderSetupError(reason instanceof Error
                ? reason.message
                : String(reason || "Provider status is unavailable."));
            })
          : Promise.resolve();
        try {
          const quick = await listModels({ quick: true });
          if (Array.isArray(quick) && quick.length > 0) {
            setModels(quick);
            setCatalogLoaded(true);
          }
        } catch (reason) {
          failures.push(reason instanceof Error ? reason.message : String(reason || "Quick model catalog failed."));
        }
        // EngineHost seeds its authoritative full request before servicing the
        // advisory quick read. Await quick here so the picker remains instant;
        // the host-side seed protects the catalog from the warmup race.
        try {
          const full = await listModels(force
            ? { force: true, quick: false }
            : { quick: false });
          if (Array.isArray(full)) {
            // The full catalog is authoritative. Replacing the advisory quick
            // rows prevents retired or disconnected models from surviving a
            // refresh forever; an open picker freezes its first rendered set.
            const catalog = writeCachedModelCatalog(full);
            setModels(catalog.models);
            catalogLoadedAt.current = catalog.updatedAt;
          }
        } catch (reason) {
          failures.push(reason instanceof Error ? reason.message : String(reason || "Model catalog failed."));
        }
        await setupRequest;
      } finally {
        setCatalogError([...new Set(failures)].join(" "));
        setCatalogLoaded(true);
        setCatalogRefreshing(false);
      }
    })().finally(() => { catalogInFlight.current = null; });
    catalogInFlight.current = request;
    return request;
  }, [invokeResult]);

  useEffect(() => {
    if (!automaticCatalogAttempted.current && (provider || model)) {
      automaticCatalogAttempted.current = true;
      void loadCatalog();
    }
  }, [loadCatalog, model, provider]);

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
        if (event.target !== fastControl.current) fastFocusMovedWhileDisabled.current = true;
      };
      document.addEventListener('focusin', trackFocus, true);
      return () => document.removeEventListener('focusin', trackFocus, true);
    }
    if (!fastWasDisabled.current) return;
    fastWasDisabled.current = false;
    if (!restoreFastAfterDisabled.current) return;
    if (!fastFocusMovedWhileDisabled.current) {
      fastControl.current?.focus({ preventScroll: true });
    }
    restoreFastAfterDisabled.current = false;
  }, [tuningDisabled]);

  const route = async (selection: DesktopModelSelection, restoreTarget: HTMLElement | null = null) => {
    if (modelUnavailable || routingGuard.current) return false;
    routingGuard.current = true;
    restoreAfterRoute.current = restoreTarget;
    setRouting(true);
    let applied = false;
    try {
      const next = await invokeResult(() => window.mixdogDesktop.setModelRoute(selection));
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
    setOptimisticFast(enabled);
    routingGuard.current = true;
    restoreFastAfterDisabled.current = true;
    restoreAfterRoute.current = fastControl.current;
    setRouting(true);
    try {
      const next = await invokeResult(() => window.mixdogDesktop.setFast(enabled));
      if (next !== undefined) applySnapshot(next);
    } finally {
      setOptimisticFast(null);
      routingGuard.current = false;
      setRouting(false);
    }
  };
  const changeEffort = async (effort: string) => {
    if (tuningUnavailable || routingGuard.current) return;
    routingGuard.current = true;
    restoreAfterRoute.current = effortControl.current?.querySelector('button') || null;
    setRouting(true);
    try {
      const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<string>({
        capability: 'setEffort',
        args: [effort],
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
      popoverId="model-selector-popover"
      catalogLoaded={catalogLoaded} catalogRefreshing={catalogRefreshing}
      catalogError={catalogError} providerSetupError={providerSetupError}
      tooltip={catalogLoaded && selectableModels.length === 0 ? "Add a provider to load models" : "Choose model"}
      onOpen={() => {
        if (!catalogLoaded || Date.now() - catalogLoadedAt.current > 300_000) void loadCatalog(catalogLoaded);
      }}
      onSelect={chooseModel}
      onOpenProviders={() => onOpenSettings("providers")} />
    {selected && selected.effortOptions.length > 0 && (
      <div ref={effortControl} className="effort-control">
        <OpenSelect ariaLabel="Reasoning effort" disabled={tuningUnavailable} value={selectedEffort?.value || ""}
          onChange={(value) => void changeEffort(value)} options={[
            ...(!selectedEffort ? [{ value: '', label: 'Effort', disabled: true }] : []),
            ...selected.effortOptions,
          ]} />
      </div>
    )}
    {fastCapable && (
      <button ref={fastControl} type="button" className="fast-control" aria-label="Fast mode"
        aria-pressed={displayedFast} aria-busy={routing || undefined} disabled={tuningUnavailable}
        onFocus={() => { restoreFastAfterDisabled.current = true; }}
        onClick={() => void changeFast(!displayedFast)}>{displayedFast ? "Fast On" : "Fast Off"}</button>
    )}
  </div>;
});
