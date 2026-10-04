/**
 * App.jsx — the React/ink chat application.
 *
 * Layout (top → bottom):
 *   welcome banner
 *   transcript (finished items, a live column — terminal scrolls older rows off)
 *   live reasoning (◈ Thinking… — only while a turn streams)
 *   spinner / TurnDone (while a turn runs / just finished)
 *   slash/model pickers (attached above the prompt)
 *   queued steering prompts + rounded prompt input (one cluster)
 *   statusline (vendored L1/L2)
 *
 * State comes from the session store via useSession; submitting a line calls
 * store.submit() (or handles a slash command locally). The whole tree is live
 * (no <Static>): full-width bands and the native hardware caret both need real
 * layout, which <Static> collapses. The terminal handles scrollback itself as
 * the transcript column grows past the screen height.
 */
import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useApp, useStdin, useStdout } from 'ink';
import { useSession } from './hooks/useSession.mjs';
import { pickFolder } from '../standalone/folder-dialog.mjs';
import { deriveSlashPalette } from './app/slash-palette.mjs';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './app/panel-epoch.mjs';
import { createPanelSurface } from './app/panel-surface.mjs';
import { resolvePickerState } from './app/picker-index-mode.mjs';
import { usePromptLayoutRows } from './app/use-prompt-layout-rows.mjs';
import { usePanelTransition } from './app/use-panel-transition.mjs';
import { useUiOpenRequest } from './app/use-ui-open-request.mjs';
import { useMouseInput } from './app/use-mouse-input.mjs';
import { useTranscriptScroll } from './app/use-transcript-scroll.mjs';
import { useTranscriptScrollState } from './app/use-transcript-scroll-state.mjs';
import { usePromptState } from './app/use-prompt-state.mjs';
import { useInteractionRefs } from './app/use-interaction-refs.mjs';
import { usePastedBuffers } from './app/use-pasted-buffers.mjs';
import { usePromptHint } from './app/use-prompt-hint.mjs';
import { useWelcomePromptHint } from './app/use-welcome-prompt-hint.mjs';
import { useCopySelection } from './app/use-copy-selection.mjs';
import { createUsageContextPanels } from './app/usage-context-panels.mjs';
import { createPromptSubmit } from './app/prompt-submit.mjs';
import { computeShellLayout } from './app/shell-layout.mjs';
import { useGlobalKeyInput } from './app/use-global-key-input.mjs';
import { renderAppView } from './app/app-view.jsx';
import { usePromptDraftFlow } from './app/use-prompt-draft-flow.mjs';
import { useTranscriptActivity } from './app/use-transcript-activity.mjs';
import { createAppPickers } from './app/create-app-pickers.mjs';
import { usePromptQueueHistory } from './app/use-prompt-queue-history.mjs';
import { useMessageSelector } from './app/message-selector.mjs';
import { useTerminalChrome } from './app/use-terminal-chrome.mjs';
import { useTranscriptWindow } from './app/use-transcript-window.mjs';
import { transcriptSwapReturnsToTail } from './app/transcript-window.mjs';
import { terminalSize, projectNameFromPath } from './app/app-format.mjs';
import { useWorkflowTabCycle } from './app/use-workflow-tab-cycle.mjs';
import { createProjectPicker } from './app/project-picker.mjs';
import { usePromptHandlers } from './app/use-prompt-handlers.mjs';
import { useModelCatalogCache } from './app/use-model-catalog-cache.mjs';
import { useDisabledSkills } from './app/use-disabled-skills.mjs';
import { resolveOnboardingCompleted, useOnboardingStart } from './app/use-onboarding-start.mjs';

