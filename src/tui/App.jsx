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
import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import { theme, surfaceBackground } from './theme.mjs';
import { useSession } from './hooks/useSession.mjs';
import { classifyToolCategory } from '../runtime/shared/tool-surface.mjs';
import { localPackageVersion } from '../runtime/shared/update-checker.mjs';
import { Spinner } from './components/Spinner.jsx';
import { StatusLine } from './components/StatusLine.jsx';
import { PromptInput } from './components/PromptInput.jsx';
import { QueuedCommands } from './components/QueuedCommands.jsx';
import { Picker } from './components/Picker.jsx';
import { SlashCommandPalette } from './components/SlashCommandPalette.jsx';
import { ContextPanel } from './components/ContextPanel.jsx';
import { UsagePanel } from './components/UsagePanel.jsx';
import { TextEntryPanel } from './components/TextEntryPanel.jsx';
import {
  buildPromptContentWithImages,
  expandPastedTextTokens,
  imageReferenceIds,
  pastedTextReferenceIds,
  readClipboardImageAttachment,
  readImageAttachmentFromPath,
  shouldFoldPastedText,
  splitPastedImagePathCandidates,
} from './paste-attachments.mjs';
import { formatDuration } from './time-format.mjs';
import { pickFolder } from '../standalone/folder-dialog.mjs';
import {
  formatHookDenialDetail,
  isHookApprovalDenialToolItem,
  shouldSuppressFullyFailedToolItem,
  toolItemResultText,
} from './transcript-tool-failures.mjs';

