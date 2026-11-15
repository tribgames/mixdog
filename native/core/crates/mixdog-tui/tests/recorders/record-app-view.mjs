// Records what the Node terminal UI draws for a whole screen, so the Rust application view (`mixdog_tui::view`) is held to
// it cell by cell, hardware cursor included (tests/app_view_twin.rs).
//
// A "screen" case is a scene (the session state, the panel that is open, the prompt draft, the scroll offset) at a terminal
// size. The recorder builds the context `App()` hands to `renderAppView` the way App.jsx does: the shell layout is
// `computeShellLayout` over the scene, the window shows every item (the scenes are short) and the spinner clock is frozen.
// The element tree is rendered with Ink (a fake terminal, FORCE_COLOR=3, ambiguous-wide on) and the last frame is kept with the
// cell Ink's patched runtime parked the hardware cursor at. A "fn" case calls a pure function of app-format.mjs,
// text-entry-labels.mjs or use-welcome-prompt-hint's pure parts and keeps its result as data.
//
// The Node code is only read: it is bundled with esbuild into a temporary folder beside this script (bare imports resolve
// from the repository's node_modules) and the folder is removed afterwards.
//
//   node record-app-view.mjs --tree C:/Project/mixdog --cases <cases.json> --write <golden.json>
//   node record-app-view.mjs --tree C:/Project/mixdog --cases <cases.json> --check <golden.json>

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
const casesPath = option('--cases');
if (!tree || !casesPath || (!option('--write') && !option('--check'))) {
  console.error('usage: record-app-view.mjs --tree <mixdog checkout> --cases <cases.json> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

// chalk reads these when it is imported.
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = '3';
process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '1';
// The status line reads the shell-job cache under the data directory: a fresh empty directory keeps the recording the same
// on every machine.
const dataDirectory = mkdtempSync(join(here, '.tmp-record-data-'));
process.env.MIXDOG_DATA_DIR = dataDirectory;
process.on('exit', () => rmSync(dataDirectory, { recursive: true, force: true }));
// ... and the width the status line reads for the context bar.
try {
  process.stdout.columns = 120;
} catch {
  // A stream that does not allow it keeps its own width.
}

const treeRequire = createRequire(resolve(tree, 'package.json'));
const href = (path) => pathToFileURL(resolve(tree, path)).href;
const { build } = await import('esbuild');
const directory = mkdtempSync(join(here, '.tmp-record-app-view-'));
const outfile = join(directory, 'bundle.mjs');
let modules;
try {
  const entry = [
    `export { renderAppView } from './src/tui/app/app-view.jsx';`,
    `export { render, Box } from 'ink';`,
    `export { default as React } from 'react';`,
  ].join('\n');
  await build({
    stdin: { contents: entry, resolveDir: resolve(tree), loader: 'jsx' },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'error',
    plugins: [
      {
        // The runtime modules stay shared with the ones this script imports, so the theme set below is the theme drawn.
        name: 'keep-runtime-module-paths',
        setup(builder) {
          builder.onResolve({ filter: /^\.\.?\/.*\.mjs$/ }, (resolution) => ({
            path: pathToFileURL(resolve(resolution.resolveDir, resolution.path)).href,
            external: true,
          }));
          // Every package is the copy of the checkout, so React is one module for the components and the runtime modules.
          builder.onResolve({ filter: /^[^./]/ }, (resolution) => {
            const name = resolution.path;
            if (name.startsWith('node:') || builtinModules.includes(name)) return { path: name, external: true };
            return { path: pathToFileURL(treeRequire.resolve(name)).href, external: true };
          });
        },
      },
    ],
  });
  modules = await import(pathToFileURL(outfile).href);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
const { renderAppView, render, React } = modules;
const { setThemeSetting } = await import(href('src/tui/theme.mjs'));
const { computeShellLayout } = await import(href('src/tui/app/shell-layout.mjs'));
const appFormat = await import(href('src/tui/app/app-format.mjs'));
const textEntryLabels = await import(href('src/tui/app/app-view/text-entry-labels.mjs'));
const { default: instances } = await import(href('node_modules/ink/build/instances.js'));

const NOW = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => NOW;

const noop = () => {};
const ref = (current) => ({ current });
const settle = (ms = 120) => new Promise((done) => setTimeout(done, ms));

function useTheme(id) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    setThemeSetting(id ?? 'basic', { persist: false });
  } finally {
    process.stdout.write = write;
  }
}

/** The context App() builds for renderAppView, from a scene. */
function contextOf(item) {
  const scene = item.scene;
  const columns = item.columns;
  const rows = item.rows;
  const resizeState = { columns, rows, epoch: 0 };
  const frameColumns = Math.max(1, columns - 1);
  const promptContentColumns = Math.max(1, frameColumns - 4);
  const st = scene.state ?? {};
  const state = {
    busy: Boolean(st.busy),
    thinking: Boolean(st.thinking),
    queued: (st.queued ?? []).map((entry) => ({ ...entry })),
    items: (st.items ?? []).map((entry) => ({ ...entry })),
    cwd: st.cwd ?? 'C:/work/project',
    sessionId: st.sessionId ?? 'sess-1',
    provider: st.provider ?? 'openai',
    model: st.model ?? 'gpt-5',
    effort: st.effort ?? 'high',
    fast: st.fast === true,
    contextWindow: st.contextWindow ?? 1000,
    displayContextWindow: 0,
    rawContextWindow: 0,
    workflow: st.workflow ?? { id: 'team', name: 'Team' },
    agentWorkers: [],
    agentJobs: [],
    themeEpoch: 0,
    toasts: st.toast ? [{ ...st.toast }] : [],
    spinner: st.spinner ? { ...st.spinner } : { active: false },
    commandStatus: null,
    progressHint: null,
    streamingTail: st.streamingTail ? { ...st.streamingTail } : null,
    transcriptViewItems: null,
  };
  const panel = scene.panel ?? null;
  const picker = panel?.kind === 'picker' ? { pickerKey: 'picker-1', kind: panel.pickerKind ?? 'model', fillAvailable: Boolean(panel.fillAvailable), ...panel.picker } : null;
  const toolApproval = panel?.kind === 'approval' || panel?.kind === 'question' ? { id: 'call-1', ...panel.request } : null;
  const providerPrompt = panel?.kind === 'provider-prompt' ? { ...panel.prompt } : null;
  const settingsPrompt = panel?.kind === 'settings-prompt' ? { ...panel.prompt } : null;
  const slashPaletteOpen = panel?.kind === 'palette';
  const slashCommands = slashPaletteOpen ? panel.commands.map((command) => ({ ...command })) : [];
  const draftValue = scene.promptDraft ?? '';
  const refs = {
    welcomePromptHintRef: ref(scene.welcomeTip ?? 'Ready when you are.'),
    welcomePromptHintVisibleRef: ref(false),
    panelTransitionRef: ref({ signature: '', reserve: 0, clearRows: 0, guardRows: 0, epoch: 0, tailId: null }),
    projectBootInputLatchRef: ref(false),
    promptLayoutValueRef: ref(draftValue),
    transcriptBottomSlackRowsRef: ref(0),
    transcriptViewportRef: ref(null),
    frameRowsRef: ref(0),
    promptBoxRectRef: ref(null),
    panelCloseInkMaskRowsRef: ref(0),
  };
  const layout = computeShellLayout({
    providerPrompt,
    settingsPrompt,
    panelTransitionEpoch: 0,
    panelInkMaskEpoch: 0,
    toolApproval,
    picker,
    contextPanel: null,
    usagePanel: null,
    btwPanel: null,
    slashPaletteOpen,
    tuiReady: true,
    state,
    resizeState,
    frameColumns,
    promptHint: scene.promptHint ?? '',
    promptHintTone: scene.promptHintTone ?? '',
    textEntryLayoutRows: 1,
    onboardingActive: false,
    conditionalWelcomePromptHint: scene.conditionalWelcomeTip ?? '',
    welcomePromptHintDismissed: false,
    promptContentColumns,
    ...refs,
  });
  const itemsAll = state.items;
  const transcriptWindow = {
    effectiveScrollOffset: scene.scrollOffset ?? 0,
    startIndex: 0,
    bottomSpacerRows: 0,
  };
  const tailPinned = transcriptWindow.effectiveScrollOffset === 0;
  const lastDrawn = itemsAll.length - 1;
  return {
    ...layout,
    acceptSlashPalette: noop,
    activeSlashQuery: panel?.query ?? '',
    activeTools: scene.activeTools ?? null,
    agentRevision: 0,
    btwPanel: null,
    cancelProviderPrompt: noop,
    cancelSettingsPrompt: noop,
    cancelSlashPalette: noop,
    clearPromptHint: noop,
    completeSlashPalette: noop,
    contextPanel: null,
    cycleWorkflowFromPrompt: noop,
    exiting: false,
    frameColumns,
    gridSelectionActiveRef: ref(false),
    handlePromptEscape: noop,
    handlePromptHistoryNavigate: noop,
    handlePromptInterrupt: noop,
    handlePromptPaste: noop,
    hasUserMessages: itemsAll.some((entry) => entry.kind === 'user'),
    initialStatusLine: 'Ready',
    onPromptCaretChange: noop,
    onPromptDraftChange: noop,
    onSubmit: noop,
    overlayHintAttachItemIndex: lastDrawn,
    overlayHintFallbackRow: layout.overlayHintRequested && layout.floatingPanelRows === 0 && layout.transcriptGuardRows > 0 && !(layout.overlayHintRequested && tailPinned && itemsAll.length > 0),
    overlayHintOnLastItem: layout.overlayHintRequested && layout.floatingPanelRows === 0 && tailPinned && itemsAll.length > 0,
    paletteKind: panel?.paletteKind ?? 'commands',
    panelInkMaskEpoch: 0,
    panelTransitionEpoch: 0,
    picker,
    pickerOpenedFromEnterRef: ref(false),
    pickerOpenedFromEnterTimerRef: ref(null),
    promptBoxRectRef: refs.promptBoxRectRef,
    promptDraft: draftValue,
    promptDraftOverride: null,
    promptMouseSelectionRef: ref(null),
    promptSelectionRef: ref(null),
    promptValueRef: ref(draftValue),
    providerPrompt,
    renderedTranscriptItems: itemsAll,
    resizeEpoch: 0,
    resizeState,
    restoreQueuedToPrompt: noop,
    setSlashIndex: noop,
    setTextEntryLayoutRows: noop,
    settingsPrompt,
    slashCommands,
    slashIndex: panel?.selected ?? 0,
    slashPaletteOpen,
    state,
    statuslineStats: {},
    store: { resolveToolApproval: noop },
    surface: { claim: () => ({ close: noop }) },
    toolApproval,
    toolOutputExpanded: false,
    transcriptMeasureRef: () => null,
    transcriptTailPinned: tailPinned,
    transcriptWindow,
    tuiReady: true,
    usagePanel: null,
    textEntryUrlMaxRows: layout.textEntryUrlMaxRows,
    welcomePromptHintText: layout.welcomePromptHintText,
  };
}

async function recordScreen(item) {
  useTheme(item.theme);
  const stdout = new PassThrough();
  stdout.columns = item.columns;
  stdout.rows = item.rows;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = noop;
  stdin.ref = noop;
  stdin.unref = noop;
  let last = '';
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...rest) => {
    last = String(chunk);
    return write(chunk, ...rest);
  };
  const view = render(renderAppView(contextOf(item)), { stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false });
  await settle();
  const cursor = instances.get(stdout)?.cursorPosition ?? null;
  const frame = last;
  view.unmount();
  stdin.end();
  stdout.end();
  return { frame, cursor: cursor ? { x: cursor.x, y: cursor.y } : null };
}

