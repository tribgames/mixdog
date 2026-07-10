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
 * State comes from the engine store via useEngine; submitting a line calls
 * store.submit() (or handles a slash command locally). The whole tree is live
 * (no <Static>): full-width bands and the native hardware caret both need real
 * layout, which <Static> collapses. The terminal handles scrollback itself as
 * the transcript column grows past the screen height.
 */
import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import { theme, surfaceBackground } from './theme.mjs';
import { useEngine } from './hooks/useEngine.mjs';
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
  formatImageRef,
  imageReferenceIds,
  readClipboardImageAttachment,
  readImageAttachmentFromPath,
  splitPastedImagePathCandidates,
} from './paste-attachments.mjs';
import {
  expandPastedTextTokens,
  formatPastedTextRef,
  pastedTextReferenceIds,
  shouldFoldPastedText,
} from './paste-attachments.mjs';
import { formatDuration } from './time-format.mjs';
import {
  listProjects,
  addProject,
  touchProjectSelected,
  renameProject,
  isDirectory,
  pathExists,
  ensureDir,
  resolveProjectPath,
} from '../standalone/projects.mjs';
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
import {
  parseHookRuleInput,
  parseMcpServerInput,
  parseSkillInput,
  parseMemoryCommand,
  parseMemoryCoreRows,
  memoryCoreResultErrorText,
} from './app/input-parsers.mjs';
import { copyToClipboard } from './app/clipboard.mjs';
import { wrappedTextRows, promptContentRows, wrappedDetailRows, textEntryReservedRows, queuedBandRows } from './app/text-layout.mjs';
import stringWidth from 'string-width';
import { useMouseInput } from './app/use-mouse-input.mjs';
import { useTranscriptScroll } from './app/use-transcript-scroll.mjs';
import { useTranscriptWindow } from './app/use-transcript-window.mjs';
import {
  TRANSCRIPT_WINDOW_MIN_ITEMS,
  TRANSCRIPT_WINDOW_OVERSCAN_ROWS,
  TRANSCRIPT_WINDOW_MAX_ITEMS,
  SELECTION_PAINT_INTERVAL_MS,
  SCROLL_COALESCE_MS,
  PROMPT_HISTORY_LIMIT,
  TRANSCRIPT_MEASURED_ROWS,
  selectionRectsEqual,
  shiftSelectionRectY,
  comparePoints,
  upperBound,
  resolveAnchorScrollOffset,
  transcriptItemVariantKey,
  transcriptMeasuredRowsCache,
  buildTranscriptRowIndex,
  transcriptRenderWindow,
} from './app/transcript-window.mjs';
import {
  SEARCH_DEFAULT_ROUTE,
  isSearchDefaultRoute,
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
  CONDITIONAL_WELCOME_PROMPT_HINTS,
  randomWelcomePromptHint,
  providerSetupHasUsableProvider,
  activeWorkflowSummaryForStore,
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
import { createChannelPickers } from './app/channel-pickers.mjs';
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

export function App({ store, initialStatusLine = '', forceOnboarding = false }) {
  const state = useEngine(store);
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
  // Windows Terminal/conhost scrolls the alt-screen (auto-wrap/DECAWM) when the
  // bottom-right cell is written. WT_SESSION is also set when the UI runs under
  // a Unix-ish shell hosted by Windows Terminal, where process.platform is not
  // necessarily win32 but the terminal behavior is still Windows-like.
  const windowsLikeTerminal = process.platform === 'win32' || Boolean(process.env.WT_SESSION);
  const rightSafetyColumns = windowsLikeTerminal ? 1 : 0;
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
    livePickerRef.current = typeof next === 'function' ? next(livePickerRef.current) : next;
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
  const usageRequestRef = useRef(0);
  // Cache of the last computed heavy settings-picker status objects (MCP,
  // hooks, plugins, skills, channel backend). ←/→ cycle/toggle handlers in
  // openSettingsPicker() pass { light: true } to reuse this cache instead of
  // re-querying these heavy getters on every keystroke; only a full open
  // (initial /config or Esc-return) recomputes them.
  const settingsHeavyCacheRef = useRef(null);
  const closeUsagePanel = useCallback(() => {
    usageRequestRef.current += 1;
    setUsagePanel(null);
  }, []);
  const [providerPrompt, setProviderPrompt] = useState(null);
  const oauthSubmitRef = useRef(false);
  const [channelPrompt, setChannelPrompt] = useState(null);
  const [hookPrompt, setHookPrompt] = useState(null);
  const [settingsPrompt, setSettingsPrompt] = useState(null);
  // Instantiate the project-picker cluster now that setPicker + every prompt
  // setter and the usage-panel closer exist. projectPickerRef (declared above,
  // before the picker useState) is populated here so first-mount build and all
  // later callers resolve the same set of builders.
  const projectPicker = createProjectPicker({
    state,
    store,
    setPicker,
    setProviderPrompt,
    setChannelPrompt,
    setHookPrompt,
    setSettingsPrompt,
    setContextPanel,
    closeUsagePanel,
    listProjects,
    addProject,
    touchProjectSelected,
    resolveProjectPath,
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
    let onboardingOwnsScreen = false;
    try {
      const status = store.getOnboardingStatus?.();
      onboardingOwnsScreen = status?.completed !== true || forceOnboarding;
    } catch { /* status probe failed → fall through to the project picker */ }
    if (!onboardingOwnsScreen && state.items.length === 0) {
      setPicker(projectPicker.buildProjectPickerState({ initialEntry: true }));
    }
  }
  const {
    beginNewProject,
    registerProject,
    enterProject,
    beginRenameProject,
    openProjectPicker,
  } = projectPicker;
  // Theme/effort picker cluster — same dep set as the project picker; the
  // destructured openers are used inside handlers defined later in the body.
  const { openThemePicker, openEffortPicker } = createThemeEffortPickers({
    state,
    store,
    setPicker,
    setProviderPrompt,
    setChannelPrompt,
    setHookPrompt,
    setSettingsPrompt,
    setContextPanel,
    closeUsagePanel,
    clean,
  });
  // Resume picker — independent (store + setPicker + two session formatters).
  const { openResumePicker } = createResumePicker({
    store,
    setPicker,
    formatSessionUpdatedAt,
    formatSessionMessageCount,
  });
  // Core-memory picker cluster. The Esc-return target is passed per entry
  // point ({ returnTo }): Settings threads openSettingsPicker, standalone
  // /memory passes null so Esc closes instead of surfacing Settings.
  // Only openMemoryCorePicker is called from the App body; the entry-action /
  // add / edit / delete openers are internal to the factory (reached through
  // the picker's own onSelect closures), so they stay unbound here.
  const { openMemoryCorePicker } = createCoreMemoryPicker({
    store,
    setPicker,
    setSettingsPrompt,
    parseMemoryCoreRows,
  });
  const [disabledSkills, setDisabledSkillsInner] = useState(() => {
    try {
      const { disabled = [] } = store.getDisabledSkills?.() || {};
      return new Set(disabled);
    } catch {
      return new Set();
    }
  });
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
  const {
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
  } = createExtensionPickers({
    store,
    theme,
    clean,
    copyToClipboard,
    setPicker,
    getPicker: () => livePickerRef.current,
    setProviderPrompt,
    setChannelPrompt,
    setHookPrompt,
    setSettingsPrompt,
    getDisabledSkills: () => disabledSkills,
    setDisabledSkills,
  });
  const {
    openUpdatePicker,
    openAutoClearPicker,
    openProfilePicker,
  } = createMaintenancePickers({
    store,
    theme,
    formatDuration,
    setPicker,
    setProviderPrompt,
    setChannelPrompt,
    setHookPrompt,
    setSettingsPrompt,
    setContextPanel,
    closeUsagePanel,
  });
  const toolApproval = state.toolApproval || null;
  const [promptDraft, setPromptDraft] = useState('');
  const [promptDraftOverride, setPromptDraftOverride] = useState(null);
  const promptLayoutValueRef = useRef('');
  const [, setPromptLayoutRows] = useState(1);
  const [textEntryLayoutRows, setTextEntryLayoutRows] = useState(1);
  const [, setPastedImages] = useState({});
  const pastedImagesRef = useRef({});
  const nextPastedImageIdRef = useRef(1);
  // Large pasted texts folded into [Pasted text #N +M lines] tokens; mirrors
  // pastedImagesRef. Original text is expanded back on submit.
  const [, setPastedTexts] = useState({});
  const pastedTextsRef = useRef({});
  const nextPastedTextIdRef = useRef(1);
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
  const [promptHint, setPromptHint] = useState('');
  const [promptHintTone, setPromptHintTone] = useState('info');
  const [welcomePromptHintDismissed, setWelcomePromptHintDismissed] = useState(false);
  const [conditionalWelcomePromptHint, setConditionalWelcomePromptHint] = useState('');
  const welcomePromptHintRef = useRef(null);
  if (welcomePromptHintRef.current === null) {
    welcomePromptHintRef.current = randomWelcomePromptHint();
  }
  // Tracks whether the welcome hint row is ACTUALLY on screen this frame.
  // Dismissal must only fire while the user can see the hint, and ONLY when
  // the prompt draft gains its first character (see onPromptDraftChange).
  // Generic key/mouse events (arrows, wheel, terminal escape replies) used to
  // dismiss it instantly, so the hint vanished before the user ever typed.
  const welcomePromptHintVisibleRef = useRef(false);
  const dismissWelcomePromptHint = useCallback(() => {
    if (!welcomePromptHintVisibleRef.current) return;
    setWelcomePromptHintDismissed((dismissed) => dismissed || true);
  }, []);
  const toastErrorSignature = useMemo(() => (
    (state.toasts || [])
      .filter((toast) => toast?.tone === 'error')
      .map((toast) => `${toast.id || ''}:${toast.text || ''}`)
      .join('|')
  ), [state.toasts]);
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
  const onboardingRef = useRef({ defaultRoute: null, searchRoute: null, agentRoutes: {}, agents: [], providerModels: [] });
  const providerModelsCacheRef = useRef({ models: null, at: 0 });
  const searchModelsCacheRef = useRef({ models: null, at: 0 });
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
    if (scope === 'all' || scope === 'search') {
      searchModelsCacheRef.current = { models: null, at: 0 };
    }
  }, []);
  // Boot-time catalog prefetch: warm the /model & /agents provider catalog and
  // the /search catalog once at startup so those pickers open instantly from
  // cache (openModelPicker still TTL-refreshes stale rows in the background).
  // Provider models load first so the search catalog derives from the full
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
        const searchModels = await Promise.resolve(store.listSearchModels?.() || []);
        if (alive && Array.isArray(searchModels) && searchModels.length > 0
          && !Array.isArray(searchModelsCacheRef.current.models)) {
          searchModelsCacheRef.current = { models: searchModels, at: Date.now() };
        }
      } catch { /* prefetch is advisory; /search falls back to its own load */ }
    }, 1500);
    timer.unref?.();
    return () => { alive = false; clearTimeout(timer); };
  }, [store]);
  // Onboarding wizard + channel setup picker factories. Instantiated here —
  // after the onboarding refs above (const-TDZ) — with later-defined openers
  // (openProviderSetupPicker/openOutputStylePicker) threaded as lazy getters
  // that resolve the live binding at call time.
  const { onboardingWarnReopen, openOnboardingAuthStep } = createOnboardingSteps({
    store,
    setPicker,
    setProviderPrompt,
    setChannelPrompt,
    setHookPrompt,
    setSettingsPrompt,
    setOnboardingActive,
    onboardingRef,
    providerModelsCacheRef,
    onboardingPrefetchSeqRef,
    openProviderSetupPicker: (...a) => openProviderSetupPicker(...a),
    openThemePicker,
    openOutputStylePicker: (...a) => openOutputStylePicker(...a),
  });
  const {
    openChannelTypeActionsPicker,
    openChannelSettingTypePicker,
    openChannelSetupPicker,
  } = createChannelPickers({
    store,
    setPicker,
    setProviderPrompt,
    setChannelPrompt,
    setHookPrompt,
    setSettingsPrompt,
    setContextPanel,
    onboardingWarnReopen,
  });
  const { openProviderSetupPicker } = createProviderSetupPicker({
    store,
    setPicker,
    setProviderPrompt,
    setChannelPrompt,
    setHookPrompt,
    setSettingsPrompt,
    setContextPanel,
    closeUsagePanel,
    oauthSubmitRef,
    clearModelCaches,
  });
  const { openModelPicker } = createModelPicker({
    store,
    getState: () => state,
    setPicker,
    setProviderPrompt,
    setChannelPrompt,
    setHookPrompt,
    setSettingsPrompt,
    providerModelsCacheRef,
    searchModelsCacheRef,
    modelPickerRequestRef,
    clearModelCaches,
    modelSwitchNotice,
    openProviderSetupPicker,
  });
  const {
    openSearchPicker,
    openAgentsPicker,
    openWorkflowPicker,
    openOutputStylePicker,
    openBridgePicker,
    openToolsPicker,
  } = createRoutePickers({
    store,
    state,
    setPicker,
    setProviderPrompt,
    setChannelPrompt,
    setHookPrompt,
    setSettingsPrompt,
    setContextPanel,
    closeUsagePanel,
    clean,
    copyToClipboard,
    routeLabel,
    agentModelParts,
    agentModelProfile,
    workflowSwitchNotice,
    openModelPicker: (...a) => openModelPicker(...a),
  });
  const { openSettingsPicker } = createSettingsPicker({
    store,
    state,
    setPicker,
    setProviderPrompt,
    setChannelPrompt,
    setHookPrompt,
    setSettingsPrompt,
    settingsHeavyCacheRef,
    formatDuration,
    displayModelName,
    routeModelLabel,
    workflowDisplayName,
    workflowSwitchNotice,
    themeNotice,
    openModelPicker: (...a) => openModelPicker(...a),
    openSearchPicker: (...a) => openSearchPicker(...a),
    openAgentsPicker: (...a) => openAgentsPicker(...a),
    openWorkflowPicker: (...a) => openWorkflowPicker(...a),
    openOutputStylePicker: (...a) => openOutputStylePicker(...a),
    openBridgePicker: (...a) => openBridgePicker(...a),
    openToolsPicker: (...a) => openToolsPicker(...a),
    openProviderSetupPicker: (...a) => openProviderSetupPicker(...a),
    openThemePicker: (...a) => openThemePicker(...a),
    openAutoClearPicker: (...a) => openAutoClearPicker(...a),
    openProfilePicker: (...a) => openProfilePicker(...a),
    openMcpPicker: (...a) => openMcpPicker(...a),
    openPluginsPicker: (...a) => openPluginsPicker(...a),
    openHooksPicker: (...a) => openHooksPicker(...a),
    openSkillsPicker: (...a) => openSkillsPicker(...a),
    openUpdatePicker: (...a) => openUpdatePicker(...a),
    openChannelSettingTypePicker: (...a) => openChannelSettingTypePicker(...a),
  });
  const { runSlashCommand } = createSlashDispatch({
    state,
    store,
    normalizeSlashCommandName,
    setContextPanel,
    closeUsagePanel,
    openModelPicker: (...a) => openModelPicker(...a),
    modelSwitchNotice,
    openSearchPicker: (...a) => openSearchPicker(...a),
    openAgentsPicker: (...a) => openAgentsPicker(...a),
    openWorkflowPicker: (...a) => openWorkflowPicker(...a),
    workflowSwitchNotice,
    openOutputStylePicker: (...a) => openOutputStylePicker(...a),
    outputStyleNotice,
    openThemePicker: (...a) => openThemePicker(...a),
    themeNotice,
    openEffortPicker: (...a) => openEffortPicker(...a),
    projectNameFromPath,
    enterProject: (...a) => enterProject(...a),
    openProjectPicker: (...a) => openProjectPicker(...a),
    openToolsPicker: (...a) => openToolsPicker(...a),
    openMcpPicker: (...a) => openMcpPicker(...a),
    openSkillsPicker: (...a) => openSkillsPicker(...a),
    openPluginsPicker: (...a) => openPluginsPicker(...a),
    openHooksPicker: (...a) => openHooksPicker(...a),
    openProviderSetupPicker: (...a) => openProviderSetupPicker(...a),
    openChannelSetupPicker: (...a) => openChannelSetupPicker(...a),
    openMemoryCorePicker: (...a) => openMemoryCorePicker(...a),
    parseMemoryCommand,
    openSettingsPicker: (...a) => openSettingsPicker(...a),
    openAutoClearPicker: (...a) => openAutoClearPicker(...a),
    formatDuration,
    openResumePicker: (...a) => openResumePicker(...a),
    openUsagePanel: (...a) => openUsagePanel(...a),
    openContextPicker: (...a) => openContextPicker(...a),
    openProfilePicker: (...a) => openProfilePicker(...a),
    openUpdatePicker: (...a) => openUpdatePicker(...a),
    runDoctor: (...a) => store.runDoctor?.(...a),
    requestExit: (...a) => requestExit(...a),
  });
  const promptHintTimerRef = useRef(null);
  const promptHintActiveRef = useRef(false);
  // dragRef tracks an in-progress mouse text selection (see the mouse handler):
  // anchor = where the drag began, last = the latest cell, active = button held.
  // region: which surface the in-progress (or last) selection belongs to —
  // 'transcript' | 'status' (both ink-grid) | 'prompt' (PromptInput's own engine)
  // | null. Press decides it; motion/release stay in that region.
  // anchorSpan: for word/line multi-click selections, the initial word/line
  // bounds ({ lo:{x,y}, hi:{x,y}, kind:'word'|'line' }) so a subsequent drag
  // extends the selection whole-word/whole-line from that span (see selection.ts
  // extendSelection). Null ⇔ ordinary char-drag selection.
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
  useEffect(() => {
    let alive = true;
    const refreshConditionalWelcomeHint = async () => {
      let next = '';
      try {
        const setup = await store.getProviderSetup?.();
        if (setup && !providerSetupHasUsableProvider(setup)) {
          next = CONDITIONAL_WELCOME_PROMPT_HINTS.noProvider;
        }
      } catch {
        // If provider setup probing fails, let the generic/error tip path decide.
      }
      if (!next) {
        const activeProvider = String(state.provider || '').trim();
        const activeModel = String(state.model || '').trim();
        if (!activeProvider || !activeModel) {
          next = CONDITIONAL_WELCOME_PROMPT_HINTS.noModel;
        } else {
          try {
            const models = await Promise.resolve(store.listProviderModels?.({ quick: true }) || []);
            if (Array.isArray(models) && models.length === 0) {
              next = CONDITIONAL_WELCOME_PROMPT_HINTS.noModel;
            }
          } catch {
            // Model probing is advisory only; avoid replacing the random hint on failure.
          }
        }
      }
      const activeWorkflow = activeWorkflowSummaryForStore(store, state.workflow || {});
      if (!next && String(activeWorkflow?.id || state.workflow?.id || '').toLowerCase() === 'solo') {
        next = CONDITIONAL_WELCOME_PROMPT_HINTS.soloWorkflow;
      }
      if (!next) {
        const searchRoute = store.getSearchRoute?.() || null;
        const searchProvider = String(searchRoute?.provider || '').trim();
        const searchModel = String(searchRoute?.model || '').trim();
        const defaultSearchRoute = searchProvider.toLowerCase() === 'default' && searchModel.toLowerCase() === 'default';
        if (defaultSearchRoute) {
          try {
            const models = await Promise.resolve(store.listProviderModels?.({ quick: true }) || []);
            const current = Array.isArray(models)
              ? models.find((model) => model?.provider === state.provider && model?.id === state.model)
              : null;
            if (current && current.supportsWebSearch !== true) {
              next = CONDITIONAL_WELCOME_PROMPT_HINTS.searchDefaultUnsupported;
            }
          } catch {
            // Search default probing is advisory only.
          }
        }
      }
      if (!next && toastErrorSignature) {
        next = CONDITIONAL_WELCOME_PROMPT_HINTS.error;
      }
      if (alive) setConditionalWelcomePromptHint((prev) => (prev === next ? prev : next));
    };
    void refreshConditionalWelcomeHint();
    return () => { alive = false; };
  }, [store, state.provider, state.model, state.workflow?.id, toastErrorSignature]);
  const selectionLayoutRef = useRef(null);
  const selectionTextRef = useRef('');
  // lastClickRef tracks the previous left-press cell + time so the mouse handler
  // can detect a double-click (same cell within 500ms) for word selection.
  // count = consecutive qualifying presses on the same cell (1=single,
  // 2=double/word, 3=triple/line). A 4th qualifying press restarts the
  // sequence at 1 (simplest reset: no ratcheting/back-off). Any non-qualifying
  // press resets to a fresh single.
  const lastClickRef = useRef({ x: -1, y: -1, t: 0, count: 0 });

  const showSelectionCopyHint = useCallback((text, tone = 'plain') => {
    if (promptHintTimerRef.current) clearTimeout(promptHintTimerRef.current);
    promptHintActiveRef.current = true;
    setPromptHint(String(text || ''));
    setPromptHintTone(tone);
    promptHintTimerRef.current = setTimeout(() => {
      promptHintTimerRef.current = null;
      promptHintActiveRef.current = false;
      setPromptHint('');
      setPromptHintTone('info');
    }, 2200);
  }, []);

  // ── Post-mount input gate ──────────────────────────────────────────────
  // Let one event-loop poll pass so Ink processes (and discards, because
  // PromptInput is still disabled) any keystrokes queued during boot/first
  // render. After the tick, enable the input — new keystrokes land normally.
  useEffect(() => {
    const timer = setTimeout(() => setTuiReady(true), 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!stdout) return undefined;
    let trailing = null;
    // Leading-edge fire on the first event of a burst, then coalesce the rest:
    // events arriving within DEBOUNCE_MS skip the immediate full-layout update
    // and only refresh the (reset) trailing timer, so a resize storm commits at
    // most once per window plus one settle update instead of once per event.
    const DEBOUNCE_MS = 80;
    let lastRun = 0;
    const update = () => {
      setResizeState((prev) => {
        const next = terminalSize(stdout);
        // No-op when dimensions are unchanged: the unconditional post-mount
        // update() otherwise forces an extra full-frame commit (epoch bump)
        // right after the first paint, which reads as a boot flicker.
        if (next.columns === prev.columns && next.rows === prev.rows) return prev;
        return {
          ...next,
          epoch: prev.epoch + 1,
        };
      });
    };
    const onResize = () => {
      const now = Date.now();
      if (now - lastRun >= DEBOUNCE_MS) {
        lastRun = now;
        update();
      }
      if (trailing) clearTimeout(trailing);
      trailing = setTimeout(() => {
        trailing = null;
        lastRun = Date.now();
        update();
      }, DEBOUNCE_MS);
    };
    stdout.on('resize', onResize);
    update();
    return () => {
      if (trailing) clearTimeout(trailing);
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const clearPromptHint = useCallback(() => {
    if (!promptHintActiveRef.current && !promptHintTimerRef.current) return;
    if (promptHintTimerRef.current) {
      clearTimeout(promptHintTimerRef.current);
      promptHintTimerRef.current = null;
    }
    promptHintActiveRef.current = false;
    setPromptHint('');
    setPromptHintTone('info');
  }, []);

  const showPromptHint = useCallback((text, tone = 'info') => {
    if (promptHintTimerRef.current) clearTimeout(promptHintTimerRef.current);
    promptHintActiveRef.current = true;
    setPromptHint(String(text || ''));
    setPromptHintTone(tone);
    promptHintTimerRef.current = setTimeout(() => {
      promptHintTimerRef.current = null;
      promptHintActiveRef.current = false;
      setPromptHint('');
      setPromptHintTone('info');
    }, 2200);
  }, []);

  const installPastedImages = useCallback((images, { merge = true } = {}) => {
    if (!images || typeof images !== 'object' || Object.keys(images).length === 0) return;
    const next = merge ? { ...pastedImagesRef.current, ...images } : { ...images };
    pastedImagesRef.current = next;
    const maxId = Object.keys(next)
      .map((id) => Number(id) || 0)
      .reduce((max, id) => Math.max(max, id), 0);
    if (maxId >= nextPastedImageIdRef.current) nextPastedImageIdRef.current = maxId + 1;
    setPastedImages(next);
  }, []);

  const clearPastedImagesSnapshot = useCallback((snapshot = null) => {
    if (!snapshot) {
      if (Object.keys(pastedImagesRef.current || {}).length === 0) return;
      pastedImagesRef.current = {};
      setPastedImages({});
      return;
    }
    if (typeof snapshot !== 'object' || Object.keys(snapshot).length === 0) return;
    const next = { ...pastedImagesRef.current };
    let changed = false;
    for (const [id, image] of Object.entries(snapshot)) {
      if (next[id] === image) {
        delete next[id];
        changed = true;
      }
    }
    if (!changed) return;
    pastedImagesRef.current = next;
    setPastedImages(next);
  }, []);

  const registerPastedImage = useCallback((image) => {
    if (!image || image.type !== 'image' || !image.content) return '';
    const id = nextPastedImageIdRef.current++;
    const entry = { ...image, id };
    pastedImagesRef.current = { ...pastedImagesRef.current, [id]: entry };
    setPastedImages(pastedImagesRef.current);
    return formatImageRef(id);
  }, []);

  const installPastedTexts = useCallback((texts, { merge = true } = {}) => {
    if (!texts || typeof texts !== 'object' || Object.keys(texts).length === 0) return;
    const next = merge ? { ...pastedTextsRef.current, ...texts } : { ...texts };
    pastedTextsRef.current = next;
    const maxId = Object.keys(next)
      .map((id) => Number(id) || 0)
      .reduce((max, id) => Math.max(max, id), 0);
    if (maxId >= nextPastedTextIdRef.current) nextPastedTextIdRef.current = maxId + 1;
    setPastedTexts(next);
  }, []);

  const clearPastedTextsSnapshot = useCallback((snapshot = null) => {
    if (!snapshot) {
      if (Object.keys(pastedTextsRef.current || {}).length === 0) return;
      pastedTextsRef.current = {};
      setPastedTexts({});
      return;
    }
    if (typeof snapshot !== 'object' || Object.keys(snapshot).length === 0) return;
    const next = { ...pastedTextsRef.current };
    let changed = false;
    for (const [id, text] of Object.entries(snapshot)) {
      if (next[id] === text) {
        delete next[id];
        changed = true;
      }
    }
    if (!changed) return;
    pastedTextsRef.current = next;
    setPastedTexts(next);
  }, []);

  const registerPastedText = useCallback((text) => {
    const value = String(text ?? '');
    if (!value) return '';
    const id = nextPastedTextIdRef.current++;
    const entry = { id, text: value };
    pastedTextsRef.current = { ...pastedTextsRef.current, [id]: entry };
    setPastedTexts(pastedTextsRef.current);
    return formatPastedTextRef(id, value);
  }, []);

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

  // Copy the currently-highlighted selection to the OS clipboard. ink's fork
  // refreshed store.getRenderSelectionText() on the synchronous render that the
  // final setSelection() triggered, so the selected text is ready to read.
  // NOTE: declared after useTranscriptScroll — the dependency array below
  // evaluates getStitchedSelectionText at render time, so referencing it
  // before the destructuring above is a TDZ ReferenceError.
  const copySelection = useCallback((attempt = 0) => {
    const renderText = store.getRenderSelectionText?.();
    const remembered = selectionTextRef.current || '';
    // A selection that has partially scrolled out of the viewport renders —
    // and therefore harvests — only its visible rows. The remembered text
    // (captured while the selection was last fully painted) is the fuller
    // copy; prefer whichever is longer so scrolling never shrinks a copy.
    let text = renderText == null
      ? remembered
      : (remembered.length > renderText.length ? remembered : renderText);
    // The stitch buffer accumulates rows harvested across every scroll position
    // during a transcript drag, so it can reconstruct rows that scrolled out of
    // view entirely (neither renderText nor the last-full-paint remembered text
    // ever saw them). getStitchedSelectionText now reports a `complete` flag:
    // prefer the stitch ONLY when it contiguously covers the selection (no
    // interior gap) AND adds rows. A gapped stitch silently drops a scrolled-off
    // row, so preferring it purely on length yielded a mangled copy.
    const stitched = getStitchedSelectionText?.() || { text: '', complete: false };
    if (stitched.complete && stitched.text.length > text.length) text = stitched.text;
    if ((!text || !text.trim()) && attempt < 4) {
      setTimeout(() => copySelection(attempt + 1), attempt === 0 ? 0 : 24);
      return;
    }
    if (!text || !text.trim()) {
      // Retries exhausted with nothing to copy: never return silently — the
      // user pressed Ctrl+C expecting feedback. Surface a hint (and still
      // swallow the key, which the caller already did).
      showSelectionCopyHint('nothing to copy · select text first', 'error');
      return;
    }
    selectionTextRef.current = text;
    copyToClipboard(text)
      .then(() => {
        const lines = text.split('\n').length;
        const chars = text.length;
        showSelectionCopyHint(`copied ${chars} char${chars === 1 ? '' : 's'}${lines > 1 ? ` · ${lines} lines` : ''}`, 'plain');
      })
      .catch((e) => showSelectionCopyHint(`copy failed: ${e?.message || e}`, 'error'));
  }, [store, showSelectionCopyHint, getStitchedSelectionText]);

  useEffect(() => () => {
    stopSmoothScroll();
  }, [stopSmoothScroll]);

  useEffect(() => () => {
    if (promptHintTimerRef.current) clearTimeout(promptHintTimerRef.current);
  }, []);

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

  // Enable extended keyboard reporting (kitty + xterm modifyOtherKeys)
  // SYNCHRONOUSLY, ONCE, with NO query/round-trip. ink
  // turns raw mode on during the first useInput mount (synchronously, inside
  // render); this mount effect runs in the same commit phase, right after — i.e.
  // before the user can realistically press a key. We write BOTH enables
  // unconditionally (the terminal honors whichever it implements; Windows
  // Terminal 1.24 has no kitty but DOES honor modifyOtherKeys), gated only by the
  // supportsExtendedKeys() allowlist. Because the enable lands before the first
  // keypress is read, the FIRST Ctrl+Enter already arrives as a distinguishable
  // \x1b[27;5;13~ (or kitty \x1b[13;5u) instead of a bare \r — fixing the old
  // "first Ctrl+Enter submits, second works" race. Teardown lives in index.jsx's
  // restoreTerminal(). The empty dep array makes this run exactly once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isRawModeSupported || !stdout?.write) return;
    if (!supportsExtendedKeys()) return;
    try {
      stdout.write(ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS);
    } catch { /* terminal may be closing */ }
  }, []);

  // Item-count changes are the only time we can arm follow before row totals are
  // recomputed. Pure streaming height growth is handled in the row-delta effect.
  useLayoutEffect(() => {
    const count = state.items.length;
    const previousCount = lastItemsCountRef.current;
    lastItemsCountRef.current = count;
    if (count < previousCount || previousCount === 0) {
      resetTranscriptScroll();
      return;
    }
    if (count === previousCount || dragRef.current.active) return;
    if (scrollTargetRef.current <= transcriptBottomSlackRows || followingRef.current) followingRef.current = true;
  }, [state.items.length, resetTranscriptScroll]);

  // `exiting` removes the inline caret (PromptInput draws none when disabled) and
  // freezes input for the teardown frame, so the final frame is clean before ink
  // unmounts. Exit just past the render throttle window so that frame flushes.
  const requestExit = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    setExiting(true);
    const hardExitTimer = setTimeout(() => {
      try { process.stdout.write('\x1b[?25h\x1b[0m'); } catch {}
      process.exit(0);
    }, 2000);
    hardExitTimer.unref?.();
    setTimeout(() => {
      let timer = null;
      Promise.race([
        Promise.resolve(store.dispose?.('cli-react-exit', { detach: true })),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 350);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
        exit();
      });
    }, 60);
  }, [store, exit]);

  const restoreQueuedToPrompt = useCallback((options = {}) => {
    const restoreDraft = options.restoreDraft !== false;
    const showHint = options.showHint !== false;
    const currentText = options.currentText ?? promptValueRef.current ?? promptDraft;
    const restored = store.restoreQueued?.(currentText);
    if (!restored || restored.count === 0) {
      if (showHint) showPromptHint('No queued messages to restore.', 'info');
      return false;
    }
    if (restoreDraft) {
      if (restored.pastedImages) installPastedImages(restored.pastedImages, { merge: true });
      if (restored.pastedTexts) installPastedTexts(restored.pastedTexts, { merge: true });
      syncPromptLayoutRows(restored.text);
      setPromptDraftOverride({ id: Date.now(), value: restored.text });
    }
    if (showHint) {
      showPromptHint(`restored ${restored.count} queued message${restored.count === 1 ? '' : 's'}`, 'info');
    } else {
      clearPromptHint();
    }
    return true;
  }, [store, promptDraft, showPromptHint, clearPromptHint, installPastedImages, syncPromptLayoutRows]);

  const recentPromptHistory = useMemo(() => {
    // The engine maintains this list incrementally (rebuilt only when a user
    // item is appended or the transcript is bulk-swapped), so App no longer
    // rescans all items on every transcript change. Fall back to a local scan
    // only if the engine did not publish it (older snapshot).
    if (Array.isArray(state.promptHistoryList)) return state.promptHistoryList;
    const items = Array.isArray(state.items) ? state.items : [];
    const seen = new Set();
    const history = [];
    for (let i = items.length - 1; i >= 0 && history.length < PROMPT_HISTORY_LIMIT; i -= 1) {
      const item = items[i];
      if (item?.kind !== 'user') continue;
      const text = String(item.text || '').trim();
      const key = promptHistoryKey(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      history.push(text);
    }
    return history;
  }, [state.promptHistoryList, state.items]);

  const resetPromptHistoryNav = useCallback(() => {
    promptHistoryNavRef.current = { active: false, index: -1, seed: '', lastValue: '' };
  }, []);

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
    setContextPanel,
    syncPromptLayoutRows,
    showPromptHint,
    clearPromptHint,
    recentPromptHistory,
    resetPromptHistoryNav,
    restoreQueuedToPrompt,
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

  useInput((input, key) => {
    if (toolApproval) {
      const value = String(input || '').trim().toLowerCase();
      if (key.escape || value === 'd' || value === 'n') {
        store.resolveToolApproval?.(toolApproval.id, { approved: false, reason: 'denied by user' });
        return;
      }
      if (value === 'a' || value === 'y') {
        store.resolveToolApproval?.(toolApproval.id, { approved: true, reason: 'approved by user' });
        return;
      }
    }
    if (key.ctrl && (input === 'c' || input === 'C')) {
      // Ctrl+C is copy-first. Native terminal selections can still forward the
      // key event to us on Windows Terminal, so a missing app-owned selection
      // must NOT cancel the active turn; use Esc to interrupt instead.
      // Region-aware copy source: a prompt-box selection (its OWN engine) copies
      // from promptSelectionRef; a transcript/status ink-grid selection copies
      // from store.getRenderSelectionText via copySelection(). Only one region is
      // ever active at a time (a press in one region clears the others), but when
      // the last drag was in the prompt we prefer its selection explicitly.
      const promptSelectionText = promptSelectionRef.current?.text;
      const lastRegion = dragRef.current.region;
      const inkRect = dragRef.current.rect;
      const hasInkSelection = inkRect && !(inkRect.x1 === inkRect.x2 && inkRect.y1 === inkRect.y2);
      if (promptSelectionText && (lastRegion === 'prompt' || !hasInkSelection)) {
        copyToClipboard(promptSelectionText)
          .then(() => showSelectionCopyHint(`copied ${promptSelectionText.length} char${promptSelectionText.length === 1 ? '' : 's'}`, 'plain'))
          .catch((e) => showSelectionCopyHint(`copy failed: ${e?.message || e}`, 'error'));
        return;
      }
      if (hasInkSelection) {
        copySelection();
        return;
      }
      // No app-owned selection. On Windows Terminal the same Ctrl+C is also the
      // native terminal's copy shortcut for a mouse selection we can't see — so
      // rendering a hint here fights that copy and flashes a spurious message.
      // Suppress the hint on win32 (interrupt routing is unchanged: Esc still
      // interrupts). Other platforms keep the guidance.
      if (process.platform !== 'win32') {
        showSelectionCopyHint('select text to copy · Esc interrupts', 'plain');
      }
      return;
    }
    if (key.ctrl && (input === 'o' || input === 'O')) {
      toggleExpand();
      return;
    }
    const rawShiftUp = input === '\x1b[1;2A' || input === '\x1b[a' || input === '[1;2A';
    const rawShiftDown = input === '\x1b[1;2B' || input === '\x1b[b' || input === '[1;2B';
    const rawShiftRight = input === '\x1b[1;2C' || input === '\x1b[c' || input === '[1;2C';
    const rawShiftLeft = input === '\x1b[1;2D' || input === '\x1b[d' || input === '[1;2D';
    const rawCtrlShiftUp = input === '\x1b[1;6A' || input === '[1;6A';
    const rawCtrlShiftDown = input === '\x1b[1;6B' || input === '[1;6B';
    const rawCtrlShiftRight = input === '\x1b[1;6C' || input === '[1;6C';
    const rawCtrlShiftLeft = input === '\x1b[1;6D' || input === '[1;6D';
    const rawModifiedShiftArrow = rawShiftUp || rawShiftDown || rawShiftLeft || rawShiftRight
      || rawCtrlShiftUp || rawCtrlShiftDown || rawCtrlShiftLeft || rawCtrlShiftRight;
    if (
      !picker
      && (
        (key.shift && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.home || key.end))
        || rawModifiedShiftArrow
      )
    ) {
      // Consume the chord whenever a transcript/status ink-grid selection is
      // live — even if the focus clamps at an edge (moveSelectionFocus returns
      // false there). PromptInput independently skips the same chord via the
      // shared gridSelectionActiveRef predicate, so there is no double-handling.
      // When no grid selection is live, fall through to PromptInput.
      let move = null;
      if (key.leftArrow || rawShiftLeft || rawCtrlShiftLeft) move = 'left';
      else if (key.rightArrow || rawShiftRight || rawCtrlShiftRight) move = 'right';
      else if (key.upArrow || rawShiftUp || rawCtrlShiftUp) move = 'up';
      else if (key.downArrow || rawShiftDown || rawCtrlShiftDown) move = 'down';
      else if (key.home) move = 'lineStart';
      else if (key.end) move = 'lineEnd';
      if (move && gridSelectionActiveRef.current()) {
        moveSelectionFocus(move);
        return;
      }
    }
    if (key.escape && usagePanel && !picker) {
      closeUsagePanel();
      return;
    }
    if (key.escape && contextPanel && !picker) {
      setContextPanel(null);
      return;
    }
    if (key.pageUp) {
      if (overlayBlocksGlobalTranscriptScroll(scrollFocusRef.current)) return;
      const pageRows = Math.max(3, Math.floor((resizeState.rows ?? 24) * 0.6));
      scrollTranscriptRows(pageRows);
      return;
    }
    if (key.pageDown) {
      if (overlayBlocksGlobalTranscriptScroll(scrollFocusRef.current)) return;
      const pageRows = Math.max(3, Math.floor((resizeState.rows ?? 24) * 0.6));
      scrollTranscriptRows(-pageRows);
      return;
    }
    if (key.ctrl && key.end) {
      resetTranscriptScroll();
      return;
    }
    if (key.escape && !picker) {
      dragRef.current.active = false;
      dragRef.current.region = null;
      dragRef.current.anchorSpan = null;
      // Clear whichever region's selection is active. PromptInput's own ESC also
      // clears its selection when focused/enabled; this covers the disabled case
      // and a status/transcript ink-grid selection in one press.
      promptMouseSelectionRef.current?.clear?.();
      applySelectionRect(null);
    }
  }, { isActive: isRawModeSupported });

  const openUsagePanel = (arg = '') => {
    const refresh = /(?:^|\s)(?:refresh|--refresh|-r|true)(?:\s|$)/i.test(String(arg || ''));
    const requestId = usageRequestRef.current + 1;
    usageRequestRef.current = requestId;
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker(null);
    setContextPanel(null);
    setUsagePanel({
      title: 'Provider Quotas',
      subtitle: 'Statusline-style provider quota windows.',
      checking: true,
      refresh,
      rows: [],
      total: null,
    });
    setTimeout(() => {
      if (usageRequestRef.current !== requestId) return;
      void store.getUsageDashboard?.({
        refresh,
        onUpdate: (dashboard) => {
          if (usageRequestRef.current !== requestId) return;
          if (!dashboard) return;
          setUsagePanel(dashboard);
        },
      })
        .then((dashboard) => {
          if (usageRequestRef.current !== requestId) return;
          if (!dashboard) {
            closeUsagePanel();
            store.pushNotice('usage dashboard unavailable', 'warn');
            return;
          }
          setUsagePanel(dashboard);
        })
        .catch((e) => {
          if (usageRequestRef.current !== requestId) return;
          closeUsagePanel();
          store.pushNotice(`usage failed: ${e?.message || e}`, 'error');
        });
    }, 0);
  };

  const openContextPicker = () => {
    const tools = store.toolsStatus?.() || { activeCount: 0, count: 0, activeTools: [] };
    const mcp = store.mcpStatus?.() || { connectedCount: 0, configuredCount: 0, failedCount: 0 };
    const skills = store.skillsStatus?.() || { count: 0 };
    const plugins = store.pluginsStatus?.() || { count: 0 };
    const context = store.contextStatus?.() || {};
    const usage = context.usage || {};
    const messages = context.messages || {};
    const request = context.request || {};
    const compaction = context.compaction || {};
    const windowTokens = Number(context.contextWindow || state.contextWindow || context.rawContextWindow || state.rawContextWindow || 0);
    const rawWindowTokens = Number(context.rawContextWindow || state.rawContextWindow || windowTokens || 0);
    // Compaction boundary/trigger are sourced from the runtime contextStatus
    // (context.compaction). Fall back to the visible window for the boundary
    // and to the boundary for the trigger so /context still renders on a
    // fresh/resumed session before any compaction telemetry exists. (These
    // used to reference undefined compactTrigger/compactBoundary and threw a
    // ReferenceError when the picker opened.)
    const compactBoundary = Number(compaction.boundaryTokens || windowTokens || 0);
    const compactTrigger = Number(compaction.triggerTokens || compactBoundary || 0);
    const usedTokens = Number(context.usedTokens || context.currentEstimatedTokens || usage.lastContextTokens || 0);
    const freeTokens = windowTokens ? Math.max(0, windowTokens - usedTokens) : Number(context.freeTokens || 0);
    const pct = (value, total = windowTokens) => {
      const n = Number(value || 0);
      const d = Number(total || 0);
      if (!d) return 'N/A';
      const p = Math.max(0, Math.min(100, (n / d) * 100));
      return `${p > 0 && p < 1 ? p.toFixed(1) : Math.floor(p)}%`;
    };
    const fmt = (value) => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '0';
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
      if (n >= 10_000) return `${Math.round(n / 1000)}k`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
      return `${Math.round(n)}`;
    };
    const cachedRead = Number(usage.lastCachedReadTokens || 0);
    const cacheWrite = Number(usage.lastCacheWriteTokens || 0);
    const freshInput = Number(
      usage.lastUncachedInputTokens != null
        ? usage.lastUncachedInputTokens
        : Math.max(Number(usage.lastInputTokens || 0) - cachedRead - cacheWrite, 0)
    );
    const cacheDenom = Number(usage.lastContextTokens || 0) || (cachedRead + freshInput + cacheWrite);
    const cacheHitRate = cacheDenom > 0
      ? `${((cachedRead / cacheDenom) * 100).toFixed(0)}%`
      : 'N/A';
    const cacheWriteLabel = cacheWrite > 0 ? ` · ${fmt(cacheWrite)} write` : '';
    const contextSource = context.usedSource === 'last_api_request' ? 'last API request' : 'estimated';
    const lastApiLabel = context.lastApiRequestStale ? 'last API request (pre-compact)' : 'last API request';
    const compactElapsed = (value) => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '';
      return `${Math.max(1, Math.ceil(n / 1000))}s`;
    };
    const compactRunning = compaction.inProgress === true || compaction.lastStage === 'compacting';
    const autoClearFailed = compaction.lastStage === 'auto_clear_failed' || !!compaction.lastClearCompactError;
    const autoClearStage = compaction.lastStage === 'auto_clear' || compaction.lastClearAt;
    const compactDuration = compactElapsed(compaction.lastDurationMs);
    const compactInterrupted = compaction.lastStage === 'interrupted';
    const compactReactive = String(compaction.lastTrigger || '').toLowerCase() === 'reactive';
    const compactState = compactRunning
      ? 'Compacting conversation'
      : compactInterrupted
      ? 'Compact interrupted'
      : autoClearFailed
      ? `auto-clear skipped${compaction.lastClearCompactError ? `: ${compaction.lastClearCompactError}` : ''}`
      : autoClearStage
      ? 'Auto-clear complete'
      : compaction.lastChanged
      ? (compactReactive ? 'Compact complete (overflow recovery)' : 'Compact complete')
      : 'Compact checked';
    const compactDescription = compactDuration
      ? `${compactState} · ${compactDuration}`
      : compactState;
    const contextRows = [
      {
        value: 'summary',
        label: 'Context Usage',
        description: `${fmt(usedTokens)}/${fmt(windowTokens)} (${pct(usedTokens)}) · ${fmt(freeTokens)} free · ${contextSource} · effective`,
        _action: 'summary',
      },
      {
        value: 'compaction',
        label: 'Compaction',
        description: compactDescription,
        _action: 'compaction',
      },
      {
        value: 'messages',
        label: 'Messages',
        description: `${fmt(messages.estimatedTokens)} tokens (${pct(messages.estimatedTokens)}) · ${messages.count || 0} messages`,
        _action: 'messages',
      },
      {
        value: 'tools',
        label: 'Tools',
        description: `${fmt(request.toolSchemaTokens)} schema tokens (${pct(request.toolSchemaTokens)}) · ${tools.activeCount || 0}/${tools.count || 0} active`,
        _action: 'tools',
      },
      {
        value: 'tool-io',
        label: 'Tool calls/results',
        description: `${messages.toolCallCount || 0} calls (${fmt(messages.toolCallTokens)}) · ${messages.toolResultCount || 0} results (${fmt(messages.toolResultTokens)})`,
        _action: 'tool-io',
      },
      {
        value: 'request',
        label: 'Request overhead',
        description: `${fmt(request.requestOverheadTokens)} framing · ${fmt(request.reserveTokens)} reserve incl. tools`,
        _action: 'request',
      },
      {
        value: 'last-api',
        label: 'Last API usage',
        description: `${fmt(usage.lastContextTokens)} context · ${fmt(freshInput)} uncached input · ${fmt(usage.lastOutputTokens)} output · ${lastApiLabel}`,
        _action: 'last-api',
      },
      {
        value: 'cache',
        label: 'Prompt cache',
        description: `${cacheHitRate} hit · ${fmt(usage.lastCachedReadTokens)} read${cacheWriteLabel} · ${fmt(freshInput)} new (last request)`,
        _action: 'cache',
      },
      {
        value: 'free',
        label: 'Free space',
        description: `${fmt(freeTokens)} tokens (${pct(freeTokens)}) · raw window ${fmt(rawWindowTokens)}`,
        _action: 'free',
      },
      {
        value: 'extensions',
        label: 'Skills/plugins',
        description: `${skills.count || 0} skills · ${plugins.count || 0} plugins`,
        _action: 'extensions',
      },
    ];
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker(null);
    setContextPanel({
      kind: 'context',
      title: 'Context Usage',
      detail: {
        type: 'context',
        usage: {
          usedTokens,
          windowTokens,
          freeTokens,
          rawWindowTokens,
          source: contextSource,
          effective: true,
        },
        compaction: {
          stage: compaction.lastStage || 'pending',
          state: compactState,
          triggerTokens: compactTrigger,
          boundaryTokens: compactBoundary,
          type: compaction.compactType || compaction.type || null,
          bufferTokens: Number(compaction.bufferTokens || (compactBoundary && compactTrigger ? Math.max(0, compactBoundary - compactTrigger) : 0)) || null,
          pressureTokens: Number(compaction.lastPressureTokens || compaction.currentEstimatedTokens || 0) || null,
          lastChanged: compaction.lastChanged === true,
        },
        messages: {
          tokens: messages.estimatedTokens,
          count: messages.count,
          semantic: messages.semantic,
        },
        tools: {
          schemaTokens: request.toolSchemaTokens,
          active: tools.activeCount,
          count: tools.count,
        },
        toolIo: {
          calls: messages.toolCallCount,
          results: messages.toolResultCount,
        },
        request: {
          toolSchemaBreakdown: request.toolSchemaBreakdown,
          overheadTokens: request.requestOverheadTokens,
          reserveTokens: request.reserveTokens,
        },
        lastApi: {
          contextTokens: usage.lastContextTokens,
          inputTokens: freshInput,
          rawInputTokens: usage.lastInputTokens,
          outputTokens: usage.lastOutputTokens,
        },
        cache: {
          hitRate: cacheHitRate,
          readTokens: usage.lastCachedReadTokens,
          writeTokens: cacheWrite,
        },
        extensions: {
          skills: skills.count,
          plugins: plugins.count,
        },
        mcp: {
          connected: mcp.connectedCount,
          configured: mcp.configuredCount,
          failed: mcp.failedCount,
        },
      },
      rows: contextRows,
    });
  };

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
    let canceled = false;
    try {
      const status = store.getOnboardingStatus?.();
      if (status?.completed === true && !forceOnboarding) return undefined;
      onboardingStartedRef.current = true;
      setOnboardingActive(true);
      setTimeout(() => {
        if (!canceled) openOnboardingAuthStep();
      }, 0);
    } catch {
      // If status probing fails, do not block normal TUI startup.
    }
    return () => {
      canceled = true;
    };
  }, [store, forceOnboarding]);

  const onSubmit = (raw) => {
    const text = String(raw ?? '');
    const commandText = text.trim();
    if (providerPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      if (providerPrompt.kind === 'api-key') {
        if (!commandText) {
          store.pushNotice(`API key is required for ${providerPrompt.providerId}`, 'warn');
          return false;
        }
        try {
          store.saveProviderApiKey(providerPrompt.providerId, commandText);
          clearModelCaches('all');
          const afterSave = providerPrompt.afterSave;
          setProviderPrompt(null);
          if (afterSave) afterSave();
          else void openProviderSetupPicker();
          return true;
        } catch (e) {
          store.pushNotice(`api key save failed: ${e?.message || e}`, 'error');
          return false;
        }
      }
      if (providerPrompt.kind === 'openai-usage-session') {
        if (!commandText) {
          store.pushNotice('OpenAI usage session key is required for credit lookup', 'warn');
          return false;
        }
        try {
          store.saveOpenAIUsageSessionKey(commandText);
          const afterSave = providerPrompt.afterSave;
          setProviderPrompt(null);
          if (afterSave) afterSave();
          else void openProviderSetupPicker();
          return true;
        } catch (e) {
          store.pushNotice(`OpenAI usage auth save failed: ${e?.message || e}`, 'error');
          return false;
        }
      }
      if (providerPrompt.kind === 'local-url') {
        try {
          store.setLocalProvider(providerPrompt.providerId, {
            enabled: true,
            baseURL: commandText || providerPrompt.defaultURL,
          });
          clearModelCaches('all');
          const afterSave = providerPrompt.afterSave;
          setProviderPrompt(null);
          if (afterSave) afterSave();
          else void openProviderSetupPicker();
          return true;
        } catch (e) {
          store.pushNotice(`local provider update failed: ${e?.message || e}`, 'error');
          return false;
        }
      }
      if (providerPrompt.kind === 'oauth-code') {
        if (!commandText) {
          store.pushNotice('OAuth code is required', 'warn');
          return false;
        }
        if (oauthSubmitRef.current || providerPrompt.submitting) {
          store.pushNotice('OAuth code is already being submitted', 'warn');
          return false;
        }
        oauthSubmitRef.current = true;
        setProviderPrompt((prompt) => prompt === providerPrompt ? { ...prompt, submitting: true } : prompt);
        void providerPrompt.login?.completeCode(commandText)
          .then(() => {
            const successReturn = providerPrompt.successReturn;
            const afterSave = providerPrompt.afterSave;
            oauthSubmitRef.current = false;
            clearModelCaches('all');
            setProviderPrompt(null);
            store.pushNotice(`${providerPrompt.providerName || 'OAuth'} login complete`, 'info');
            if (successReturn) successReturn();
            else if (afterSave) afterSave();
            else void openProviderSetupPicker();
          })
          .catch((e) => {
            oauthSubmitRef.current = false;
            store.pushNotice(`oauth code failed: ${e?.message || e}`, 'error');
            setProviderPrompt(null);
            providerPrompt.failureReturn?.(e);
          });
        return true;
      }
    }
    if (channelPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      try {
        const resumeAfterChannelPrompt = (prompt) => {
          const afterSave = prompt?.afterSave;
          setChannelPrompt(null);
          if (typeof afterSave === 'function') afterSave();
          else void openChannelSetupPicker('all');
        };
        if (channelPrompt.kind === 'discord-token') {
          if (!commandText) return false;
          store.saveDiscordToken(commandText);
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        if (channelPrompt.kind === 'telegram-token') {
          if (!commandText) return false;
          store.saveTelegramToken(commandText);
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        if (channelPrompt.kind === 'webhook-token') {
          if (!commandText) return false;
          store.saveWebhookAuthtoken(commandText);
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        if (channelPrompt.kind === 'webhook-domain') {
          if (!commandText) return false;
          store.setWebhookConfig?.({ ngrokDomain: commandText });
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        const parts = commandText.split('|').map((part) => part.trim());
        if (channelPrompt.kind === 'channel-add') {
          // Single-channel: the UI asks only for the channel id. Legacy
          // `name | id | ...` pipe input still parses (the id is the second
          // field) so old muscle memory does not break.
          const isPipe = parts.length > 1;
          const channelId = isPipe ? parts[1] : parts[0];
          store.setChannel({
            channelId,
            backend: channelPrompt.backend,
          });
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        if (channelPrompt.kind === 'schedule-add') {
          const [name, time, instructions, channel, model] = parts;
          // saveSchedule is async (PG-backed). Only close the prompt / open the
          // list on success; surface a failure notice and keep the prompt open
          // so the input is not lost and the user can retry.
          Promise.resolve(store.saveSchedule({ name, time, instructions, channel, model }))
            .then(() => {
              setChannelPrompt(null);
              void openChannelSetupPicker('schedules');
            })
            .catch((e) => {
              store.pushNotice(`schedule save failed: ${e?.message || e}`, 'error');
            });
          return true;
        }
        if (channelPrompt.kind === 'webhook-add') {
          const [name, instructions, channel, model, parser] = parts;
          // saveWebhook is async (PG-backed). Only close the prompt / open the
          // list on success; surface a failure notice and keep the prompt open.
          Promise.resolve(store.saveWebhook({ name, instructions, channel, model, parser }))
            .then((result) => {
              if (result?.secret) {
                store.pushNotice(`webhook secret for ${result.name}: ${result.secret}`, 'info');
              }
              setChannelPrompt(null);
              void openChannelSetupPicker('webhooks');
            })
            .catch((e) => {
              store.pushNotice(`webhook save failed: ${e?.message || e}`, 'error');
            });
          return true;
        }
      } catch (e) {
        store.pushNotice(`channels update failed: ${e?.message || e}`, 'error');
        return false;
      }
    }
    if (hookPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      try {
        if (hookPrompt.kind === 'rule-add') {
          const parsed = parseHookRuleInput(commandText);
          if (parsed.error) {
            store.pushNotice(parsed.error, 'warn');
            return false;
          }
          store.addHookRule?.(parsed.rule);
          setHookPrompt(null);
          void openHooksPicker();
          return true;
        }
      } catch (e) {
        store.pushNotice(`hook update failed: ${e?.message || e}`, 'error');
        return false;
      }
    }
    if (settingsPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      try {
        if (settingsPrompt.kind === 'cwd') {
          if (!commandText) {
            store.pushNotice('working directory path is required', 'warn');
            return false;
          }
          store.setCwd?.(commandText, { message: `Project set: ${projectNameFromPath(commandText)}` });
          setSettingsPrompt(null);
          void openSettingsPicker();
          return true;
        }
        if (settingsPrompt.kind === 'project-new') {
          if (!commandText) {
            store.pushNotice('project path is required', 'warn');
            return false;
          }
          const path = resolveProjectPath(commandText);
          if (isDirectory(path)) {
            setSettingsPrompt(null);
            registerProject(path);
            return true;
          }
          // A path that exists but is a regular file is not a valid project dir.
          if (pathExists(path)) {
            store.pushNotice(`${path} is not a directory`, 'warn');
            return false;
          }
          // Missing folder: confirm creation before registering.
          setSettingsPrompt({
            kind: 'project-create-confirm',
            label: 'New project · Create folder?',
            hint: `${path} does not exist. Type "y" to create it, or anything else to cancel.`,
            pendingPath: path,
          });
          return true;
        }
        if (settingsPrompt.kind === 'project-create-confirm') {
          const pendingPath = String(settingsPrompt.pendingPath || '');
          const answer = String(commandText || '').trim().toLowerCase();
          if (answer === 'y' || answer === 'yes') {
            const created = ensureDir(pendingPath);
            if (!created) {
              store.pushNotice(`could not create folder: ${pendingPath}`, 'error');
              setSettingsPrompt(null);
              return true;
            }
            setSettingsPrompt(null);
            registerProject(pendingPath);
            return true;
          }
          setSettingsPrompt(null);
          store.pushNotice('project creation canceled', 'info');
          return true;
        }
        if (settingsPrompt.kind === 'project-rename') {
          const targetPath = String(settingsPrompt.projectPath || '');
          try {
            const updated = renameProject(targetPath, commandText);
            if (updated) {
              store.pushNotice(`project renamed to "${updated.name}"`, 'info');
            }
          } catch (e) {
            store.pushNotice(`rename failed: ${e?.message || e}`, 'error');
          }
          setSettingsPrompt(null);
          openProjectPicker();
          return true;
        }
        if (settingsPrompt.kind === 'system-shell') {
          store.setSystemShell?.(commandText);
          setSettingsPrompt(null);
          void openSettingsPicker();
          return true;
        }
        if (settingsPrompt.kind === 'autoclear-provider') {
          const provider = String(settingsPrompt.provider || '').trim();
          if (!provider) {
            store.pushNotice('auto-clear provider is missing', 'warn');
            return false;
          }
          const text = String(commandText || '').trim();
          try {
            if (text) store.setAutoClear?.({ provider, duration: text });
            else store.setAutoClear?.({ provider, resetProvider: true });
            store.pushNotice(text ? `Auto-clear ${provider} default set to ${text}` : `Auto-clear ${provider} default reset`, 'info');
          } catch (e) {
            store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error');
            return false;
          }
          setSettingsPrompt(null);
          openAutoClearPicker({ advanced: true, returnTo: settingsPrompt.returnTo });
          return true;
        }
        if (settingsPrompt.kind === 'profile-title') {
          try {
            store.setProfile?.({ title: commandText });
            store.pushNotice(commandText ? `Title set to "${commandText.trim()}"` : 'Title cleared', 'info');
          } catch (e) {
            store.pushNotice(`profile update failed: ${e?.message || e}`, 'error');
          }
          setSettingsPrompt(null);
          openProfilePicker();
          return true;
        }
        if (settingsPrompt.kind === 'plugin-add') {
          if (!commandText) {
            store.pushNotice('plugin URL/path is required', 'warn');
            return false;
          }
          void store.addPlugin?.(commandText)
            .then(() => openPluginsPicker())
            .catch((e) => store.pushNotice(`plugin add failed: ${e?.message || e}`, 'error'));
          setSettingsPrompt(null);
          return true;
        }
        if (settingsPrompt.kind === 'mcp-add') {
          const parsed = parseMcpServerInput(commandText);
          if (parsed.error) {
            store.pushNotice(parsed.error, 'warn');
            return false;
          }
          void store.addMcpServer?.(parsed.server)
            .then(() => openMcpServersPicker())
            .catch((e) => store.pushNotice(`mcp add failed: ${e?.message || e}`, 'error'));
          setSettingsPrompt(null);
          return true;
        }
        if (settingsPrompt.kind === 'skill-add') {
          const parsed = parseSkillInput(commandText);
          if (parsed.error) {
            store.pushNotice(parsed.error, 'warn');
            return false;
          }
          void store.addSkill?.(parsed.skill)
            .then(() => openProjectSkillsPicker())
            .catch((e) => store.pushNotice(`skill add failed: ${e?.message || e}`, 'error'));
          setSettingsPrompt(null);
          return true;
        }
        if (settingsPrompt.kind === 'skill-use') {
          const skillName = String(settingsPrompt.skillName || '').trim();
          if (!skillName) {
            store.pushNotice('skill name is missing', 'warn');
            return false;
          }
          const prompt = `$${skillName}${commandText ? ` ${commandText}` : ''}`;
          setSettingsPrompt(null);
          const accepted = store.submit(prompt);
          if (accepted) armTranscriptFollow();
          return accepted;
        }
        if (settingsPrompt.kind === 'core-add') {
          const sentence = commandText.trim();
          if (!sentence) {
            store.pushNotice('memory sentence is required', 'warn');
            return false;
          }
          setSettingsPrompt(null);
          void store.memoryControl?.({ action: 'core', op: 'add', project_id: 'common', element: sentence, summary: sentence }, { silent: true })
            .then((result) => {
              const errText = memoryCoreResultErrorText(result);
              store.pushNotice(errText || 'core memory added', errText ? 'error' : 'info');
              openMemoryCorePicker();
            })
            .catch((e) => {
              store.pushNotice(`core add failed: ${e?.message || e}`, 'error');
              openMemoryCorePicker();
            });
          return true;
        }
        if (settingsPrompt.kind === 'core-edit') {
          const sentence = commandText.trim();
          const id = settingsPrompt._id;
          const projectId = settingsPrompt._projectId ?? 'common';
          if (!sentence) {
            store.pushNotice('memory sentence is required', 'warn');
            return false;
          }
          setSettingsPrompt(null);
          // Single-sentence semantics only rewrite `element` when the row was
          // already element===summary at load (see beginEditCoreMemory's
          // _singleSentence flag). A distinct legacy element carries meaning
          // this text prompt never captured -- clobbering it on every edit
          // would corrupt the entry (and re-embed/dedupe on the clobbered
          // value). Otherwise only `summary` is sent.
          const editArgs = settingsPrompt._singleSentence
            ? { action: 'core', op: 'edit', id, project_id: projectId, element: sentence, summary: sentence }
            : { action: 'core', op: 'edit', id, project_id: projectId, summary: sentence };
          void store.memoryControl?.(editArgs, { silent: true })
            .then((result) => {
              const errText = memoryCoreResultErrorText(result);
              store.pushNotice(errText || 'core memory updated', errText ? 'error' : 'info');
              openMemoryCorePicker();
            })
            .catch((e) => {
              store.pushNotice(`core edit failed: ${e?.message || e}`, 'error');
              openMemoryCorePicker();
            });
          return true;
        }
        if (settingsPrompt.kind === 'core-delete-confirm') {
          const id = settingsPrompt._id;
          const projectId = settingsPrompt._projectId ?? 'common';
          const answer = String(commandText || '').trim().toLowerCase();
          setSettingsPrompt(null);
          if (answer !== 'y' && answer !== 'yes') {
            store.pushNotice('delete canceled', 'info');
            openMemoryCorePicker();
            return true;
          }
          void store.memoryControl?.({ action: 'core', op: 'delete', id, project_id: projectId }, { silent: true })
            .then((result) => {
              const errText = memoryCoreResultErrorText(result);
              store.pushNotice(errText || 'core memory deleted', errText ? 'error' : 'info');
              openMemoryCorePicker();
            })
            .catch((e) => {
              store.pushNotice(`core delete failed: ${e?.message || e}`, 'error');
              openMemoryCorePicker();
            });
          return true;
        }
      } catch (e) {
        store.pushNotice(`settings update failed: ${e?.message || e}`, 'error');
        return false;
      }
    }
    if (!commandText) return false;

    if (commandText.startsWith('/')) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      const [cmd, ...rest] = commandText.slice(1).split(/\s+/);
      const accepted = runSlashCommand(cmd, rest.join(' ').trim());
      if (accepted !== false) clearPastedImagesSnapshot();
      return accepted;
    }
    const imageRefs = imageReferenceIds(text);
    const imageSnapshot = Object.fromEntries(Object.entries(pastedImagesRef.current || {})
      .filter(([id]) => imageRefs.has(Number(id))));
    const hasImageSnapshot = Object.keys(imageSnapshot).length > 0;
    // Expand folded [Pasted text #N +M lines] tokens back to their original
    // text at the same point buildPromptContentWithImages runs. Broken /
    // partially-deleted tokens do not match and are left as-is.
    const textRefs = pastedTextReferenceIds(text);
    const textSnapshot = Object.fromEntries(Object.entries(pastedTextsRef.current || {})
      .filter(([id]) => textRefs.has(Number(id))));
    const hasTextSnapshot = Object.keys(textSnapshot).length > 0;
    const expandedText = hasTextSnapshot ? expandPastedTextTokens(text, textSnapshot) : text;
    const content = buildPromptContentWithImages(expandedText, imageSnapshot);
    const accepted = store.submit(content, {
      // Store the EXPANDED text in the transcript/history so a later prompt-
      // history recall resubmits the real content, not the literal token
      // (pastedTexts entries are cleared on accept). History recall therefore
      // shows the full original text instead of the token — acceptable.
      displayText: expandedText,
      pastedImages: imageSnapshot,
      pastedTexts: textSnapshot,
      onCommitted: (hasImageSnapshot || hasTextSnapshot)
        ? () => { clearPastedImagesSnapshot(imageSnapshot); clearPastedTextsSnapshot(textSnapshot); }
        : null,
    });
    if (accepted) {
      armTranscriptFollow();
      if (imageRefs.size === 0 || (!hasImageSnapshot && !state.busy)) clearPastedImagesSnapshot();
      else if (state.busy && hasImageSnapshot) clearPastedImagesSnapshot(imageSnapshot);
      if (textRefs.size === 0 || (!hasTextSnapshot && !state.busy)) clearPastedTextsSnapshot();
      else if (state.busy && hasTextSnapshot) clearPastedTextsSnapshot(textSnapshot);
    }
    return accepted;
  };

  const activeSlashQuery = providerPrompt || channelPrompt || hookPrompt || settingsPrompt || toolApproval || contextPanel || usagePanel ? null : slashQuery(promptDraft);
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
    channelPrompt: !!channelPrompt,
    hookPrompt: !!hookPrompt,
    settingsPrompt: !!settingsPrompt,
  };

  useEffect(() => {
    setSlashIndex((index) => Math.min(index, Math.max(0, slashCommands.length - 1)));
  }, [slashCommands.length, activeSlashQuery]);

  const onPromptDraftChange = useCallback((value) => {
    if (String(value ?? '').length > 0) dismissWelcomePromptHint();
    syncPromptLayoutRows(value);
    // NOTE: do NOT prune pasted-text entries on edit. A partially-edited token
    // can be undone back to its intact form, which must still expand on submit;
    // entries are kept until an accepted submit or an explicit clear. (Memory
    // cost is bounded and acceptable.)
    const suppressPromptHint = promptHistoryDraftChangeRef.current;
    promptHistoryDraftChangeRef.current = false;
    const historyNav = promptHistoryNavRef.current;
    if (!value || (historyNav.active && value !== historyNav.lastValue && value !== historyNav.seed)) {
      resetPromptHistoryNav();
    }
    // Only lift the draft into App state when it can affect the slash palette
    // (a single "/token"). Prose typing renders entirely inside PromptInput's
    // own state, so App need not re-render — and relayout the full fullscreen
    // frame — on every keystroke (input lag fix). Entering slash mode and
    // leaving it both still sync because either prev or next is a slash token.
    // Clearing/submitting must also sync so a consumed slash command does not
    // remount later as stale initialValue after a picker/panel closes.
    const nextSlash = slashQuery(value);
    setPromptDraft((prev) => {
      const previousWasSlashFlow = String(prev || '').startsWith('/');
      if (value === '') return '';
      return nextSlash !== null || previousWasSlashFlow ? value : prev;
    });
    setPromptDraftOverride((prev) => (prev === null ? prev : null));
    const argumentHint = slashArgumentHint(value);
    if (argumentHint && !suppressPromptHint) {
      showPromptHint(argumentHint, 'info');
    } else if (suppressPromptHint || promptHintActiveRef.current || promptHintTimerRef.current) {
      // Only clear when a hint is actually live (shown or pending its timer).
      // clearPromptHint() already early-returns when neither ref is set, but
      // gating the call here avoids invoking it on EVERY keystroke once a hint
      // has appeared — that call path otherwise drives a setState → full App
      // re-render per key, which is costly on long transcripts. Hint-while-
      // typing still vanishes immediately because the guard includes the active
      // state; the argumentHint branch above is untouched. The guard no longer
      // requires a non-empty value: clearing/submitting to '' must also dismiss
      // a live hint instead of leaving it until its timer expires.
      clearPromptHint();
    }
    if (slashDismissedFor) {
      setSlashDismissedFor((dismissed) => (dismissed && dismissed !== value ? '' : dismissed));
    }
  }, [clearPromptHint, dismissWelcomePromptHint, resetPromptHistoryNav, showPromptHint, slashDismissedFor, syncPromptLayoutRows]);

  const cancelProviderPrompt = useCallback(() => {
    try { providerPrompt?.login?.cancel?.(); } catch {}
    oauthSubmitRef.current = false;
    const onCancel = providerPrompt?.cancelReturn || providerPrompt?.onCancel;
    const afterSave = providerPrompt?.afterSave;
    setProviderPrompt(null);
    if (onCancel) onCancel();
    else if (afterSave) afterSave();
  }, [providerPrompt, showPromptHint]);

  const cancelChannelPrompt = useCallback(() => {
    const onCancel = channelPrompt?.onCancel;
    const afterSave = channelPrompt?.afterSave;
    setChannelPrompt(null);
    if (typeof onCancel === 'function') onCancel();
    else if (typeof afterSave === 'function') afterSave();
  }, [channelPrompt, showPromptHint]);

  const cancelHookPrompt = useCallback(() => {
    setHookPrompt(null);
  }, [showPromptHint]);

  const cancelSettingsPrompt = useCallback(() => {
    // The project entry prompts are reached from the project picker; backing out
    // (Esc) should return to that picker rather than dropping to a bare prompt.
    const kind = settingsPrompt?.kind;
    setSettingsPrompt(null);
    if (kind === 'project-new' || kind === 'project-create-confirm' || kind === 'project-rename') {
      openProjectPicker();
    } else if (kind === 'core-add' || kind === 'core-edit' || kind === 'core-delete-confirm') {
      openMemoryCorePicker();
    } else if (kind === 'autoclear-provider') {
      openAutoClearPicker({ advanced: true, returnTo: settingsPrompt?.returnTo });
    }
  }, [settingsPrompt, showPromptHint]);

  const acceptSlashPalette = useCallback((draftValue = '') => {
    const command = slashCommands[slashIndex];
    if (!command) return false;
    pickerOpenedFromEnterRef.current = true;
    if (pickerOpenedFromEnterTimerRef.current) {
      clearTimeout(pickerOpenedFromEnterTimerRef.current);
      pickerOpenedFromEnterTimerRef.current = null;
    }
    try {
      return runSlashCommand(slashCommandTokenForPaletteAccept(command, draftValue), '');
    } finally {
      pickerOpenedFromEnterTimerRef.current = setTimeout(() => {
        pickerOpenedFromEnterRef.current = false;
        pickerOpenedFromEnterTimerRef.current = null;
      }, 3000);
    }
  }, [slashCommands, slashIndex]);

  const completeSlashPalette = useCallback((draftValue = '') => {
    const command = slashCommands[slashIndex];
    if (!command) return undefined;
    const token = slashCommandTokenForPaletteAccept(command, draftValue);
    return token ? `/${token} ` : undefined;
  }, [slashCommands, slashIndex]);

  const cancelSlashPalette = useCallback((value = '') => {
    // Esc clears the slash draft, so the dismissal marker must not survive.
    // If it stays as "/" then typing "/" again is treated as the same
    // dismissed query and the palette never re-opens.
    setSlashDismissedFor('');
    setPromptDraft('');
    setPromptDraftOverride({ id: Date.now(), value: '' });
  }, []);

  const resizeEpoch = resizeState.epoch;
  // agentRevision is a cheap change-detection key for downstream consumers, but
  // JSON.stringify over the worker/job arrays ran on EVERY render (including the
  // ~120fps streaming reconciles). Memoize on the agent slices so it only
  // recomputes when agent state actually changes, not on every assistant delta.
  const agentRevision = useMemo(() => JSON.stringify({
    workers: (state.agentWorkers || []).map((w) => [w.tag, w.status, w.stage, w.sessionId]).slice(0, 20),
    jobs: (state.agentJobs || []).map((j) => [j.task_id, j.status, j.tag, j.sessionId, j.startedAt, j.finishedAt, j.error]).slice(0, 20),
  }), [state.agentWorkers, state.agentJobs]);

  // L2 statusline explore/search segments are the MAIN session's own running
  // tool cards (NOT agentWorkers/agentJobs). Derive pending counts + oldest
  // start time straight from the live transcript tool cards. A card is pending
  // until completedCount >= count. (Do NOT use completedAt as the terminal
  // signal: engine patchToolCardResult stamps completedAt on EVERY aggregate
  // result patch even while calls are still running, and reused tail-aggregates
  // keep a stale completedAt, so it would drop the segment early / skip newly
  // added pending calls.) Aggregate cards carry a `categories` map; standalone
  // cards carry name/args resolved
  // via classifyToolCategory. Keep this CHEAP: build a primitive signature from
  // only the tool items so streaming flushes that swap
  // state.items for a fresh array don't restringify the whole transcript and
  // the StatusLine effect only re-fires when the numbers actually change.
  const activeToolsSignature = useMemo(() => {
    // The engine maintains this signature incrementally (updated on tool
    // start/early-complete/result/turn-end), so App no longer scans every
    // transcript item on each change. Prefer it; fall back to the local scan
    // only when the engine did not publish it (older snapshot).
    if (state.activeToolSummary !== undefined) return state.activeToolSummary || '';
    const items = state.items || [];
    let exploreCount = 0;
    let exploreStart = 0;
    let searchCount = 0;
    let searchStart = 0;
    for (const it of items) {
      if (!it || it.kind !== 'tool') continue;
      const count = Math.max(1, Number(it.count || 1));
      // Resolved check: aggregates stay on the pure completedCount>=count test
      // because engine patchToolCardResult sets `result` on EVERY aggregate
      // patch (even partial, completedCount<count), so a `result`-aware check
      // would drop a still-running aggregate early. Standalone cards mirror
      // toolItemPendingForRows (done when completedCount>=count OR a result
      // landed) so an abnormally-finished card (cancelled/errored) that sets a
      // result without bumping completedCount cannot pin a phantom segment.
      const done = it.aggregate
        ? Number(it.completedCount || 0)
        : Math.max(0, Math.min(count, Number(it.completedCount || (it.result == null ? 0 : count))));
      if (done >= count) continue; // resolved card (matches toolItemPendingForRows)
      const started = Number(it.startedAt || 0);
      let exploreHits = 0;
      let searchHits = 0;
      if (it.aggregate && it.categories && typeof it.categories === 'object') {
        for (const v of Object.values(it.categories)) {
          const cat = v && typeof v === 'object' ? v.category : null;
          const c = Math.max(1, Number(v && typeof v === 'object' ? v.count : 1) || 1);
          if (cat === 'Explore') exploreHits += c;
          else if (cat === 'Web Research') searchHits += c;
        }
      } else if (it.name) {
        const cat = classifyToolCategory(it.name, it.args || {});
        if (cat === 'Explore') exploreHits = count;
        else if (cat === 'Web Research') searchHits = count;
      }
      if (exploreHits > 0) {
        exploreCount += exploreHits;
        if (started > 0 && (exploreStart === 0 || started < exploreStart)) exploreStart = started;
      }
      if (searchHits > 0) {
        searchCount += searchHits;
        if (started > 0 && (searchStart === 0 || started < searchStart)) searchStart = started;
      }
    }
    if (!exploreCount && !searchCount) return '';
    return `${exploreCount}:${exploreStart}:${searchCount}:${searchStart}`;
  }, [state.activeToolSummary, state.items]);

  const activeTools = useMemo(() => {
    if (!activeToolsSignature) return null;
    const [ec, es, sc, ss] = activeToolsSignature.split(':').map((n) => Number(n) || 0);
    return {
      explore: { count: ec, startedAt: es },
      search: { count: sc, startedAt: ss },
    };
  }, [activeToolsSignature]);

  // StatusLine only reads a small stats subset; engine clones the full stats
  // object on many updates. Memoize by field value so identical usage keeps
  // the same object reference and React.memo / effect deps stay quiet.
  const statuslineStats = useMemo(() => {
    const s = state.stats || {};
    return {
      currentContextSource: s.currentContextSource ?? null,
      currentEstimatedContextTokens: s.currentEstimatedContextTokens ?? 0,
      currentContextTokens: s.currentContextTokens ?? 0,
      contextTokens: s.contextTokens ?? 0,
      latestPromptTokens: s.latestPromptTokens ?? 0,
      latestInputTokens: s.latestInputTokens ?? 0,
      latestCachedTokens: s.latestCachedTokens ?? 0,
      latestCacheWriteTokens: s.latestCacheWriteTokens ?? 0,
      inputTokens: s.inputTokens ?? 0,
      cachedTokens: s.cachedTokens ?? 0,
      cacheWriteTokens: s.cacheWriteTokens ?? 0,
      promptTokens: s.promptTokens ?? 0,
      turns: s.turns ?? 0,
    };
  }, [
    state.stats?.currentContextSource,
    state.stats?.currentEstimatedContextTokens,
    state.stats?.currentContextTokens,
    state.stats?.contextTokens,
    state.stats?.latestPromptTokens,
    state.stats?.latestInputTokens,
    state.stats?.latestCachedTokens,
    state.stats?.latestCacheWriteTokens,
    state.stats?.inputTokens,
    state.stats?.cachedTokens,
    state.stats?.cacheWriteTokens,
    state.stats?.promptTokens,
    state.stats?.turns,
  ]);

  // ── Transcript viewport height ──────────────────────────────────────────
  // ROOT-CAUSE FIX: the transcript must live in a box with an EXPLICIT numeric
  // height + overflow:hidden so ink's renderer actually clips off-screen rows
  // (render-node-to-output.js → output.clip uses the box's computed height). An
  // unbounded negative-margin column inside a flexGrow box let stale rows
  // overprint newer ones across incremental redraws. We reserve the rows the
  // bottom cluster needs and give the transcript everything above it.
  //
  //   viewportHeight = rows
  //                  − welcome header  (empty transcript only)
  //                  − live status     (thinking / spinner / TurnDone)
  //                  − queued prompts  (marginTop 1 + N rows, only when queued)
  //                  − prompt meta     (spinner / transient message / queued)
  //                  − input box       (2 border + wrapped content)
  //                  − statusline      (reserved L1 + L2 + outer gap; total 3 rows)
  //
  // Every sibling outside the viewport must be accounted for here; otherwise
  // the total tree height exceeds the terminal and the input box gets pushed.
  const textEntryPrompt = providerPrompt || channelPrompt || hookPrompt || settingsPrompt;
  const hasTextEntryPrompt = !!textEntryPrompt;
  const hasFloatingPanel = !!(toolApproval || picker || contextPanel || usagePanel || slashPaletteOpen || hasTextEntryPrompt);
  const expandedOptionPanel = !!(toolApproval || picker || contextPanel || usagePanel || hasTextEntryPrompt);
  const panelTransitionForBoot = panelTransitionRef.current;
  if (panelTransitionForBoot.signature.includes('picker:project') && !picker) {
    projectBootInputLatchRef.current = true;
  }
  const bootSettling = !tuiReady && state.items.length === 0 && !hasFloatingPanel && !projectBootInputLatchRef.current;
  // Project selection (initial-entry experience) keeps the welcome banner
  // visible above the picker / path-entry prompt, unlike other floating panels.
  const projectSelectionActive = picker?.kind === 'project'
    || settingsPrompt?.kind === 'project-new'
    || settingsPrompt?.kind === 'project-create-confirm'
    || settingsPrompt?.kind === 'project-rename';
  // Slash search floats above the normal prompt. Actual option panels own the
  // prompt/status area, so they hide those rows and expand into that space.
  const inputBoxHidden = expandedOptionPanel || bootSettling;
  const showWelcomeBanner = (state.items.length === 0 && !hasFloatingPanel) || projectSelectionActive || onboardingActive;
  const WELCOME_ROWS = showWelcomeBanner ? 11 : 0;
  const liveSpinner = state.spinner?.active ? state.spinner : (state.commandStatus?.active ? state.commandStatus : null);
  // Command-status spinner (auto-clear/compact/etc.) is NOT part of the
  // spinner → TurnDone handoff: it typically starts while the transcript tail
  // is already a done row (idle session), so the done-at-tail suppression
  // below must never hide it — that read as a frozen UI during auto-clear.
  const liveSpinnerIsCommand = !state.spinner?.active && !!state.commandStatus?.active;
  const latestToast = state.toasts?.length ? state.toasts[state.toasts.length - 1] : null;
  const toastHint = latestToast ? latestToast.text : '';
  const progressHint = state.progressHint || null;
  const inputHint = promptHint || toastHint || (progressHint?.text || '');
  const inputHintTone = promptHint
    ? promptHintTone
    : (latestToast?.tone || progressHint?.tone || 'info');
  const latestTranscriptItem = state.items[state.items.length - 1] || null;
  const latestDoneAtTail = latestTranscriptItem?.kind === 'turndone' || latestTranscriptItem?.kind === 'statusdone';
  // Bottom meta band ownership is LIVE-SPINNER ONLY. A finished turn's done row
  // (turndone/statusdone) is a normal transcript item and flows into scrollback
  // like anything else, so the area directly above the prompt is CLEAR when the
  // user is idle. Earlier this row was pinned in the meta band until the next
  // transcript item was appended (to dodge an autowrap overprint/bleed), which
  // left the completed status row stuck above the prompt while the user typed or
  // sat idle. That bleed is now fixed at the source by the tool-output width
  // clamp, so the pin is no longer needed. Kept as a named null const so the
  // downstream meta-band/hint logic collapses cleanly to the spinner-only path.
  const latestDoneItem = null;
  const SCROLL_HINT_ROWS = 0;
  const LIVE_STATUS_ROWS = 0;
  // The standalone prompt box is 2 border rows + the wrapped PromptInput body.
  // The one-row scroll baseline gap ABOVE the prompt is owned by
  // transcriptGuardRows, not the prompt box itself. That keeps the scroll
  // reference at "textbox + 1" while the prompt/statusline bottom stays fixed.
  //
  // This must track the prompt draft's REAL wrapped height. Reserving a constant
  // one-line prompt lets long/multiline input grow the bottom cluster after the
  // transcript viewport has already claimed those rows, which makes transcript
  // body text overprint the textbox or slash command window.
  const currentPromptLayoutRows = promptContentRows(promptLayoutValueRef.current, promptContentColumns);
  const promptInputRows = inputBoxHidden ? 0 : currentPromptLayoutRows;
  const promptBoxRows = inputBoxHidden ? 0 : 2 + promptInputRows;
  const STATUSLINE_ROWS = 3;
  // Shared panel chrome math. Every floating panel follows the same vertical
  // rhythm INSIDE its round border: title row, blank, description/hint row,
  // blank, then content. That is 4 non-content rows; the round border adds 2
  // more, so chrome reserves 6 rows total. Reserving the full chrome here (even
  // for panels that omit the description) guarantees the bordered title can
  // never be clipped off the top — content rows shrink first when the terminal
  // is short, because the floating container clips from the top (flex-end).
  const PANEL_MAX_VISIBLE = 8;
  const PANEL_CHROME_ROWS = 6;
  const PANEL_BASE_ROWS = PANEL_MAX_VISIBLE + PANEL_CHROME_ROWS;
  const PICKER_CHROME_ROWS = PANEL_CHROME_ROWS;
  // TextEntryPanel content is one prompt line (chrome + 1) for single-line
  // prompts, or up to PANEL_MAX_VISIBLE wrapped rows for core memory add/edit.
  // PLUS an optional wrapped detail block (blank spacer + N wrapped rows — e.g.
  // the manual OAuth URL). The floating container clips from the TOP (flex-end +
  // overflow hidden), so under-reserving here pushed the bordered title off
  // the top of the panel. Width matches the panel interior: frame − 2 border
  // − 2 paddingX, same wrap-ansi math ink uses for wrap="wrap".
  const textEntryKind = String(textEntryPrompt?.kind || '');
  const textEntryMultiline = CORE_MULTILINE_TEXT_ENTRY_KINDS.has(textEntryKind);
  const textEntryDetailText = String(textEntryPrompt?.detail || '').trim();
  const textEntryDetailRows = textEntryDetailText
    ? 1 + wrappedDetailRows(textEntryDetailText, Math.max(1, frameColumns - 4))
    : 0;
  const textEntryContentRows = textEntryMultiline ? textEntryLayoutRows : 1;
  const TEXT_ENTRY_ROWS = PANEL_CHROME_ROWS + textEntryContentRows + textEntryDetailRows;
  const OPTION_PANEL_EXTRA_ROWS = expandedOptionPanel ? 3 : 0;
  const queuedVisible = !hasFloatingPanel && !inputBoxHidden && state.queued?.length > 0;
  // While the slash palette is open it owns the area above the prompt, so the
  // live spinner/meta row is suppressed entirely — no reservation and no render.
  // Normalize the spinner → TurnDone handoff by making them occupy the SAME
  // two-row slot. Engine appends turndone/statusdone before clearing spinner, so
  // a transient frame can otherwise contain BOTH: transcript grows by two rows
  // while the bottom spinner still reserves two rows, making the viewport visibly
  // jump. As soon as the done row is the transcript tail, drop the spinner slot;
  // the new done row replaces that height in the same frame, with no ms timer.
  const promptMetaVisible = !inputBoxHidden && !slashPaletteOpen && !!liveSpinner
    && (liveSpinnerIsCommand || !latestDoneAtTail);
  const promptMetaRows = promptMetaVisible ? 2 : 0;
  // Toast/error text without a live spinner uses the existing transcript guard
  // row directly above the prompt. Do NOT reserve another row here: that made a
  // transient hint add a visible newline/prompt jump whenever no spinner was
  // active.
  const overlayHintRequested = !inputBoxHidden && !hasFloatingPanel && !liveSpinner && !!inputHint && !queuedVisible;
  const overlayHintRows = 0;
  // QueuedCommands renders each queued command at its FULL wrapped height
  // (same content width the promoted transcript user row wraps at), pinned
  // above the prompt box with no extra top-margin row. Reserving the true
  // height keeps promotion from re-expanding the text mid-flight ("row jump").
  // If the whole queue would eat too much of the frame, fall back to the old
  // compact 1-row-per-entry truncation so the input box never leaves screen.
  const queuedFullRows = queuedVisible
    ? state.queued.reduce(
      (sum, item) => sum + queuedBandRows(String(item.displayText || item.text || ''), Math.max(1, frameColumns - 4)),
      0,
    )
    : 0;
  const queuedRowBudget = Math.max(3, Math.floor(resizeState.rows / 3));
  const queuedCompact = queuedFullRows > queuedRowBudget;
  const queuedRows = queuedVisible ? (queuedCompact ? state.queued.length : queuedFullRows) : 0;
  const INPUT_BOX_ROWS = promptBoxRows + promptMetaRows + overlayHintRows;
  const baseReserve = WELCOME_ROWS + SCROLL_HINT_ROWS + LIVE_STATUS_ROWS + INPUT_BOX_ROWS + STATUSLINE_ROWS + queuedRows;
  const maxFloatingPanelRows = Math.max(0, resizeState.rows - baseReserve - 1);
  const desiredFloatingPanelRows = toolApproval
    ? PANEL_CHROME_ROWS + 2 + OPTION_PANEL_EXTRA_ROWS
    : picker
      ? (picker.fillAvailable ? maxFloatingPanelRows : PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS)
      : contextPanel
      ? PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS + 3
      : usagePanel
        ? PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS
        : slashPaletteOpen
          ? PANEL_MAX_VISIBLE + PANEL_CHROME_ROWS
          : hasTextEntryPrompt
            ? TEXT_ENTRY_ROWS
            : 0;
  const floatingPanelRows = desiredFloatingPanelRows > 0
    ? Math.min(desiredFloatingPanelRows, maxFloatingPanelRows)
    : 0;
  // Give the list every content row the panel exposes. The panel already grew
  // by OPTION_PANEL_EXTRA_ROWS; previously that growth was subtracted back out
  // here, so the rows leaked into an empty flexGrow gap instead of the list.
  // Reserving only PICKER_CHROME_ROWS lets the list occupy the full interior
  // (the footer's own reservation is handled inside Picker).
  const pickerVisibleRows = picker
    ? Math.max(1, floatingPanelRows - PICKER_CHROME_ROWS)
    : PANEL_MAX_VISIBLE;
  const rawBottomReserve = baseReserve + floatingPanelRows;
  const bottomClusterRows = INPUT_BOX_ROWS + STATUSLINE_ROWS + queuedRows + floatingPanelRows;
  const panelLayoutSignature = [
    toolApproval ? 'tool' : '',
    picker ? `picker:${picker.kind || ''}:${picker.fillAvailable ? 'fill' : 'fit'}` : '',
    contextPanel ? 'context' : '',
    usagePanel ? 'usage' : '',
    slashPaletteOpen ? 'slash' : '',
    hasTextEntryPrompt ? `text:${textEntryPrompt?.kind || ''}` : '',
    inputBoxHidden ? 'input-hidden' : 'input-visible',
    floatingPanelRows,
    promptBoxRows,
    promptMetaRows,
    queuedRows,
    WELCOME_ROWS,
  ].join('|');
  const panelTransition = panelTransitionRef.current;
  const panelLayoutChanged = Boolean(panelTransition.signature && panelTransition.signature !== panelLayoutSignature);
  let panelTransitionClearRows = 0;
  let panelTransitionGuardRows = 0;
  if (panelLayoutChanged) {
    const panelShrinkRows = Math.max(0, panelTransition.reserve - bottomClusterRows);
    const initialProjectEntryClose = state.items.length === 0;
    // Prompt-row-only churn (promptBoxRows/promptMetaRows/queuedRows shifting
    // while no panel opened/closed/changed kind and floatingPanelRows itself is
    // unchanged — see PANEL_KIND_TOKEN_COUNT) must not fall into the clearRows
    // + setTimeout recommit path below: that inserts a full extra blank row for
    // one commit, which IS the newline-add/remove jolt while typing. Route a
    // shrink here through the same one-commit ink-mask path as an instant panel
    // close so the stale row is masked in the very commit it disappears; growth
    // already needs no clearance (panelShrinkRows is 0 in that case).
    const promptRowsOnlyChange = panelShrinkRows > 0
      && panelKindSignature(panelTransition.signature) === panelKindSignature(panelLayoutSignature);
    // Turn-end spinner meta collapse: the 2-row live-spinner band disappears in
    // the SAME commit the engine appends the turndone/statusdone tail (see
    // engine.mjs runTurn — turndone + spinner:null land in one set()). That new
    // done row already replaces the vacated height, so masking those rows blank
    // for one commit only to clear them on the next commit IS the visible
    // transcript bounce. Exempt exactly the meta-collapse rows from the ink mask
    // when the done row is the transcript tail. Every other prompt-row-only
    // shrink (typing newline removal, queued-row churn) AND the reclaimed/no-op
    // path (engine.mjs skips turndone, so latestDoneAtTail stays false and no
    // row replaces the height) keep the mask so they still reclaim smoothly.
    const prevMetaRows = Number(String(panelTransition.signature).split('|')[PANEL_LAYOUT_SIG.PROMPT_META]) || 0;
    const nextMetaRows = Number(String(panelLayoutSignature).split('|')[PANEL_LAYOUT_SIG.PROMPT_META]) || 0;
    // Require the done row to have been appended in THIS commit (tail id changed
    // since the last commit). A command spinner can leave a STALE done row at the
    // tail and then clear without appending statusdone (e.g. /recall — see
    // engine.mjs), collapsing the meta band with NO same-commit backfill; masking
    // must stay on for that path or the vacated rows overpaint the stale row.
    const doneTailAppendedThisCommit = latestDoneAtTail
      && (latestTranscriptItem?.id ?? null) !== panelTransition.tailId;
    const spinnerMetaCollapseRows = doneTailAppendedThisCommit
      ? Math.max(0, prevMetaRows - nextMetaRows)
      : 0;
    // Queued-band promotion: drain() removes the queued band and appends the
    // promoted user transcript row in the SAME commit (session-flow.mjs drain
    // → pushUserOrSyntheticItem → runTurn spinner, one microtask flush). The
    // new user row (full wrapped height + margin) already backfills the
    // vacated band rows, so masking them blank for one commit only to drop
    // the mask on the next commit made the whole transcript bounce down.
    // Exempt exactly the vacated queued rows when a user row landed at the
    // tail in this commit; queue edits/removals without a tail append (tail
    // id unchanged, or non-user tail) keep the mask.
    const prevQueuedSigRows = Number(String(panelTransition.signature).split('|')[PANEL_LAYOUT_SIG.QUEUED]) || 0;
    const nextQueuedSigRows = Number(String(panelLayoutSignature).split('|')[PANEL_LAYOUT_SIG.QUEUED]) || 0;
    const userTailAppendedThisCommit = latestTranscriptItem?.kind === 'user'
      && (latestTranscriptItem?.id ?? null) !== panelTransition.tailId;
    const queuedPromoteCollapseRows = userTailAppendedThisCommit
      ? Math.max(0, prevQueuedSigRows - nextQueuedSigRows)
      : 0;
    const instantPanelClose = panelShrinkRows > 0
      && (promptRowsOnlyChange
        || isInstantPanelCloseTransition(panelTransition.signature, panelLayoutSignature, initialProjectEntryClose));
    // Slash palette opening on the empty welcome screen: bottomReserve already
    // grows to its final size in this same commit (floatingPanelRows reflects
    // slashPaletteOpen immediately, no clearRows needed), but the renderer can
    // still overpaint the just-vacated transcript row for one commit. Borrow
    // the transitional guard-row mechanism (normally used for tall panel
    // closes below) for exactly one commit on the open transition itself —
    // this only carves an extra blank row out of transcriptContentHeight, it
    // does not touch bottomReserve/floatingPanelRows/palette height.
    const slashOpenOnEmptyTranscript = initialProjectEntryClose
      && !panelSignatureFlags(panelTransition.signature).slash
      && panelSignatureFlags(panelLayoutSignature).slash;
    if (instantPanelClose) {
      // Slash palette and initial project-entry closes land on the final bottom
      // reserve in one commit. Paint reclaimed rows as a blank mask band below
      // the transcript clip instead of inflating bottomReserve + reclaiming on
      // the next tick. Subtract any turn-end spinner-meta rows that the same-
      // commit done tail already backfills (spinnerMetaCollapseRows) so that
      // transition masks nothing and does not bounce; same for queued-band
      // rows backfilled by a just-promoted user row (queuedPromoteCollapseRows).
      panelCloseInkMaskRowsRef.current = Math.max(0, panelShrinkRows - spinnerMetaCollapseRows - queuedPromoteCollapseRows);
      panelTransition.clearRows = 0;
      panelTransition.guardRows = 0;
      panelTransition.epoch = panelTransitionEpoch;
    } else if (slashOpenOnEmptyTranscript) {
      panelTransitionClearRows = 0;
      panelTransitionGuardRows = 1;
      panelTransition.clearRows = 0;
      panelTransition.guardRows = 1;
      panelTransition.epoch = panelTransitionEpoch;
    } else {
      // Tall panel closes must land on the final bottom reserve in the same
      // commit. Inflating bottomReserve with temporary clearance makes the
      // transcript/prompt area move once, then snap back on the timer commit.
      // Instead, keep the reclaimed rows inside the fixed viewport as a blank
      // one-frame mask, matching the instant-close path above.
      panelCloseInkMaskRowsRef.current = panelShrinkRows;
      panelTransition.clearRows = 0;
      panelTransition.guardRows = 0;
      panelTransition.epoch = panelTransitionEpoch;
    }
  } else if (panelTransition.epoch === panelTransitionEpoch) {
    panelTransitionClearRows = panelTransition.clearRows || 0;
    panelTransitionGuardRows = panelTransition.guardRows || 0;
  }
  if (desiredFloatingPanelRows > 0) {
    panelCloseInkMaskRowsRef.current = 0;
  }
  void panelInkMaskEpoch;
  const panelCloseInkMaskRows = desiredFloatingPanelRows > 0 ? 0 : panelCloseInkMaskRowsRef.current;
  const bottomReserve = rawBottomReserve + panelTransitionClearRows;
  const viewportHeight = Math.max(1, resizeState.rows - bottomReserve);
  // Keep one physical row between the transcript clip and the bottom cluster
  // even when pinned to the live tail. Windows Terminal/conhost can still
  // surface one clipped/off-by-one transcript row below the statusline during
  // rapid tool-card updates; a permanent guard row makes that row blank instead
  // of a tool header/detail.
  const guardCapacityRows = Math.max(0, viewportHeight - 1);
  const baseGuardRows = guardCapacityRows > 0 ? 1 : 0;
  // ── Scroll-time overprint guard ───────────────────────────────────────────
  // Wheel/manual scroll pushes the transcript column DOWN via a negative
  // marginBottom (see the viewport render). Under conhost/Windows Terminal the
  // incremental redraw can leave the row that slid past the clip edge painted
  // OVER the bottom cluster (input box / statusline) for a frame — the reported
  // "scrolled text shows on the statusline row" bug. One guard row is enough
  // while pinned to the live tail, but during an active scroll the slid row can
  // still bleed one line further, so widen the guard to TWO rows whenever the
  // viewport is genuinely scrolled up. The extra blank row absorbs the stray
  // paint instead of the statusline. Requires a viewport tall enough to spare
  // the row, and never shrinks below the base guard.
  // Gate on the same follow-aware basis the transcript window uses for
  // renderScrollOffset (see use-transcript-window.mjs targetNearBottom): the
  // live `scrollOffset` state can still read >0 for one frame after a wheel
  // turn re-arms bottom-follow, while this same frame already renders with
  // renderScrollOffset=0. Without this, the stale offset shrinks
  // transcriptContentHeight by one row that never actually gets rendered,
  // producing a one-row bounce that snaps back once state catches up.
  // [2026-07-06] Scroll-time extra guard DISABLED: the widened (2-row) guard
  // rendered as a visibly empty band between the transcript and the prompt box
  // whenever the viewport was scrolled up (user-reported "bottom rows look
  // blank while scrolling"). The base 1-row guard below stays; if the
  // scrolled-row-over-statusline overpaint resurfaces, fix it in the renderer
  // diff (clip/erase) instead of carving more blank viewport rows.
  const scrollGuardRows = 0;
  const transcriptGuardRows = Math.min(guardCapacityRows, baseGuardRows + panelTransitionGuardRows + scrollGuardRows);
  // Welcome prompt hint: a one-row band rendered INSIDE the transcript
  // viewport (as a sibling below the content clip), so it must be part of the
  // viewport row accounting computed right below. Left unaccounted, the slash
  // palette close commit on the empty welcome screen painted one extra
  // physical row (hint reappears in the same commit as the close mask), so
  // the prompt box + statusline dipped one row and snapped back on the
  // mask-clear commit.
  const welcomePromptHintText = conditionalWelcomePromptHint || welcomePromptHintRef.current || '';
  const welcomePromptHintVisible = Boolean(
    welcomePromptHintText
    && !welcomePromptHintDismissed
    && state.items.length === 0
    && !hasFloatingPanel
    && !inputBoxHidden
    && !queuedVisible
    && !liveSpinner
    && !inputHint
  );
  // Tiny terminals: guard rows can already consume all but one viewport row
  // (guardCapacityRows = viewportHeight - 1). transcriptContentHeight clamps
  // to >= 1, so an unconditional hint row would paint viewportHeight + 1 rows
  // and push the prompt/statusline down. The hint yields unless at least one
  // content row remains beside it.
  const welcomePromptHintRows = welcomePromptHintVisible
    && (viewportHeight - transcriptGuardRows) >= 2 ? 1 : 0;
  welcomePromptHintVisibleRef.current = welcomePromptHintRows > 0;
  // Transient hint/error on the EMPTY transcript: the guard row sits directly
  // above the prompt box, so painting the hint there hugs the textbox one row
  // below where the live-spinner line renders. Carve one in-viewport row ABOVE
  // the guard row instead so the hint's baseline matches the spinner row (two
  // rows above the box, guard row stays blank as the spacer). This is an
  // in-viewport carve like welcomePromptHintRows — bottomReserve is untouched,
  // so the prompt box and statusline never move. Non-empty transcripts keep the
  // existing attach-to-last-item / guard-row fallback placements.
  const overlayHintBandRows = overlayHintRequested
    && state.items.length === 0
    && (viewportHeight - transcriptGuardRows - welcomePromptHintRows) >= 2 ? 1 : 0;
  // Instant panel close (slash palette): the reclaimed rows stay blank for
  // exactly one commit via panelCloseMaskRows. The mask MUST be part of this
  // frame's row accounting — subtract it from the transcript content height
  // and render it as a sibling band below the content clip (where the closed
  // panel's ink was). Rendering it inside the scrolled transcript column made
  // the painted column taller than the accounted viewport for one frame, so
  // the prompt/statusline dropped a row and snapped back on the mask-clear
  // commit (the "textbox dips when the slash palette closes" bug).
  const panelCloseMaskRows = Math.min(
    panelCloseInkMaskRows,
    Math.max(0, viewportHeight - transcriptGuardRows - welcomePromptHintRows - overlayHintBandRows - 1),
  );
  const transcriptContentHeight = Math.max(
    1,
    viewportHeight - transcriptGuardRows - panelCloseMaskRows - welcomePromptHintRows - overlayHintBandRows,
  );
  // Bottom-follow / pin semantics must NOT widen with the scroll-time guard, or
  // the "pinned to tail" threshold would drift and streaming could freeze a row
  // above bottom. Keep the slack anchored to the BASE (single) guard: if a stale
  // pre-guard offset of 1 survives while no reading anchor is active, still treat
  // the viewport as pinned to the live tail so streaming/tool output continues
  // to auto-follow instead of freezing one row above bottom.
  const transcriptBottomSlackRows = Math.max(0, baseGuardRows);
  transcriptBottomSlackRowsRef.current = transcriptBottomSlackRows;
  transcriptViewportRef.current = {
    top: WELCOME_ROWS,
    bottom: Math.max(WELCOME_ROWS, WELCOME_ROWS + transcriptContentHeight - 1),
  };
  // [mixdog] Keep the live terminal row count current for the mouse handler's
  // region routing + status-band selection clip (see onData).
  frameRowsRef.current = Math.max(1, Number(resizeState.rows) || 24);
  // When the prompt box is hidden (floating panel / option panel owns the
  // bottom area), drop its stale measured rect so the mouse handler does not
  // route presses to a prompt box that is not on screen.
  if (inputBoxHidden) promptBoxRectRef.current = null;
  // Toast/error text has two mutually exclusive placements:
  // - while a live status row exists (thinking/compacting/responding), attach it
  //   to that row so the bottom cluster reserves exactly one status band;
  // - otherwise render it into the normal one-row gap above the prompt, replacing
  //   the blank spacer instead of reserving an extra row. This keeps late errors
  //   from pushing the prompt/statusline upward, and when thinking starts the
  //   hint moves into the live row on the same render instead of double-painting.
  // Transient hint placement while no spinner owns the band is resolved after
  // transcript windowing (see overlayHintOnLastItem / overlayHintFallbackRow).
  const spinnerHintWidth = inputHint
    ? Math.max(1, Math.min(Math.max(1, frameColumns - 4), Math.max(12, Math.floor(frameColumns * 0.42))))
    : 0;
  // When no live spinner owns a status band, the transient hint/error is drawn
  // into the existing transcript guard row directly above the prompt. Mirror the
  // spinner-row placement: a fixed-width right slot, not a full-width left box.
  const guardHintWidth = inputHint
    ? Math.max(1, Math.min(Math.max(1, frameColumns - 4), Math.max(12, Math.floor(frameColumns * 0.42))))
    : 0;
  const transientStatusWidth = liveSpinner ? spinnerHintWidth : guardHintWidth;
  const promptSpinnerColumns = liveSpinner && inputHint
    ? Math.max(1, frameColumns - spinnerHintWidth - 1)
    : frameColumns;
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
    items: state.items,
    structureRevision: state.structureRevision,
    streamingTail: state.streamingTail,
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
    if (slashPaletteOpen || toolApproval || picker || settingsPrompt || providerPrompt || channelPrompt || hookPrompt || contextPanel || usagePanel) return true;
    const repeatGuardMs = 300;
    const cycleGuard = workflowTabCycleRef.current;
    const now = Date.now();
    if (state.commandBusy || cycleGuard.pending || now - cycleGuard.lastAt < repeatGuardMs) {
      cycleGuard.lastAt = now;
      return true;
    }
    cycleGuard.lastAt = now;
    let workflows = [];
    try {
      workflows = store.listWorkflows?.() || [];
    } catch (e) {
      store.pushNotice(`could not list workflows: ${e?.message || e}`, 'error');
      return true;
    }
    if (!workflows.length) {
      store.pushNotice('no workflows available', 'warn');
      return true;
    }
    const workflow = state.workflow || {};
    if (workflows.length < 2) {
      store.pushNotice(`Workflow: ${workflowDisplayName(workflows[0] || workflow)}`, 'info');
      return true;
    }
    const activeIndex = workflows.findIndex((item) => item.active);
    const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(0, workflows.findIndex((item) => item.id === workflow.id));
    const next = workflows[(currentIndex + 1 + workflows.length) % workflows.length];
    cycleGuard.pending = true;
    void Promise.resolve()
      .then(() => store.setWorkflow?.(next.id))
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
  }, [slashPaletteOpen, toolApproval, picker, settingsPrompt, providerPrompt, channelPrompt, hookPrompt, contextPanel, usagePanel, state.commandBusy, state.workflow, store]);
  // The hardware/IME caret is parked by PromptInput from its OWN measured box
  // position (ink useCursor + useBoxMetrics) — correct now that the transcript
  // is a live column, so the live-frame line count ink relies on is accurate.
  const promptInputControl = (
    <PromptInput
      onSubmit={onSubmit}
      disabled={exiting || !!picker || !!toolApproval || !tuiReady}
      onDraftChange={onPromptDraftChange}
      interruptActive={state.busy}
      onInterrupt={handlePromptInterrupt}
      initialValue={promptDraft}
      draftOverride={promptDraftOverride}
      valueRef={promptValueRef}
      selectionRef={promptSelectionRef}
      boxRectRef={promptBoxRectRef}
      mouseSelectionRef={promptMouseSelectionRef}
      suppressShiftNavRef={gridSelectionActiveRef}
      hint=""
      hintTone={inputHintTone}
      mask={false}
      onEscape={handlePromptEscape}
      onTab={cycleWorkflowFromPrompt}
      onPasteText={handlePromptPaste}
      onHistoryNavigate={handlePromptHistoryNavigate}
      // Palette stays MOUNTED with 0 matches (stable height, no flicker), but
      // key capture (Enter/arrows/Esc routing) only engages when a command can
      // actually be accepted — otherwise Enter must submit the raw text as
      // before instead of dead-ending in the palette accept path.
      commandPaletteActive={slashPaletteOpen && slashCommands.length > 0}
      onCommandPaletteNavigate={(direction) => {
        setSlashIndex((index) => {
          const total = slashCommands.length;
          if (total === 0) return 0;
          if (direction === 'home') return 0;
          if (direction === 'end') return total - 1;
          const step = direction === 'left'
            ? -1
            : direction === 'right'
              ? 1
              : Number(direction) || 0;
          if (step === 1 || step === -1) return (index + step + total) % total;
          return Math.max(0, Math.min(total - 1, index + step));
        });
      }}
      onCommandPaletteAccept={acceptSlashPalette}
      onCommandPaletteCancel={cancelSlashPalette}
      onCommandPaletteComplete={completeSlashPalette}
      onRestoreQueued={(currentText) => restoreQueuedToPrompt({ restoreDraft: true, showHint: false, currentText })}
    />
  );

  return (
    // Fullscreen layout: a full-height column (height = terminal rows) pins the
    // input cluster + statusline to the physical bottom (flexShrink={0}), while
    // the transcript fills the space above and is bottom-aligned so messages
    // stack up from just over the input. A top flexGrow spacer sinks the whole
    // stack to the bottom; the transcript itself is a fixed-height clipping
    // viewport (see viewportHeight above).
    <Box flexDirection="column" width={frameColumns} height={resizeState.rows} backgroundColor={surfaceBackground()}>
      {/* Empty-transcript header stays outside the bottom-anchored viewport and
          has its own reserved rows, so it cannot steal space from the input. */}
      {showWelcomeBanner ? (
        <Box flexDirection="column" height={7} flexShrink={0} marginTop={3} marginBottom={1} backgroundColor={surfaceBackground()}>
          <Text color={theme.text} bold>{centerLine('███╗   ███╗██╗██╗  ██╗██████╗  ██████╗  ██████╗ ', frameColumns)}</Text>
          <Text color={theme.text} bold>{centerLine('████╗ ████║██║╚██╗██╔╝██╔══██╗██╔═══██╗██╔════╝ ', frameColumns)}</Text>
          <Text color={theme.logo ?? theme.claude} bold>{centerLine('██╔████╔██║██║ ╚███╔╝ ██║  ██║██║   ██║██║  ███╗', frameColumns)}</Text>
          <Text color={theme.logo ?? theme.claude} bold>{centerLine('██║╚██╔╝██║██║ ██╔██╗ ██║  ██║██║   ██║██║   ██║', frameColumns)}</Text>
          <Text color={theme.logo ?? theme.claude} bold>{centerLine('██║ ╚═╝ ██║██║██╔╝ ██╗██████╔╝╚██████╔╝╚██████╔╝', frameColumns)}</Text>
          <Box height={1} flexShrink={0} />
          <Text color={theme.inactive}>{centerLine(`mixdog coding agent · v${localPackageVersion()} · ${state.cwd}`, frameColumns, 4)}</Text>
        </Box>
      ) : null}

      {/* Transcript viewport — a BOUNDED, fixed-height clipping box. The explicit
          numeric height + overflow:hidden is what lets ink actually slice the
          off-screen rows (output.clip in render-node-to-output.js), so older
          rows can never overprint newer ones. justifyContent flex-end keeps the
          newest content pinned to the bottom edge; older content overflows the
          TOP and is clipped. flexShrink lets it yield rows to the live status /
          a multi-line input rather than overflow the screen. */}
      <Box
        flexDirection="column"
        width="100%"
        height={viewportHeight}
        flexGrow={0}
        flexShrink={1}
        overflow="hidden"
        justifyContent="flex-end"
      >
        <Box
          flexDirection="column"
          width="100%"
          height={transcriptContentHeight}
          flexShrink={0}
          overflow="hidden"
          justifyContent="flex-end"
        >
        {/* Wheel scroll: with the viewport bottom-anchored (flex-end), a NEGATIVE
            marginBottom pushes the transcript column DOWN past the bottom edge,
            bringing older content above the window into view (overflow hidden
            clips the newest rows that slide below). 0 = newest content pinned to
            the bottom. (marginTop has no effect under flex-end — the bottom edge
            stays fixed — so the scroll axis here is marginBottom, not marginTop.)
            scrollOffset is clamped ≥ 0 by the wheel handler; a new turn snaps it
            back to 0. */}
        <Box flexDirection="column" width="100%" flexShrink={0} marginBottom={-transcriptWindow.effectiveScrollOffset}>
           {/*
             * Transcript windowing: render only the rows around the viewport rather
             * than the full state.items list. A cheap bottom spacer preserves the
             * same scroll coordinate when the visible window is in older history;
             * items above the window are off-screen and omitted entirely.
             * MAX cap: TRANSCRIPT_WINDOW_MAX_ITEMS items (env MIXDOG_TUI_TRANSCRIPT_WINDOW_ITEMS).
             * OVERSCAN: TRANSCRIPT_WINDOW_OVERSCAN_ROWS extra rows above the viewport so
             * fast wheel scrolls don't show a blank gap before re-render.
             */}
           {renderedTranscriptItems.map((item, i, arr) => {
             const measureRef = transcriptMeasureRef(item);
             const attachOverlayHint = overlayHintOnLastItem && i === overlayHintAttachItemIndex;
             const itemNode = (
               <Item
                 item={item}
                 prevKind={i > 0 ? arr[i - 1].kind : state.items[transcriptWindow.startIndex - 1]?.kind ?? null}
                 columns={frameColumns}
                 toolOutputExpanded={toolOutputExpanded}
                 rightMessage={attachOverlayHint ? inputHint : ''}
                 rightTone={attachOverlayHint ? inputHintTone : 'info'}
                 rightMessageWidth={attachOverlayHint ? (guardHintWidth || transientStatusWidth || 24) : 24}
                 themeEpoch={state.themeEpoch || 0}
               />
             );
             // When measured-rows is on, wrap each row in a zero-cost flex column
             // whose ref exposes the row's REAL Yoga height to the harvest effect.
             // The wrapper adds no rows of its own (it shrink-wraps the child) and
             // is omitted entirely when the feature is disabled so the default
             // render tree is byte-for-byte unchanged on the off path.
             return measureRef ? (
               <Box key={item.id} ref={measureRef} flexDirection="column" flexShrink={0}>
                 {itemNode}
               </Box>
             ) : (
               <React.Fragment key={item.id}>{itemNode}</React.Fragment>
             );
           })}
           {transcriptWindow.bottomSpacerRows > 0 ? (
             <Box height={transcriptWindow.bottomSpacerRows} flexShrink={0} />
           ) : null}
        </Box>
        </Box>
        {welcomePromptHintRows > 0 ? (
          <Box height={1} flexShrink={0} width="100%" overflow="hidden">
            <Text color={theme.inactive} wrap="truncate">{centerLine(welcomePromptHintText, frameColumns, 2)}</Text>
          </Box>
        ) : null}
        {panelCloseMaskRows > 0 ? (
          <Box
            height={panelCloseMaskRows}
            flexShrink={0}
            width="100%"
            overflow="hidden"
            backgroundColor={surfaceBackground()}
          />
        ) : null}
        {overlayHintBandRows > 0 ? (
          <Box height={1} flexShrink={0} backgroundColor={surfaceBackground()} flexDirection="row" width="100%" overflow="hidden">
            <Box flexGrow={1} flexShrink={1} overflow="hidden" />
            <Box flexShrink={0} width={guardHintWidth || 1} marginLeft={1} marginRight={1} justifyContent="flex-end" overflow="hidden">
              <Text color={promptStatusColor(inputHintTone)} wrap="truncate">{inputHint}</Text>
            </Box>
          </Box>
        ) : null}
        {transcriptGuardRows > 0 ? (
          <Box height={transcriptGuardRows} flexShrink={0} backgroundColor={surfaceBackground()} flexDirection="row" width="100%" overflow="hidden">
            <Box flexGrow={1} flexShrink={1} overflow="hidden" />
            {overlayHintFallbackRow && overlayHintBandRows === 0 ? (
              <Box flexShrink={0} width={guardHintWidth || 1} marginLeft={1} marginRight={1} justifyContent="flex-end" overflow="hidden">
                <Text color={promptStatusColor(inputHintTone)} wrap="truncate">{inputHint}</Text>
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>

      {/* Live reasoning and transient status live just above the prompt: reasoning
          on the left, short-lived copy/error/info messages on the right. */}

      {/* Bottom bar — pinned to the physical bottom, never moves. Floating
          panels use their actual rendered height and shrink before the prompt
          can move; overflow is clipped from the top while the panel remains
          bottom-aligned against the prompt. */}
      <Box flexDirection="column" flexShrink={0} width="100%" backgroundColor={surfaceBackground()}>
        {panelTransitionClearRows > 0 ? (
          <Box height={panelTransitionClearRows} flexShrink={0} width="100%" overflow="hidden" backgroundColor={surfaceBackground()} />
        ) : null}
        {floatingPanelRows > 0 ? (
          <Box flexDirection="column" flexShrink={0} height={floatingPanelRows} overflow="hidden" justifyContent="flex-end" backgroundColor={surfaceBackground()}>
            {toolApproval ? (
              <Picker
                items={[
                  { value: 'deny', label: 'Deny', marker: '×', markerColor: theme.error, description: 'block this tool call' },
                  { value: 'approve', label: 'Approve once', marker: '✓', markerColor: theme.success, description: 'run this tool call' },
                ]}
                onSelect={(value) => {
                  store.resolveToolApproval?.(toolApproval.id, {
                    approved: value === 'approve',
                    reason: value === 'approve' ? 'approved by user' : 'denied by user',
                  });
                }}
                onCancel={() => {
                  store.resolveToolApproval?.(toolApproval.id, { approved: false, reason: 'denied by user' });
                }}
                onKey={(input) => {
                  const value = String(input || '').trim().toLowerCase();
                  if (value === 'a' || value === 'y') {
                    store.resolveToolApproval?.(toolApproval.id, { approved: true, reason: 'approved by user' });
                  } else if (value === 'd' || value === 'n') {
                    store.resolveToolApproval?.(toolApproval.id, { approved: false, reason: 'denied by user' });
                  }
                }}
                title="Tool approval"
                description={toolApprovalDescription(toolApproval)}
                help="↑/↓ Select · Enter Choose · a/y Approve · d/n/Esc Deny"
                columns={frameColumns}
                labelWidth={18}
                initialIndex={0}
                indexMode="never"
                visibleCount={2}
                fillHeight={expandedOptionPanel}
              />
            ) : picker ? (
              <Picker
                key={picker.pickerKey}
                items={picker.items}
                onSelect={(value, item) => {
                  pickerOpenedFromEnterRef.current = true;
                  if (pickerOpenedFromEnterTimerRef.current) {
                    clearTimeout(pickerOpenedFromEnterTimerRef.current);
                    pickerOpenedFromEnterTimerRef.current = null;
                  }
                  try {
                    if (picker.onSelect) picker.onSelect(value, item);
                  } finally {
                    pickerOpenedFromEnterTimerRef.current = setTimeout(() => {
                      pickerOpenedFromEnterRef.current = false;
                      pickerOpenedFromEnterTimerRef.current = null;
                    }, 3000);
                  }
                }}
                onCancel={() => {
                  if (picker.onCancel) picker.onCancel();
                  else {
                    setPicker(null);
                    clearPromptHint();
                  }
                }}
                onLeft={picker.onLeft}
                onRight={picker.onRight}
                onTab={picker.onTab}
                onKey={picker.onKey}
                onHighlight={picker.onHighlight}
                title={picker.title}
                description={picker.description}
                footer={picker.footer}
                footerGapRows={picker.footerGapRows}
                help={picker.help}
                columns={frameColumns}
                labelWidth={picker.labelWidth}
                metaWidth={picker.metaWidth}
                initialIndex={picker.initialIndex}
                indexMode={picker.indexMode}
                visibleCount={pickerVisibleRows}
                fillHeight={expandedOptionPanel}
                themeEpoch={state.themeEpoch || 0}
                confirmBar={picker.confirmBar}
              />
            ) : contextPanel ? (
              <ContextPanel
                rows={contextPanel.rows}
                title={contextPanel.title}
                detail={contextPanel.detail}
                columns={frameColumns}
                fillHeight={expandedOptionPanel}
              />
            ) : usagePanel ? (
              <UsagePanel
                dashboard={usagePanel}
                columns={frameColumns}
                fillHeight={expandedOptionPanel}
                panelRows={floatingPanelRows}
              />
            ) : slashPaletteOpen ? (
              <SlashCommandPalette
                commands={slashCommands}
                selectedIndex={slashIndex}
                title="Commands"
                columns={frameColumns}
                query={activeSlashQuery}
              />
            ) : providerPrompt ? (
              <TextEntryPanel
                title={providerPrompt.kind === 'api-key'
                  ? `${providerPrompt.mode === 'replace' ? 'Replace' : 'Set'} API key · ${providerPrompt.label}`
                  : providerPrompt.kind === 'oauth-code'
                    ? providerPrompt.label
                    : providerPrompt.kind === 'openai-usage-session'
                      ? 'OpenAI Usage · Session Key'
                      : `Base URL · ${providerPrompt.label}`}
                hint={providerPrompt.kind === 'api-key'
                  ? [
                    providerPrompt.envName ? `Env: ${providerPrompt.envName}` : '',
                    providerPrompt.source ? `Current: ${providerPrompt.source}` : '',
                    'Stored in the OS keychain.',
                  ].filter(Boolean).join(' · ')
                  : providerPrompt.kind === 'oauth-code'
                    ? (providerPrompt.hint || 'Paste the browser code.')
                    : providerPrompt.kind === 'openai-usage-session'
                      ? 'Paste an OpenAI dashboard/session key for the undocumented credit lookup. It is stored in the OS keychain.'
                      : `Default: ${providerPrompt.defaultURL}`}
                detail={providerPrompt.detail || ''}
                mask={providerPrompt.kind === 'api-key' || providerPrompt.kind === 'openai-usage-session'}
                columns={frameColumns}
                actionLabel={providerPrompt.kind === 'oauth-code' ? 'continue' : 'save'}
                promptLabel={providerPrompt.kind === 'api-key'
                  ? 'API key > '
                  : providerPrompt.kind === 'oauth-code'
                    ? 'Paste code here if prompted > '
                    : providerPrompt.kind === 'openai-usage-session'
                      ? 'Session key > '
                      : 'Base URL > '}
                onSubmit={onSubmit}
                onCancel={cancelProviderPrompt}
              />
            ) : channelPrompt ? (
              <TextEntryPanel
                title={channelPrompt.label}
                hint={channelPrompt.hint || 'Save channel setting.'}
                mask={channelPrompt.kind === 'discord-token' || channelPrompt.kind === 'telegram-token' || channelPrompt.kind === 'webhook-token'}
                columns={frameColumns}
                promptLabel="Value > "
                onSubmit={onSubmit}
                onCancel={cancelChannelPrompt}
              />
            ) : hookPrompt ? (
              <TextEntryPanel
                title={hookPrompt.label}
                hint={hookPrompt.hint || 'Save hook setting.'}
                columns={frameColumns}
                promptLabel="Value > "
                onSubmit={onSubmit}
                onCancel={cancelHookPrompt}
              />
            ) : settingsPrompt ? (
              <TextEntryPanel
                title={settingsPrompt.label}
                hint={settingsPrompt.hint || 'Save setting.'}
                columns={frameColumns}
                initialValue={settingsPrompt.initialValue || ''}
                multiline={settingsPrompt.kind === 'core-add' || settingsPrompt.kind === 'core-edit'}
                maxContentRows={PANEL_MAX_VISIBLE}
                onContentRowsChange={setTextEntryLayoutRows}
                actionLabel={settingsPrompt.kind === 'skill-use'
                  ? 'run'
                  : settingsPrompt.kind === 'autoclear-provider'
                    ? 'save'
                  : settingsPrompt.kind === 'project-new'
                    ? 'open'
                    : settingsPrompt.kind === 'project-create-confirm'
                      ? 'confirm'
                      : settingsPrompt.kind === 'project-rename'
                        ? 'rename'
                        : settingsPrompt.kind === 'core-add'
                          ? 'add'
                          : settingsPrompt.kind === 'core-edit'
                            ? 'save'
                            : settingsPrompt.kind === 'core-delete-confirm'
                              ? 'confirm'
                        : 'save'}
                promptLabel={settingsPrompt.kind === 'skill-use'
                  ? 'Command > '
                  : settingsPrompt.kind === 'autoclear-provider'
                    ? 'Duration > '
                  : settingsPrompt.kind === 'project-new'
                    ? 'Path > '
                    : settingsPrompt.kind === 'project-create-confirm'
                      ? 'Create? (y/n) > '
                      : settingsPrompt.kind === 'project-rename'
                        ? 'Name > '
                        : settingsPrompt.kind === 'core-add'
                          ? 'Sentence > '
                          : settingsPrompt.kind === 'core-edit'
                            ? 'Sentence > '
                            : settingsPrompt.kind === 'core-delete-confirm'
                              ? 'Delete? (y/n) > '
                        : 'Value > '}
                onSubmit={onSubmit}
                onCancel={cancelSettingsPrompt}
              />
            ) : null}
          </Box>
        ) : null}
        {!inputBoxHidden ? (
          <>
          {promptMetaVisible ? (
            <>
              <Box
                marginTop={0}
                marginBottom={0}
                height={1}
                width="100%"
                flexDirection="row"
                backgroundColor={surfaceBackground()}
              >
                <Box flexGrow={1} flexShrink={1} overflow="hidden">
                  {liveSpinner ? (
                    <Spinner
                      verb={liveSpinner.verb}
                      startedAt={liveSpinner.startedAt}
                      outputTokens={liveSpinner?.outputTokens ?? liveSpinner?.tokens ?? 0}
                      thinking={!!(state.thinking || liveSpinner?.thinking)}
                      thinkingActiveSince={liveSpinner?.thinkingSegmentStartedAt ?? 0}
                      mode={liveSpinner?.mode || 'responding'}
                      columns={promptSpinnerColumns}
                      marginTop={0}
                    />
                  ) : null}
                </Box>
                {inputHint ? (
                  <Box flexShrink={0} width={transientStatusWidth || 1} marginLeft={1} marginRight={1} justifyContent="flex-end" overflow="hidden">
                    <Text color={promptStatusColor(inputHintTone)} wrap="truncate">{inputHint}</Text>
                  </Box>
                ) : null}
              </Box>
              <Box height={1} width="100%" backgroundColor={surfaceBackground()} />
            </>
          ) : null}
          {queuedVisible ? (
            <QueuedCommands queued={state.queued} columns={frameColumns} compact={queuedCompact} />
          ) : null}
          <Box
            marginTop={0}
            width="100%"
            height={promptBoxRows}
            flexShrink={0}
            borderStyle="round"
            borderColor={theme.promptBorder}
            backgroundColor={surfaceBackground()}
            paddingX={1}
          >
            {promptInputControl}
          </Box>
          </>
        ) : null}
        <StatusLine
          sessionId={state.sessionId}
          clientHostPid={state.clientHostPid}
          provider={state.provider}
          model={state.model}
          effort={state.effort}
          fast={state.fast}
          cwd={state.cwd}
          stats={statuslineStats}
          contextWindow={state.contextWindow}
          displayContextWindow={state.displayContextWindow}
          compactBoundaryTokens={state.compactBoundaryTokens}
          autoCompactTokenLimit={state.autoCompactTokenLimit}
          rawContextWindow={state.rawContextWindow}
          resizeEpoch={resizeEpoch}
          agentRevision={agentRevision}
          agentWorkers={state.agentWorkers}
          agentJobs={state.agentJobs}
          activeTools={activeTools}
          initialLine={initialStatusLine}
          workflow={state.workflow}
          remoteEnabled={state.remoteEnabled === true}
          themeEpoch={state.themeEpoch || 0}
        />
      </Box>
    </Box>
  );
}