import { displayModelName } from '../ui/model-display.mjs';
import { supportsExtendedKeys, ENABLE_KITTY_KEYBOARD, ENABLE_MODIFY_OTHER_KEYS } from './keyboard-protocol.mjs';
import {
  SLASH_COMMANDS,
  slashQuery,
  slashCommandMatches,
  compareSlashCommands,
  overlayBlocksGlobalTranscriptScroll,
  normalizeSlashCommandName,
  slashCommandTokenForPaletteAccept,
  slashCommandForName,
  slashArgumentHint,
} from './app/slash-commands.mjs';
import { isCompletedTranscriptTailAppendedThisCommit, isLiveSpinnerMetaVisible } from './app/live-spinner-visibility.mjs';
import {
  parseHookRuleInput,
  parseMcpServerInput,
  parseSkillInput,
  parseMemoryCommand,
  parseMemoryCoreRows,
  memoryCoreResultErrorText,
} from './app/input-parsers.mjs';
import { copyToClipboard } from './app/clipboard.mjs';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './app/panel-epoch.mjs';
import { createPanelSurface } from './app/panel-surface.mjs';
import { wrappedTextRows, promptContentRows, wrappedDetailRows, textEntryReservedRows, queuedBandRows } from './app/text-layout.mjs';
import stringWidth from 'string-width';
import { useMouseInput } from './app/use-mouse-input.mjs';
import { useTranscriptScroll } from './app/use-transcript-scroll.mjs';
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
import {
  TRANSCRIPT_WINDOW_MIN_ITEMS,
  TRANSCRIPT_WINDOW_OVERSCAN_ROWS,
  TRANSCRIPT_WINDOW_MAX_ITEMS,
  TRANSCRIPT_WINDOW_TAIL_OVERSCAN_ROWS,
  SELECTION_PAINT_INTERVAL_MS,
  SCROLL_COALESCE_MS,
  PROMPT_HISTORY_LIMIT,
  TRANSCRIPT_MEASURED_ROWS,
  selectionRectsEqual,
  shiftSelectionRectY,
  compareCellOrder,
  upperBound,
  resolveAnchorScrollOffset,
  transcriptItemVariantKey,
  transcriptMeasuredRowsCache,
  buildTranscriptRowIndex,
  transcriptRenderWindow,
  transcriptSwapReturnsToTail,
} from './app/transcript-window.mjs';
import {
  WEB_SEARCH_DEFAULT_ROUTE,
  isWebSearchDefaultRoute,
  terminalSize,
  clean,
  projectNameFromPath,
  workflowDisplayName,
  workflowSwitchNotice,
  modelSwitchNotice,
  toolApprovalDescription,
  providerStatusLabel,
  providerDetailText,
  providerKindLabel,
  formatSessionUpdatedAt,
  formatSessionMessageCount,
  fitLine,
  centerLine,
  promptStatusColor,
  promptHistoryKey,
} from './app/app-format.mjs';
import {
  parsedModelVersion,
  releaseTime,
  isClaudeModel,
  modelVersion,
  compareModelVersion,
  compareModelRecency,
  modelFamily,
  modelContextWindow,
  formatContextWindow,
  modelFamilyLimit,
  normalizeModelOptions,
  providerDisplayName,
  providerDisplayRank,
  titleCaseOption,
  effortDisplayLabel,
  fastDisplayLabel,
  modelDescription,
  modelRecordDisplayName,
  routeModelDisplayName,
  groupModelsByProvider,
  buildModelProviderItems,
  buildProviderModelItems,
  routeLabel,
  routeModelLabel,
  agentModelProfile,
  agentModelParts,
  routeFromModel,
  modelScore,
  chooseRecommendedModel,
  buildWorkflowDefaults,
} from './app/model-options.mjs';
import { createProjectPicker } from './app/project-picker.mjs';
import { createThemeEffortPickers, themeNotice } from './app/theme-effort-pickers.mjs';
import { createResumePicker } from './app/resume-picker.mjs';
import { createCoreMemoryPicker } from './app/core-memory-picker.mjs';
import { createExtensionPickers } from './app/extension-pickers.mjs';
import { createMaintenancePickers } from './app/maintenance-pickers.mjs';
import { createOnboardingSteps } from './app/onboarding-steps.mjs';
import { createModelPicker } from './app/model-picker.mjs';
import { createProviderSetupPicker } from './app/provider-setup-picker.mjs';
import { createRoutePickers, outputStyleNotice } from './app/route-pickers.mjs';
import { createSettingsPicker } from './app/settings-picker.mjs';
import { createSlashDispatch } from './app/slash-dispatch.mjs';
import { usePromptHandlers } from './app/use-prompt-handlers.mjs';
import { Item } from './components/TranscriptItem.jsx';

// Pure formatting helpers: extracted to app/app-format.mjs

// Model/route label + ordering + picker-item helpers: extracted to app/model-options.mjs

// ToolHookDenialCard + Item: extracted to components/TranscriptItem.jsx

const PANEL_LAYOUT_SIG = {
  PICKER: 1,
  SLASH: 4,
  TEXT: 5,
  // Prompt-wrap/meta row counts (trailing churn tokens, see token order note
  // below). PROMPT_META is the 2-row live-spinner band slot.
  PROMPT_META: 9,
  // Queued steering band rows (full wrapped height, see queuedBandRows).
  QUEUED: 10,
};
const PROJECT_TEXT_ENTRY_KINDS = new Set(['project-new', 'project-create-confirm', 'project-rename']);
const CORE_MULTILINE_TEXT_ENTRY_KINDS = new Set(['core-add', 'core-edit']);

function panelSignatureFlags(signature) {
  if (!signature) return { slash: false, pickerKind: '', textKind: '' };
  const parts = String(signature).split('|');
  const pickerToken = parts[PANEL_LAYOUT_SIG.PICKER] || '';
  const textToken = parts[PANEL_LAYOUT_SIG.TEXT] || '';
  return {
    slash: parts[PANEL_LAYOUT_SIG.SLASH] === 'slash',
    pickerKind: pickerToken.startsWith('picker:')
      ? pickerToken.slice('picker:'.length).split(':')[0]
      : '',
    textKind: textToken.startsWith('text:') ? textToken.slice('text:'.length) : '',
  };
}