const plain = (value) => {
  const text = JSON.stringify(value, (_key, entry) => (entry === undefined ? null : entry));
  return text === undefined ? null : JSON.parse(text);
};

function recordFn(item) {
  const modulesByName = { appFormat, textEntryLabels };
  const fn = modulesByName[item.module]?.[item.name];
  if (typeof fn !== 'function') throw new Error(`${item.id}: no function ${item.module}.${item.name}`);
  return { result: plain(fn(...structuredClone(item.args ?? []))) };
}

const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const recorded = [];
for (const item of cases) {
  const entry = { id: item.id, kind: item.kind, ...(item.kind === 'fn' ? recordFn(item) : await recordScreen(item)) };
  recorded.push(entry);
}
Date.now = realNow;
const recording = JSON.stringify({ format: 1, ambiguousWide: true, cases: recorded }, null, 1) + '\n';
const writeTo = option('--write');
if (writeTo) {
  writeFileSync(writeTo, recording);
  console.log(`wrote ${writeTo} (${recorded.length} cases)`);
} else {
  const checkAgainst = option('--check');
  if (readFileSync(checkAgainst, 'utf8') !== recording) {
    console.error(`record-app-view: ${checkAgainst} differs from what the Node code records now`);
    process.exit(1);
  }
  console.log(`record-app-view: ${checkAgainst} matches (${recorded.length} cases)`);
}
process.exit(0);