export function App({ store, initialStatusLine = '', forceOnboarding = false, onboardingCompleted = undefined }) {
  const state = useSession(store);
  const [toolOutputExpanded, setToolOutputExpanded] = useState(false);
  // True for the entire first-run onboarding wizard (every step + nested depth)
  // so the welcome banner stays reserved and the layout doesn't jump when the
  // step pickers mount. Cleared on finish/cancel.
  const [onboardingActive, setOnboardingActive] = useState(false);
  const { exit } = useApp();
  // internal_eventEmitter is ink's parsed-input bus. ink 7 consumes stdin via
  // the 'readable' event + stdin.read() (see ink's App.js), draining the buffer
  // so a plain stdin.on('data') listener of ours never sees mouse bytes. Instead
  // we subscribe to ink's 'input' events, which carry every parsed sequence —
  // including raw SGR mouse sequences (\x1b[<…M/m), since ink's input-parser
  // passes CSI sequences through untouched and emitInput forwards them verbatim.
  const { isRawModeSupported, internal_eventEmitter: inkInput } = useStdin();
  const { stdout } = useStdout();
  const [exiting, setExiting] = useState(false);
  // tuiReady stays false across the first render + commit. A setTimeout(0) in
  // the first effect defers the flip until one event-loop poll has drained any
  // keystrokes that the OS buffered during terminal setup / initial mount.
  const [tuiReady, setTuiReady] = useState(false);
  const exitRequestedRef = useRef(false);
  const [resizeState, setResizeState] = useState(() => ({ ...terminalSize(stdout), epoch: 0 }));
  const [panelTransitionEpoch, setPanelTransitionEpoch] = useState(0);
  const [panelInkMaskEpoch, setPanelInkMaskEpoch] = useState(0);
  // Keep a universal one-cell margin at the right edge: terminals may clip or
  // wrap their final cell, including macOS terminals rendering rounded borders.
  const rightSafetyColumns = 1;
  const frameColumns = Math.max(1, resizeState.columns - rightSafetyColumns);
  const {
    scrollOffset,
    setScrollOffset,
    scrollPositionRef,
    scrollTargetRef,
    maxScrollRowsRef,
    transcriptBottomSlackRowsRef,
    transcriptAnchorRef,
    transcriptAnchorDirtyRef,
    transcriptGeomRef,
    measuredRowsVersion,
    setMeasuredRowsVersion,
    followingRef,
    lastItemsCountRef,
    lastFirstItemIdRef,
  } = useTranscriptScrollState();
  // picker = null | { type, title, items, onSelect }
  // Rendered as an option panel attached directly above the bottom prompt.
  const pickerOpenedFromEnterRef = useRef(false);
  const pickerOpenedFromEnterTimerRef = useRef(null);
  // Late-bound handle to the project-picker cluster (created after the picker
  // and prompt setters exist, below). Referencing it via a ref lets the
  // `useState` initializer build the first-mount picker state before the
  // factory is instantiated: the factory's onSelect/onKey/onCancel closures
  // resolve `projectPicker.current` at call time, not at build time.
  const projectPickerRef = useRef(null);
  // NOTE: the initial project-picker state CANNOT be built inside this
  // useState initializer — it runs before projectPickerRef is populated
  // (createProjectPicker below), so buildProjectPickerState would deref null.
  // The first-mount build happens as a render-phase update right after the
  // factory is instantiated (see initialPickerBuiltRef below), which React
  // applies before the first commit — no picker-less flash frame.
  const [picker, setPickerState] = useState(null);
  // Live handle to the current picker state so async callbacks (e.g. the MCP
  // toggle settle guard in extension-pickers) read the picker actually on
  // screen at call time — including pickers opened by other factories — rather
  // than a stale closure. Updated synchronously in setPicker (below) so a
  // settle firing before the next render sees the right _kind; render-time
  // sync further down is a backstop.
  const livePickerRef = useRef(null);
  const setPicker = useCallback((next) => {
    // Synchronous ref update so out-of-band setPicker(null/other) is visible to
    // in-flight async guards immediately, before React commits the next render.
    const previousPicker = livePickerRef.current;
    livePickerRef.current = typeof next === 'function' ? next(previousPicker) : next;
    // A real handover — closing the panel (open → null) OR replacing it with a
    // different panel — gives the surface to what the user is looking at now:
    // supersede every deferred paint issued before this point so a daemon write
    // settling afterwards cannot resurrect the dismissed panel or clobber the
    // panel that replaced it. Rebuilding the SAME panel keeps ownership (its
    // own refresh must land), and a redundant null → null (or a first open) is
    // not a handover and must not invalidate the in-flight write of a
    // text-entry prompt that is currently on screen.
    if (shouldSupersedePanelEpoch(previousPicker, livePickerRef.current)) supersedePanelEpoch();
    setPickerState((prev) =>
      resolvePickerState(prev, typeof next === 'function' ? next(prev) : next, {
        pickerOpenedFromEnterRef,
        pickerOpenedFromEnterTimerRef,
      })
    );
  }, []);
  // Backstop: keep the ref aligned with committed state each render.
  livePickerRef.current = picker;
  const [contextPanel, setContextPanel] = useState(null);
  const [usagePanel, setUsagePanel] = useState(null);
  // OWNING LAYER (app/panel-surface.mjs): the three sinks above are handed over
  // exactly once and never leave that module. Every panel factory below gets
  // `surface` instead, so painting or delegating without a claim that proves
  // ownership is not expressible outside this file. Stable across renders — the
  // usage generation lives inside it.
  const surfaceRef = useRef(null);
  if (!surfaceRef.current) {
    surfaceRef.current = createPanelSurface({ setPicker, setContextPanel, setUsagePanel });
  }
  const surface = surfaceRef.current;
  // Cache of the last computed heavy settings-picker status objects (MCP,
  // plugins, skills, channel provider). ←/→ cycle/toggle handlers in
  // openSettingsPicker() pass { light: true } to reuse this cache instead of
  // re-querying these heavy getters on every keystroke; only a full open
  // (initial /config or Esc-return) recomputes them.
  const settingsHeavyCacheRef = useRef(null);
  // Settings build generation: every open/refresh takes a ticket and Esc bumps
  // it, so a slow (daemon) snapshot from a superseded build cannot re-open the
  // panel after it was closed.
  const settingsRequestRef = useRef(0);
  const closeUsagePanel = useCallback(() => surface.closeUsage(), [surface]);
  const [providerPrompt, setProviderPrompt] = useState(null);
  const oauthSubmitRef = useRef(false);
  const [settingsPrompt, setSettingsPrompt] = useState(null);
  // Instantiate the project-picker cluster now that the surface + every prompt
  // setter and the usage-panel closer exist. projectPickerRef (declared above,
  // before the picker useState) is populated here so first-mount build and all
  // later callers resolve the same set of builders.
  const projectPicker = createProjectPicker({
    state,
    store,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    closeUsagePanel,
    projectNameFromPath,
    pickFolder,
  });
  projectPickerRef.current = projectPicker;
  // First-mount picker build (render-phase update, applied pre-commit).
  // First-run onboarding owns the initial screen: skip the project picker so
  // it doesn't flash for a frame before the wizard's first step mounts.
  const initialPickerBuiltRef = useRef(false);
  if (!initialPickerBuiltRef.current) {
    initialPickerBuiltRef.current = true;
    const onboardingOwnsScreen = !resolveOnboardingCompleted(store, onboardingCompleted) || forceOnboarding;
    if (!onboardingOwnsScreen && state.items.length === 0) {
      setPicker(projectPicker.buildProjectPickerState({ initialEntry: true, loading: true }));
    }
  }
  useEffect(() => {
    if (livePickerRef.current?._projectInitialPending !== true) return;
    void projectPickerRef.current?.openProjectPicker({ initialEntry: true });
  }, [store]);
  const { registerProject, enterProject, openProjectPicker } = projectPicker;
  // Disabled-Skill set (async load + persist on change):
  // app/use-disabled-skills.mjs.
  const { disabledSkills, setDisabledSkills } = useDisabledSkills({ store });
  const toolApproval = state.toolApproval || null;
  const {
    promptDraft,
    setPromptDraft,
    promptDraftOverride,
    setPromptDraftOverride,
    promptLayoutValueRef,
    setPromptLayoutRows,
    textEntryLayoutRows,
    setTextEntryLayoutRows,
    promptValueRef,
    promptSelectionRef,
    promptBoxRectRef,
    promptMouseSelectionRef,
    promptHistoryNavRef,
    promptHistoryDraftChangeRef,
  } = usePromptState();
  // Pasted image/text buffers + their [ref-token] lifecycle:
  // app/use-pasted-buffers.mjs.
  const {
    pastedImagesRef,
    pastedTextsRef,
    installPastedImages,
    clearPastedImagesSnapshot,
    registerPastedImage,
    installPastedTexts,
    clearPastedTextsSnapshot,
    registerPastedText,
  } = usePastedBuffers();
  // Transient hint band under the prompt: app/use-prompt-hint.mjs.
  const {
    promptHint,
    promptHintTone,
    promptHintTimerRef,
    promptHintActiveRef,
    showPromptHint,
    showSelectionCopyHint,
    clearPromptHint,
  } = usePromptHint();
  const toastErrorSignature = useMemo(
    () =>
      (state.toasts || [])
        .filter((toast) => toast?.tone === 'error')
        .map((toast) => `${toast.id || ''}:${toast.text || ''}`)
        .join('|'),
    [state.toasts]
  );
  // Welcome-screen starter tip + conditional setup hints:
  // app/use-welcome-prompt-hint.mjs.
  const {
    welcomePromptHintDismissed,
    conditionalWelcomePromptHint,
    welcomePromptHintRef,
    welcomePromptHintVisibleRef,
    dismissWelcomePromptHint,
  } = useWelcomePromptHint({ store, state, toastErrorSignature });
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedFor, setSlashDismissedFor] = useState('');
  const slashPaletteRef = useRef({ open: false, count: 0 });
  const scrollFocusRef = useRef({});
  const onboardingStartedRef = useRef(false);
  const onboardingRef = useRef({
    defaultRoute: null,
    webSearchRoute: null,
    agentRoutes: {},
    agents: [],
    providerModels: [],
  });
  // Provider/web-search catalog caches + boot warm-up:
  // app/use-model-catalog-cache.mjs.
  const {
    providerModelsCacheRef,
    webSearchModelsCacheRef,
    modelPickerRequestRef,
    onboardingPrefetchSeqRef,
    clearModelCaches,
  } = useModelCatalogCache({ store, onboardingRef });
  // Picker/panel factories + slash dispatch: app/create-app-pickers.mjs.
  const {
    openMemoryCorePicker,
    openMcpServersPicker,
    openProjectSkillsPicker,
    openPluginsPicker,
    openAutoClearPicker,
    openProfilePicker,
    openOnboardingAuthStep,
    openProviderSetupPicker,
    openSettingsPicker,
    openDeveloperPicker,
    runSlashCommand,
  } = createAppPickers({
    state,
    store,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    setOnboardingActive,
    closeUsagePanel,
    oauthSubmitRef,
    clearModelCaches,
    onboardingRef,
    providerModelsCacheRef,
    webSearchModelsCacheRef,
    modelPickerRequestRef,
    onboardingPrefetchSeqRef,
    settingsHeavyCacheRef,
    settingsRequestRef,
    livePickerRef,
    disabledSkills,
    setDisabledSkills,
    enterProject,
    openProjectPicker,
    requestExit: (...a) => requestExit(...a),
    openUsagePanel: (...a) => openUsagePanel(...a),
    openContextPicker: (...a) => openContextPicker(...a),
  });
  // Setup tool `open` requests: app/use-ui-open-request.mjs.
  useUiOpenRequest({
    uiOpenRequest: state.uiOpenRequest,
    runSlashCommand,
    sections: { openDeveloperPicker, openSettingsPicker, pushNotice: (...a) => store.pushNotice(...a) },
  });
  const {
    dragRef,
    transcriptViewportRef,
    panelTransitionRef,
    panelCloseInkMaskRowsRef,
    projectBootInputLatchRef,
    frameRowsRef,
    selectionLayoutRef,
    selectionTextRef,
    lastClickRef,
  } = useInteractionRefs();
  const STATUSLINE_BAND_ROWS = 3;
  const promptContentColumns = Math.max(1, frameColumns - 4);
  // Prompt + text-entry layout rows: app/use-prompt-layout-rows.mjs.
  const syncPromptLayoutRows = usePromptLayoutRows({
    frameColumns,
    promptContentColumns,
    promptLayoutValueRef,
    setPromptLayoutRows,
    settingsPrompt,
    setTextEntryLayoutRows,
  });

  // ── Post-mount input gate ──────────────────────────────────────────────
  // Let one event-loop poll pass so Ink processes (and discards, because
  // PromptInput is still disabled) any keystrokes queued during boot/first
  // render. After the tick, enable the input — new keystrokes land normally.
  useEffect(() => {
    const timer = setTimeout(() => setTuiReady(true), 0);
    return () => clearTimeout(timer);
  }, []);

  // Resize debounce + extended-keyboard enable: app/use-terminal-chrome.mjs.
  useTerminalChrome({ stdout, isRawModeSupported, setResizeState });

  // Transcript scroll + grid-selection engine: extracted to app/use-transcript-scroll.mjs.
  const {
    stopSmoothScroll,
    resetTranscriptScroll,
    armTranscriptFollow,
    withSelectionClip,
    paintSelectionRect,
    applySelectionRect,
    applySelectionRectThrottled,
    selectionPointAtCurrentScroll,
    buildSpanRect,
    gridSelectionActiveRef,
    scrollTranscriptRows,
    queueScrollCoalesced,
    moveSelectionFocus,
    getStitchedSelectionText,
    clearStitchBuffer,
  } = useTranscriptScroll({
    store,
    frameColumns,
    statuslineBandRows: STATUSLINE_BAND_ROWS,
    setScrollOffset,
    scrollPositionRef,
    scrollTargetRef,
    maxScrollRowsRef,
    transcriptBottomSlackRowsRef,
    followingRef,
    transcriptAnchorRef,
    transcriptAnchorDirtyRef,
    transcriptGeomRef,
    dragRef,
    frameRowsRef,
    transcriptViewportRef,
    selectionLayoutRef,
    selectionTextRef,
  });

  // Ctrl+C selection copy (render/remembered/stitch merge + retry + hint):
  // app/use-copy-selection.mjs. Declared after useTranscriptScroll so
  // getStitchedSelectionText exists (TDZ).
  const { copySelection } = useCopySelection({
    store,
    selectionTextRef,
    getStitchedSelectionText,
    showSelectionCopyHint,
  });

  useEffect(
    () => () => {
      stopSmoothScroll();
    },
    [stopSmoothScroll]
  );

  // SGR mouse handling: extracted to app/use-mouse-input.mjs (useMouseInput).
  const { settleStuckDrag } = useMouseInput({
    inkInput,
    isRawModeSupported,
    store,
    stdout,
    frameColumns,
    statuslineBandRows: STATUSLINE_BAND_ROWS,
    dragRef,
    lastClickRef,
    slashPaletteRef,
    scrollFocusRef,
    promptMouseSelectionRef,
    frameRowsRef,
    promptBoxRectRef,
    transcriptViewportRef,
    scrollTargetRef,
    stopSmoothScroll,
    applySelectionRect,
    applySelectionRectThrottled,
    selectionPointAtCurrentScroll,
    buildSpanRect,
    queueScrollCoalesced,
    setSlashIndex,
    setMeasuredRowsVersion,
    clearStitchBuffer,
  });

  // Item-count changes never infer follow permission from scrollTarget=0. A
  // first read-back input can be waiting one frame for committed row geometry;
  // only prompt submit, session reset, or an explicit return to bottom arms
  // follow. Pure streaming height growth is handled in the row-delta effect.
  useLayoutEffect(() => {
    const count = state.items.length;
    const previousCount = lastItemsCountRef.current;
    lastItemsCountRef.current = count;
    const firstId = count > 0 ? (state.items[0]?.id ?? null) : null;
    const previousFirstId = lastFirstItemIdRef.current;
    lastFirstItemIdRef.current = firstId;
    // A bulk swap (compaction included) is an explicit return to the tail: the
    // rows the reader was anchored to no longer exist.
    if (transcriptSwapReturnsToTail({ count, previousCount, firstId, previousFirstId })) {
      resetTranscriptScroll();
    }
  }, [state.items, resetTranscriptScroll]);

  // Exit + queued-restore + prompt history: app/use-prompt-queue-history.mjs.
  const { requestExit, restoreQueuedToPrompt, recentPromptHistory, resetPromptHistoryNav } = usePromptQueueHistory({
    store,
    state,
    exit,
    exitRequestedRef,
    setExiting,
    promptValueRef,
    promptDraft,
    showPromptHint,
    clearPromptHint,
    installPastedImages,
    installPastedTexts,
    syncPromptLayoutRows,
    setPromptDraftOverride,
    promptHistoryNavRef,
  });

  // Double-Esc message selector: app/message-selector.mjs.
  const { hasUserMessages, openMessageSelector } = useMessageSelector({
    store,
    state,
    surface,
    setPromptDraftOverride,
    syncPromptLayoutRows,
    showPromptHint,
    clearPromptHint,
  });

  // PROMPT HANDLER cluster extracted to app/use-prompt-handlers.mjs.
  const { handlePromptPaste, handlePromptHistoryNavigate, handlePromptEscape, handlePromptInterrupt } =
    usePromptHandlers({
      store,
      state,
      promptValueRef,
      promptHistoryNavRef,
      promptHistoryDraftChangeRef,
      setPromptDraftOverride,
      surface,
      syncPromptLayoutRows,
      showPromptHint,
      clearPromptHint,
      recentPromptHistory,
      resetPromptHistoryNav,
      restoreQueuedToPrompt,
      openMessageSelector,
      usagePanel,
      closeUsagePanel,
      contextPanel,
      installPastedImages,
      clearPastedImagesSnapshot,
      registerPastedImage,
      installPastedTexts,
      clearPastedTextsSnapshot,
      registerPastedText,
    });

  // Ctrl+O toggles the global tool-output expansion, matching common terminal-chat
  // expectation that this is a view mode rather than a per-card hidden state.
  const toggleExpand = useCallback(() => {
    setToolOutputExpanded((expanded) => !expanded);
  }, []);

  // App-level key handling (approval keys, copy-first Ctrl+C, grid-selection
  // chords, panel Escapes, transcript paging): app/use-global-key-input.mjs.
  useGlobalKeyInput({
    store,
    toolApproval,
    picker,
    usagePanel,
    contextPanel,
    surface,
    closeUsagePanel,
    isRawModeSupported,
    resizeState,
    promptSelectionRef,
    promptMouseSelectionRef,
    dragRef,
    scrollFocusRef,
    gridSelectionActiveRef,
    moveSelectionFocus,
    copySelection,
    showSelectionCopyHint,
    toggleExpand,
    scrollTranscriptRows,
    resetTranscriptScroll,
    applySelectionRect,
    settleStuckDrag,
  });

  // Usage-quota dashboard + /context breakdown panels:
  // app/usage-context-panels.mjs (same factory pattern as the pickers).
  const { openUsagePanel, openContextPicker } = createUsageContextPanels({
    store,
    state,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    closeUsagePanel,
  });

  useEffect(() => {
    if (contextPanel?.kind === 'context') openContextPicker();
  }, [
    contextPanel?.kind,
    state.stats,
    state.contextWindow,
    state.rawContextWindow,
    state.sessionId,
    state.toolMode,
    state.agentWorkers,
    state.agentJobs,
    state.provider,
    state.model,
    state.effort,
    state.fast,
    state.cwd,
    state.clientHostPid,
  ]);

  // First-run onboarding wizard launch: app/use-onboarding-start.mjs.
  useOnboardingStart({
    store,
    forceOnboarding,
    onboardingCompleted,
    onboardingStartedRef,
    setOnboardingActive,
    openOnboardingAuthStep,
  });

  // Prompt submit dispatcher (text-entry prompts, slash commands, chat
  // submit + pasted-token expansion): app/prompt-submit.mjs.
  const { onSubmit } = createPromptSubmit({
    store,
    state,
    providerPrompt,
    settingsPrompt,
    setProviderPrompt,
    setSettingsPrompt,
    oauthSubmitRef,
    clearModelCaches,
    openProviderSetupPicker,
    openSettingsPicker,
    openProjectPicker,
    openAutoClearPicker,
    openProfilePicker,
    openPluginsPicker,
    openMcpServersPicker,
    openProjectSkillsPicker,
    openMemoryCorePicker,
    registerProject,
    runSlashCommand,
    armTranscriptFollow,
    clearPastedImagesSnapshot,
    clearPastedTextsSnapshot,
    pastedImagesRef,
    pastedTextsRef,
  });

  const { activeSlashQuery, slashCommands, slashPaletteOpen } = deriveSlashPalette({
    providerPrompt,
    settingsPrompt,
    toolApproval,
    contextPanel,
    usagePanel,
    picker,
    exiting,
    commandBusy: state.commandBusy,
    promptDraft,
    slashDismissedFor,
  });
  slashPaletteRef.current = { open: slashPaletteOpen, count: slashCommands.length };
  scrollFocusRef.current = {
    slashPaletteOpen,
    picker: !!picker,
    toolApproval: !!toolApproval,
    contextPanel: !!contextPanel,
    usagePanel: !!usagePanel,
    providerPrompt: !!providerPrompt,
    settingsPrompt: !!settingsPrompt,
  };

  useEffect(() => {
    setSlashIndex((index) => Math.min(index, Math.max(0, slashCommands.length - 1)));
  }, [slashCommands.length, activeSlashQuery]);

  // Draft/slash flow (draft sync, prompt cancels, palette accept/cancel):
  // app/use-prompt-draft-flow.mjs.
  const {
    onPromptDraftChange,
    cancelProviderPrompt,
    cancelSettingsPrompt,
    acceptSlashPalette,
    completeSlashPalette,
    cancelSlashPalette,
  } = usePromptDraftFlow({
    dismissWelcomePromptHint,
    syncPromptLayoutRows,
    promptHistoryDraftChangeRef,
    promptHistoryNavRef,
    resetPromptHistoryNav,
    setPromptDraft,
    setPromptDraftOverride,
    showPromptHint,
    clearPromptHint,
    promptHintActiveRef,
    promptHintTimerRef,
    slashDismissedFor,
    setSlashDismissedFor,
    providerPrompt,
    settingsPrompt,
    setProviderPrompt,
    setSettingsPrompt,
    oauthSubmitRef,
    openProjectPicker,
    openMemoryCorePicker,
    openAutoClearPicker,
    slashCommands,
    slashIndex,
    pickerOpenedFromEnterRef,
    pickerOpenedFromEnterTimerRef,
    runSlashCommand,
  });

  const resizeEpoch = resizeState.epoch;
  // Agent revision + active-tool signature + statusline stats:
  // app/use-transcript-activity.mjs.
  const { agentRevision, activeTools, statuslineStats } = useTranscriptActivity({ state });

  // Transcript viewport + bottom-cluster row budget: app/shell-layout.mjs.
  const layout = computeShellLayout({
    providerPrompt,
    settingsPrompt,
    panelTransitionEpoch,
    panelInkMaskEpoch,
    toolApproval,
    picker,
    contextPanel,
    usagePanel,
    slashPaletteOpen,
    tuiReady,
    state,
    resizeState,
    frameColumns,
    promptHint,
    promptHintTone,
    textEntryLayoutRows,
    onboardingActive,
    conditionalWelcomePromptHint,
    welcomePromptHintDismissed,
    welcomePromptHintRef,
    welcomePromptHintVisibleRef,
    panelTransitionRef,
    projectBootInputLatchRef,
    promptLayoutValueRef,
    promptContentColumns,
    transcriptBottomSlackRowsRef,
    transcriptViewportRef,
    frameRowsRef,
    promptBoxRectRef,
    panelCloseInkMaskRowsRef,
  });
  const {
    latestTranscriptItem,
    overlayHintRequested,
    floatingPanelRows,
    bottomClusterRows,
    panelLayoutSignature,
    panelTransitionClearRows,
    panelTransitionGuardRows,
    transcriptGuardRows,
    transcriptContentHeight,
  } = layout;
  // Post-commit panel-transition bookkeeping: app/use-panel-transition.mjs.
  usePanelTransition({
    panelTransitionRef,
    panelCloseInkMaskRowsRef,
    panelLayoutSignature,
    bottomClusterRows,
    panelTransitionClearRows,
    panelTransitionGuardRows,
    latestTranscriptItem,
    setPanelInkMaskEpoch,
    setPanelTransitionEpoch,
  });
  // Row-index/window memo chain + measured-height harvest + anchor lock:
  // extracted to app/use-transcript-window.mjs.
  const {
    transcriptWindow,
    renderedTranscriptItems,
    transcriptTailPinned,
    overlayHintAttachItemIndex,
    overlayHintOnLastItem,
    overlayHintFallbackRow,
    transcriptMeasureRef,
  } = useTranscriptWindow({
    items: state.transcriptViewItems || state.items,
    structureRevision: state.transcriptViewItems ? state.transcriptViewRevision : state.structureRevision,
    sessionKey: state.sessionId || '',
    // Historical pages are contiguous settled windows. Keep the independently
    // growing live tail hidden until paging forward reaches the live window.
    streamingTail: state.transcriptViewItems ? null : state.streamingTail,
    themeEpoch: state.themeEpoch,
    frameColumns,
    toolOutputExpanded,
    transcriptContentHeight,
    transcriptGuardRows,
    floatingPanelRows,
    overlayHintRequested,
    scrollOffset,
    setScrollOffset,
    transcriptAnchorRef,
    transcriptAnchorDirtyRef,
    scrollTargetRef,
    scrollPositionRef,
    maxScrollRowsRef,
    transcriptGeomRef,
    followingRef,
    dragRef,
    transcriptViewportRef,
    selectionLayoutRef,
    withSelectionClip,
    paintSelectionRect,
    stopSmoothScroll,
    measuredRowsVersion,
    setMeasuredRowsVersion,
  });
  // Tab cycles the workflow unless another surface owns the bottom area:
  // app/use-workflow-tab-cycle.mjs.
  const cycleWorkflowFromPrompt = useWorkflowTabCycle({
    store,
    state,
    slashPaletteOpen,
    toolApproval,
    picker,
    settingsPrompt,
    providerPrompt,
    contextPanel,
    usagePanel,
  });
  // The hardware/IME caret is parked by PromptInput from its OWN measured box
  // position (ink useCursor + useBoxMetrics) — correct now that the transcript
  // is a live column, so the live-frame line count ink relies on is accurate.
  // Full view tree: app/app-view.jsx.
  return renderAppView({
    ...layout,
    acceptSlashPalette,
    activeSlashQuery,
    activeTools,
    agentRevision,
    cancelProviderPrompt,
    cancelSettingsPrompt,
    cancelSlashPalette,
    clearPromptHint,
    completeSlashPalette,
    contextPanel,
    cycleWorkflowFromPrompt,
    exiting,
    frameColumns,
    gridSelectionActiveRef,
    handlePromptEscape,
    handlePromptHistoryNavigate,
    handlePromptInterrupt,
    handlePromptPaste,
    hasUserMessages,
    initialStatusLine,
    onPromptDraftChange,
    onSubmit,
    overlayHintAttachItemIndex,
    overlayHintFallbackRow,
    overlayHintOnLastItem,
    panelInkMaskEpoch,
    panelTransitionEpoch,
    picker,
    pickerOpenedFromEnterRef,
    pickerOpenedFromEnterTimerRef,
    promptBoxRectRef,
    promptDraft,
    promptDraftOverride,
    promptMouseSelectionRef,
    promptSelectionRef,
    promptValueRef,
    providerPrompt,
    renderedTranscriptItems,
    resizeEpoch,
    resizeState,
    restoreQueuedToPrompt,
    setSlashIndex,
    setTextEntryLayoutRows,
    settingsPrompt,
    slashCommands,
    slashIndex,
    slashPaletteOpen,
    state,
    statuslineStats,
    store,
    surface,
    toolApproval,
    toolOutputExpanded,
    transcriptMeasureRef,
    transcriptTailPinned,
    transcriptWindow,
    tuiReady,
    usagePanel,
  });
}