// panelLayoutSignature token order: [tool, picker, context, usage, slash, text,
// inputBoxHidden, floatingPanelRows, promptBoxRows, promptMetaRows, queuedRows,
// WELCOME_ROWS]. The first 8 tokens identify which panel (if any) owns the
// bottom area; the trailing 3 are prompt-wrap/queue row counts that can churn
// every keystroke without any panel opening/closing/changing kind. Comparing
// only this prefix lets the transition logic tell "prompt textarea grew/shrank
// a wrapped row" apart from "a panel actually opened or closed".
const PANEL_KIND_TOKEN_COUNT = 8;
function panelKindSignature(signature) {
  if (!signature) return '';
  return String(signature).split('|').slice(0, PANEL_KIND_TOKEN_COUNT).join('|');
}

function isInstantPanelCloseTransition(prevSignature, nextSignature, initialProjectEntryClose) {
  const prev = panelSignatureFlags(prevSignature);
  const next = panelSignatureFlags(nextSignature);
  if (prev.slash && !next.slash) return true;
  if (prev.pickerKind === 'project' && next.pickerKind !== 'project') return initialProjectEntryClose;
  if (PROJECT_TEXT_ENTRY_KINDS.has(prev.textKind) && !PROJECT_TEXT_ENTRY_KINDS.has(next.textKind)) {
    return initialProjectEntryClose;
  }
  return false;
}

// First-run gate. The daemon-backed engine store answers any method it does
// not implement locally with an async remote call, so a synchronous
// getOnboardingStatus() probe can hand back a Promise instead of the status
// object — which read as "not completed" and re-opened a dismissed wizard on
// every launch. runTui resolves the status before mount and passes the verdict
// in; only a local store (tests, direct mounts) falls back to the sync probe,
// and anything unresolvable counts as completed.
function resolveOnboardingCompleted(store, onboardingCompleted) {
  if (typeof onboardingCompleted === 'boolean') return onboardingCompleted;
  try {
    const status = store.getOnboardingStatus?.();
    if (!status || typeof status !== 'object' || typeof status.then === 'function') return true;
    return status.completed === true;
  } catch {
    return true;
  }
}

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
  const { isRawModeSupported, stdin, internal_eventEmitter: inkInput } = useStdin();
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
  // scrollOffset = how many transcript ROWS we've scrolled UP from the bottom
  // (0 = pinned to the latest, showing the newest content). Mouse wheel adjusts
  // it; accepted prompts only arm bottom-follow; the snap happens when the
  // transcript actually grows.
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollPositionRef = useRef(0);
  const scrollTargetRef = useRef(0);
  const maxScrollRowsRef = useRef(0);
  const transcriptBottomSlackRowsRef = useRef(0);
  // Absolute reading-anchor lock. While the user reads older transcript, we
  // capture the item id + row offset at the VIEWPORT TOP edge once, then re-
  // derive scrollOffset from that anchor on every commit. Streaming tail growth
  // (or any height change BELOW the anchor) only moves the bottom, so the top
  // item stays pinned — no incremental drift, no jump on newline. `dirty` forces
  // a re-capture after a manual scroll; cleared to null when we follow/pin the
  // bottom so a fresh scroll-up starts a new anchor.
  const transcriptAnchorRef = useRef(null);
  const transcriptAnchorDirtyRef = useRef(false);
  // Latest render's prefix-row table + dimensions, so a manual scroll can
  // capture the reading anchor SYNCHRONOUSLY (in the wheel/key callback) instead
  // of waiting for the post-commit effect — otherwise each scroll notch leaves
  // the anchor "dirty" for one frame, and if streaming grows the transcript on
  // that same frame the lock is not engaged yet and the view lurches.
  const transcriptGeomRef = useRef({ prefixRows: null, totalRows: 0, viewRows: 1 });
  // Bumped by the measured-height harvest (useTranscriptWindow) and the mouse
  // drag-release re-measure (useMouseInput) so the row-index memo recomputes
  // against corrected heights. Owned here because both hooks consume it.
  const [measuredRowsVersion, setMeasuredRowsVersion] = useState(0);
  // Auto-follow is separate from manual scroll. While true, new transcript rows
  // (new items or streaming text wrapping to another line) are folded into the
  // same glide back to the bottom.
  const followingRef = useRef(false);
  const lastItemsCountRef = useRef(0);
  // Head item of the last committed transcript: a bulk swap (session load /
  // clear / compaction trim) changes it, a live append never does.
  const lastFirstItemIdRef = useRef(null);
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
  const buildProjectPickerState = (opts) => projectPickerRef.current.buildProjectPickerState(opts);
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
    setPickerState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      if (resolved && typeof resolved === 'object' && pickerOpenedFromEnterRef.current) {
        pickerOpenedFromEnterRef.current = false;
        if (pickerOpenedFromEnterTimerRef.current) {
          clearTimeout(pickerOpenedFromEnterTimerRef.current);
          pickerOpenedFromEnterTimerRef.current = null;
        }
        return resolved.indexMode ? resolved : { ...resolved, indexMode: 'always' };
      }
      // Same-kind reopen (toggle-driven rebuilds like the MCP ←/→ flip):
      // carry the previous picker's indexMode so an 'always' injected at
      // Enter-open time survives the rebuild instead of falling back to
      // 'auto' and hiding the row indexes.
      if (
        resolved && typeof resolved === 'object' && !resolved.indexMode
        && prev && typeof prev === 'object' && prev.indexMode
        && prev._kind && prev._kind === resolved._kind
      ) {
        return { ...resolved, indexMode: prev.indexMode };
      }
      return resolved;
    });
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
  // hooks, plugins, skills, channel provider). ←/→ cycle/toggle handlers in
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
  const {
    beginNewProject,
    registerProject,
    enterProject,
    beginRenameProject,
    openProjectPicker,
  } = projectPicker;
  // getDisabledSkills is a remote call on a daemon-backed store, so it cannot
  // seed useState synchronously (the initializer used to capture a promise and
  // every skill looked enabled). Start empty and adopt the real set on mount.
  const [disabledSkills, setDisabledSkillsInner] = useState(() => new Set());
  useEffect(() => {
    let alive = true;
    void Promise.resolve(store.getDisabledSkills?.())
      .then((result) => {
        if (!alive) return;
        const disabled = Array.isArray(result?.disabled) ? result.disabled : [];
        if (disabled.length) setDisabledSkillsInner(new Set(disabled));
      })
      .catch(() => { /* skills stay enabled when the probe fails */ });
    return () => { alive = false; };
  }, [store]);
  const setDisabledSkills = useCallback((next) => {
    setDisabledSkillsInner((current) => {
      const base = current instanceof Set ? current : new Set(current);
      const set = typeof next === 'function' ? next(base) : (next instanceof Set ? next : new Set(next));
      try {
        store.setDisabledSkills?.([...set]);
      } catch (e) {
        store.pushNotice(`skill disable persist failed: ${e?.message || e}`, 'error');
      }
      return set;
    });
  }, [store]);
  const toolApproval = state.toolApproval || null;
  const [promptDraft, setPromptDraft] = useState('');
  const [promptDraftOverride, setPromptDraftOverride] = useState(null);
  const promptLayoutValueRef = useRef('');
  const [, setPromptLayoutRows] = useState(1);
  const [textEntryLayoutRows, setTextEntryLayoutRows] = useState(1);
  // Pasted image/text buffers + their [ref-token] lifecycle:
  // app/use-pasted-buffers.mjs.
  const {
    pastedImagesRef,
    nextPastedImageIdRef,
    pastedTextsRef,
    nextPastedTextIdRef,
    setPastedImages,
    setPastedTexts,
    installPastedImages,
    clearPastedImagesSnapshot,
    registerPastedImage,
    installPastedTexts,
    clearPastedTextsSnapshot,
    registerPastedText,
  } = usePastedBuffers();
  const promptValueRef = useRef('');
  const promptSelectionRef = useRef(null);
  // [mixdog] Prompt-box mouse selection wiring. boxRect is the editable text
  // node's REAL absolute rect (top/left/height/contentWidth), reported by
  // PromptInput each render; mouseSelection exposes offsetAtCell/anchorAt/
  // extendTo/clear so the single mouse handler can drive the prompt's OWN
  // selectionAnchor engine without the ink-grid rect path.
  const promptBoxRectRef = useRef(null);
  const promptMouseSelectionRef = useRef(null);
  const promptHistoryNavRef = useRef({ active: false, index: -1, seed: '', lastValue: '' });
  const promptHistoryDraftChangeRef = useRef(false);
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
  const toastErrorSignature = useMemo(() => (
    (state.toasts || [])
      .filter((toast) => toast?.tone === 'error')
      .map((toast) => `${toast.id || ''}:${toast.text || ''}`)
      .join('|')
  ), [state.toasts]);
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
  // Holding Tab can generate key-repeat faster than a workflow switch can
  // settle. Without a prompt-local guard every repeat starts (or rejects) an
  // async switch and pushes a toast, producing a rapid bottom-layout repaint
  // storm that can visually tear the prompt box in Windows Terminal.
  const workflowTabCycleRef = useRef({ pending: false, lastAt: 0 });
  const scrollFocusRef = useRef({});
  const onboardingStartedRef = useRef(false);
  const onboardingRef = useRef({ defaultRoute: null, webSearchRoute: null, agentRoutes: {}, agents: [], providerModels: [] });
  const providerModelsCacheRef = useRef({ models: null, at: 0 });
  const webSearchModelsCacheRef = useRef({ models: null, at: 0 });
  const modelPickerRequestRef = useRef(0);
  // Generation guard for the Step 1 background prefetch: bumped on every
  // provider-scope cache clear (e.g. after auth) so a stale in-flight
  // listProviderModels() cannot repopulate the ref after invalidation.
  const onboardingPrefetchSeqRef = useRef(0);
  const clearModelCaches = useCallback((scope = 'all') => {
    if (scope === 'all' || scope === 'provider') {
      providerModelsCacheRef.current = { models: null, at: 0 };
      onboardingRef.current.providerModels = [];
      onboardingPrefetchSeqRef.current += 1;
    }
    if (scope === 'all' || scope === 'webSearch') {
      webSearchModelsCacheRef.current = { models: null, at: 0 };
    }
  }, []);
  // Boot-time catalog prefetch: warm the /model & /agents provider catalog and
  // the /websearch catalog once at startup so those pickers open instantly from
  // cache (openModelPicker still TTL-refreshes stale rows in the background).
  // Provider models load first so the web-search catalog derives from the full
  // runtime cache instead of the sparse quick rows. Guarded by the same
  // generation seq as the onboarding prefetch so an auth-triggered
  // clearModelCaches() can't be clobbered by a stale in-flight result.
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      const seq = onboardingPrefetchSeqRef.current;
      try {
        const models = await Promise.resolve(store.listProviderModels?.() || []);
        if (alive && seq === onboardingPrefetchSeqRef.current
          && Array.isArray(models) && models.length > 0
          && !Array.isArray(providerModelsCacheRef.current.models)) {
          providerModelsCacheRef.current = { models, at: Date.now() };
        }
      } catch { /* prefetch is advisory; pickers fall back to their own load */ }
      if (!alive) return;
      try {
        const webSearchModels = await Promise.resolve(store.listWebSearchModels?.() || []);
        if (alive && Array.isArray(webSearchModels) && webSearchModels.length > 0
          && !Array.isArray(webSearchModelsCacheRef.current.models)) {
          webSearchModelsCacheRef.current = { models: webSearchModels, at: Date.now() };
        }
      } catch { /* prefetch is advisory; /websearch falls back to its own load */ }
    }, 1500);
    timer.unref?.();
    return () => { alive = false; clearTimeout(timer); };
  }, [store]);
  // Picker/panel factories + slash dispatch: app/create-app-pickers.mjs.
  const {
    openThemePicker,
    openEffortPicker,
    openResumePicker,
    openMemoryCorePicker,
    openMcpServersPicker,
    openMcpPicker,
    openProjectSkillsPicker,
    openSkillsPicker,
    openSkillDetailPicker,
    beginAddPlugin,
    openPluginDetailPicker,
    openInstalledPluginsPicker,
    openPluginsPicker,
    openHooksPicker,
    openUpdatePicker,
    openAutoClearPicker,
    openProfilePicker,
    onboardingWarnReopen,
    openOnboardingAuthStep,
    openProviderSetupPicker,
    openModelPicker,
    openWebSearchPicker,
    openAgentsPicker,
    openWorkflowPicker,
    openOutputStylePicker,
    openSettingsPicker,
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
  // dragRef tracks an in-progress mouse text selection (see the mouse handler):
  // anchor = where the drag began, last = the latest cell, active = button held.
  // region: which surface the in-progress (or last) selection belongs to —
  // 'transcript' | 'status' (both ink-grid) | 'prompt' (PromptInput's own engine)
  // | null. Press decides it; motion/release stay in that region.
  // anchorSpan: for word/line multi-click selections, the initial word/line
  // bounds ({ lo:{x,y}, hi:{x,y}, kind:'word'|'line' }) so a subsequent drag
  // extends the selection whole-word/whole-line from that span. Null ⇔ an
  // ordinary char-drag selection.
  const dragRef = useRef({ anchor: null, anchorScroll: 0, last: null, active: false, rect: null, region: null, anchorSpan: null });
  const transcriptViewportRef = useRef({ top: 0, bottom: 0 });
  const panelTransitionRef = useRef({ signature: '', reserve: 0, clearRows: 0, guardRows: 0, epoch: 0 });
  const panelCloseInkMaskRowsRef = useRef(0);
  const projectBootInputLatchRef = useRef(false);
  // [mixdog] Latest terminal row count + the statusline band (bottom rows),
  // refreshed each render. The mouse handler uses these to (a) clip a status-bar
  // grid selection to the statusline rows and (b) route a press to the right
  // region. STATUSLINE_ROWS mirrors the layout reserve below.
  const frameRowsRef = useRef(24);
  const STATUSLINE_BAND_ROWS = 3;
  const promptContentColumns = Math.max(1, frameColumns - 4);
  const syncPromptLayoutRows = useCallback((value) => {
    const text = String(value ?? '');
    promptLayoutValueRef.current = text;
    const nextRows = promptContentRows(text, promptContentColumns);
    setPromptLayoutRows((prev) => (prev === nextRows ? prev : nextRows));
  }, [promptContentColumns]);
  useEffect(() => {
    syncPromptLayoutRows(promptLayoutValueRef.current);
  }, [syncPromptLayoutRows]);
  useEffect(() => {
    const kind = String(settingsPrompt?.kind || '');
    if (!CORE_MULTILINE_TEXT_ENTRY_KINDS.has(kind)) {
      setTextEntryLayoutRows(1);
      return;
    }
    const cols = Math.max(1, frameColumns - 4 - stringWidth('Sentence > '));
    setTextEntryLayoutRows(textEntryReservedRows(settingsPrompt?.initialValue, cols, 8));
  }, [settingsPrompt?.kind, settingsPrompt?.initialValue, frameColumns]);
  const selectionLayoutRef = useRef(null);
  const selectionTextRef = useRef('');
  // lastClickRef tracks the previous left-press cell + time so the mouse handler
  // can detect a double-click (same cell within 500ms) for word selection.
  // count = consecutive qualifying presses on the same cell (1=single,
  // 2=double/word, 3=triple/line). A 4th qualifying press restarts the
  // sequence at 1 (simplest reset: no ratcheting/back-off). Any non-qualifying
  // press resets to a fresh single.
  const lastClickRef = useRef({ x: -1, y: -1, t: 0, count: 0 });

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

  useEffect(() => () => {
    stopSmoothScroll();
  }, [stopSmoothScroll]);

  // SGR mouse handling: extracted to app/use-mouse-input.mjs (useMouseInput).
  useMouseInput({
    inkInput,
    isRawModeSupported,
    store,
    stdout,
    rows: resizeState.rows,
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
    scrollTranscriptRows,
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
      return;
    }
    if (count === previousCount || dragRef.current.active) return;
  }, [state.items, resetTranscriptScroll]);

  // Exit + queued-restore + prompt history: app/use-prompt-queue-history.mjs.
  const {
    requestExit,
    restoreQueuedToPrompt,
    recentPromptHistory,
    resetPromptHistoryNav,
  } = usePromptQueueHistory({
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
  const {
    handlePromptPaste,
    handlePromptHistoryNavigate,
    handlePromptEscape,
    handlePromptInterrupt,
  } = usePromptHandlers({
    store,
    state,
    promptValueRef,
    pastedImagesRef,
    nextPastedImageIdRef,
    pastedTextsRef,
    nextPastedTextIdRef,
    promptHistoryNavRef,
    promptHistoryDraftChangeRef,
    setPastedImages,
    setPastedTexts,
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
    state,
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
    if (contextPanel?.kind === 'context') {
      openContextPicker();
      return;
    }
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


  useEffect(() => {
    if (onboardingStartedRef.current) return undefined;
    if (resolveOnboardingCompleted(store, onboardingCompleted) && !forceOnboarding) return undefined;
    let canceled = false;
    onboardingStartedRef.current = true;
    setOnboardingActive(true);
    setTimeout(() => {
      if (!canceled) openOnboardingAuthStep();
    }, 0);
    return () => {
      canceled = true;
    };
  }, [store, forceOnboarding, onboardingCompleted]);

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

  const activeSlashQuery = providerPrompt || settingsPrompt || toolApproval || contextPanel || usagePanel ? null : slashQuery(promptDraft);
  // "Slash mode" is live whenever a /token is being edited and no other
  // surface owns the floating area. The palette stays OPEN for the whole
  // slash session — including 0-match frames — so its 14-row layout never
  // unmounts/remounts per keystroke (fullscreen repaint flicker fix).
  const slashModeLive = activeSlashQuery !== null
    && !picker && !toolApproval && !contextPanel && !usagePanel && !exiting && !state.commandBusy;
  const slashCommands = !slashModeLive
    ? []
    : SLASH_COMMANDS
      .filter((command) => slashCommandMatches(command, activeSlashQuery))
      .sort(compareSlashCommands);
  const slashPaletteOpen = slashModeLive && slashDismissedFor !== promptDraft;
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
  const { agentRevision, activeToolsSignature, activeTools, statuslineStats } = useTranscriptActivity({ state });

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
    CORE_MULTILINE_TEXT_ENTRY_KINDS,
    panelSignatureFlags,
    panelKindSignature,
    isInstantPanelCloseTransition,
    PANEL_LAYOUT_SIG,
  });
  const {
    inputBoxHidden,
    latestTranscriptItem,
    promptBoxRows,
    STATUSLINE_ROWS,
    promptMetaRows,
    overlayHintRequested,
    queuedRows,
    WELCOME_ROWS,
    floatingPanelRows,
    bottomClusterRows,
    panelLayoutSignature,
    panelTransitionClearRows,
    panelTransitionGuardRows,
    transcriptGuardRows,
    transcriptContentHeight,
    transcriptBottomSlackRows,
  } = layout;
  useEffect(() => {
    const transition = panelTransitionRef.current;
    const pendingInkMask = panelCloseInkMaskRowsRef.current;
    const hadTransitionClearance = panelTransitionClearRows > 0 || panelTransitionGuardRows > 0;
    transition.signature = panelLayoutSignature;
    transition.reserve = bottomClusterRows;
    transition.clearRows = 0;
    transition.guardRows = 0;
    if (pendingInkMask > 0) {
      panelCloseInkMaskRowsRef.current = 0;
      setPanelInkMaskEpoch((epoch) => epoch + 1);
      return undefined;
    }
    if (!hadTransitionClearance) return undefined;
    const timer = setTimeout(() => setPanelTransitionEpoch((epoch) => epoch + 1), 0);
    return () => clearTimeout(timer);
  }, [panelLayoutSignature, bottomClusterRows, panelTransitionClearRows, panelTransitionGuardRows]);
  // Record the transcript tail id AFTER every commit so the next render's
  // spinner-meta-collapse gate (doneTailAppendedThisCommit) can tell a freshly
  // appended done row from a stale one that was already at the tail.
  useEffect(() => {
    panelTransitionRef.current.tailId = latestTranscriptItem?.id ?? null;
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
    structureRevision: state.transcriptViewItems
      ? state.transcriptViewRevision
      : state.structureRevision,
    sessionKey: state.sessionId || '',
    // Historical pages are contiguous settled windows. Keep the independently
    // growing live tail hidden until paging forward reaches the live window.
    streamingTail: state.transcriptViewItems ? null : state.streamingTail,
    themeEpoch: state.themeEpoch,
    frameColumns,
    toolOutputExpanded,
    transcriptContentHeight,
    transcriptBottomSlackRows,
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
  const cycleWorkflowFromPrompt = useCallback(() => {
    if (slashPaletteOpen || toolApproval || picker || settingsPrompt || providerPrompt || contextPanel || usagePanel) return true;
    const repeatGuardMs = 300;
    const cycleGuard = workflowTabCycleRef.current;
    const now = Date.now();
    if (state.commandBusy || cycleGuard.pending || now - cycleGuard.lastAt < repeatGuardMs) {
      cycleGuard.lastAt = now;
      return true;
    }
    cycleGuard.lastAt = now;
    cycleGuard.pending = true;
    // listWorkflows is a remote call on a daemon-backed store, so the whole
    // cycle runs off its resolution; the handler still answers `true` at once
    // so the key stays consumed.
    void Promise.resolve(store.listWorkflows?.())
      .then((list) => {
        const workflows = Array.isArray(list) ? list : [];
        if (!workflows.length) {
          store.pushNotice('no workflows available', 'warn');
          return null;
        }
        const workflow = state.workflow || {};
        if (workflows.length < 2) {
          store.pushNotice(`Workflow: ${workflowDisplayName(workflows[0] || workflow)}`, 'info');
          return null;
        }
        const activeIndex = workflows.findIndex((item) => item.active);
        const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(0, workflows.findIndex((item) => item.id === workflow.id));
        const next = workflows[(currentIndex + 1 + workflows.length) % workflows.length];
        return store.setWorkflow?.(next.id);
      })
      .then((result) => {
        if (!result) {
          return;
        }
        store.pushNotice(workflowSwitchNotice(result), 'info', { ttlMs: 1200 });
      })
      .catch((e) => store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error'))
      .finally(() => {
        cycleGuard.pending = false;
        cycleGuard.lastAt = Date.now();
      });
    return true;
  }, [slashPaletteOpen, toolApproval, picker, settingsPrompt, providerPrompt, contextPanel, usagePanel, state.commandBusy, state.workflow, store]);
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
