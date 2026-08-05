import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  approvalInstanceKey,
  attemptApproval,
  createSessionScopedSnapshotGate,
  draftAfterSubmission,
  focusTrapIndex,
  isApprovalDismissKey,
  mergeModelCatalog,
  mergeTranscript,
  normalizeApplyPatch,
  parseUnifiedDiff,
  reconcileTurnFailures,
  shouldAdoptForeignSessionFrame,
  shouldNavigatePromptHistory,
  shouldPromoteDraftMaterialization,
  startupRestorePlan,
  shouldShowFastControl,
  toolInputRows,
  transcriptTurnKeys,
} from './renderer-logic.mjs';
import {
  compactedSessionTitle,
  generatedSessionTitle,
  isMediaSessionTitlePlaceholder,
  normalizeSessionTitle,
  promptTitle,
  sessionSummaryTitle,
  stripInjectedDisplayText,
  stripSessionEnvelope,
} from '../shared/session-title.mjs';
import { filterConfiguredModels } from './ModelPicker.tsx';
import { formatContextWindow, modelContextWindow, modelDetailTooltip } from './provider-display.tsx';
import {
  justifiedRows,
  mediaFrameRatio,
  mediaVariantKey,
  resolveStudioModel,
  shouldKeepMediaJobSlot,
  STUDIO_GRID_GAP,
  STUDIO_GRID_MAX_WIDTH,
  studioTargetRowHeight,
} from './studio-support.ts';
import {
  TRANSCRIPT_ROW_ESTIMATE,
  TRANSCRIPT_VIRTUAL_OVERSCAN,
} from './transcript-virtual-cache.ts';
import {
  createStreamingMarkdownCache,
  healStreamingMarkdownTail,
  resolveStreamingMarkdownChunks,
} from './streaming-markdown.ts';
import { adoptTranscriptIdentity, createTranscriptIdentityReconciler } from './transcript-identity.ts';
import { nextWorkspaceTabAfterClose } from './nav-types.ts';
import {
  createSessionSnapshotCache,
  estimateSessionSnapshotBytes,
} from './app-session-snapshots.ts';
import {
  applyFocusedSnapshotToSessionLane,
  createSessionLaneStore,
  decideSessionLaneFrame,
  laneFrameRetainingSettledRows,
  staleSessionLaneReplay,
} from './session-lane-store.ts';
import { createFrameCoordinator } from './interaction-frame-scheduler.ts';
import { TerminalWritePump } from './terminal-write-pump.ts';
import { parseMarkdownToHast } from './markdown-ast.ts';
import { projectTranscriptRows } from './transcript-rows.ts';
import {
  mergeSessionCatalogPushRows,
  mergeSessionCatalogRows,
  optimisticSubmittedSessionCatalog,
} from '../shared/session-catalog.ts';
import { normalizeCachedSessionCatalog } from './session-catalog-cache.ts';
import { classifyMobileTaskSwipe } from './mobile-task-gestures.ts';
import { LatestMarkdownAstQueue } from './markdown-worker-client.ts';
import {
  parseCodeGraphLocations,
  parseCodeGraphSymbols,
} from './editor-code-graph.ts';
import { applyLspTextEdits } from './editor-language-store.ts';
import { filePreviewTypeForPath } from '../shared/file-preview.ts';
import { mediaPlaybackAllowed } from './media-lifecycle.ts';
import {
  normalizeEditorModelText,
  primeEditorFileLoad,
  resolveEditorBackup,
  takeEditorFileLoad,
} from './editor-file-loader.ts';
import {
  editorAnsiDecorationPlan,
  isAnsiOutputPath,
  parseEditorAnsi,
  visibleEditorAnsiText,
} from './editor-ansi.ts';
import { pendingPromptTranscriptItems } from './Conversation.tsx';
import {
  isMonacoRestoreCancellation,
  isResizeObserverDeliveryWarning,
} from './RendererRecovery.tsx';
import {
  EDITOR_LANGUAGE_AUDIT,
  EDITOR_LANGUAGE_DECISIONS,
  EDITOR_LANGUAGE_EXTENSIONS,
  EDITOR_LANGUAGE_NAMES,
  EDITOR_LANGUAGE_PATTERNS,
  editorLanguageIdForPath,
  explicitEditorLanguageIdForPath,
} from '../shared/editor-languages.ts';
import { LOG_MONARCH_LANGUAGE } from './monaco-log-language.ts';
import { MONACO_EAGER_MONARCH_LANGUAGES } from './monaco-eager-languages.ts';
import { SETI_FILE_EXTENSIONS, setiIconFor } from './seti-icons.ts';
import { registerFilePreview } from '../main/file-preview.ts';
import {
  defaultShellProfileId,
  hiddenWslDistribution,
} from '../main/shell-profiles.ts';

const APP_MODULE_FILES = ['./App.tsx', './app-project-actions.ts', './app-session-catalog.ts', './session-catalog-cache.ts', './app-session-snapshots.ts', './app-workspace-shortcuts.ts', './workbench-workspace.ts', './app-snapshot-views.tsx', './app-side-panel-flip.ts', './mobile-task-gestures.ts', './Conversation.tsx', './TranscriptList.tsx', './transcript-rows.ts', './transcript-virtual-cache.ts', './use-transcript-follow.ts', './notifications.tsx', './Composer.tsx', './composer-attachments.ts', './model-controls.tsx', './TranscriptView.tsx', './UtilityDock.tsx', './ReviewPane.tsx', './TurnReview.tsx', './ApprovalCard.tsx', './transcript-metrics.ts', './desktop-types.ts', './text-format.ts', './lazy-widgets.ts', './EditorPane.lazy.tsx', './editor-language-store.ts', './media-lifecycle.ts', './PaneSurfaceGate.tsx'];

test('PANE language resolution audits every VS Code association and formats log files', async () => {
  assert.equal(EDITOR_LANGUAGE_AUDIT.sourceLanguageIds, 74);
  assert.equal(EDITOR_LANGUAGE_AUDIT.sourceExtensions, 342);
  assert.equal(EDITOR_LANGUAGE_AUDIT.sourceFileNames, 71);
  assert.equal(EDITOR_LANGUAGE_AUDIT.sourcePatterns, 26);
  assert.equal(Object.keys(EDITOR_LANGUAGE_DECISIONS).length,
    EDITOR_LANGUAGE_AUDIT.sourceLanguageIds);
  assert.equal(Object.keys(EDITOR_LANGUAGE_EXTENSIONS).length,
    EDITOR_LANGUAGE_AUDIT.runtimeExtensionKeys);
  assert.equal(Object.keys(EDITOR_LANGUAGE_NAMES).length,
    EDITOR_LANGUAGE_AUDIT.runtimeFileNames);
  assert.equal(EDITOR_LANGUAGE_PATTERNS.length,
    EDITOR_LANGUAGE_AUDIT.runtimePatternRules);
  assert.deepEqual(Object.entries(EDITOR_LANGUAGE_DECISIONS)
    .filter(([, decision]) => decision.classification === 'plaintext')
    .map(([id]) => id), [
    'bibtex',
    'cpp_embedded_latex',
    'diff',
    'git-commit',
    'git-rebase',
    'ignore',
    'jsx-tags',
    'latex',
    'markdown-math',
    'markdown_latex_combined',
    'search-result',
    'tex',
  ], 'every deliberate plaintext fallback stays explicit and reviewable');
  assert.equal(EDITOR_LANGUAGE_DECISIONS.log.classification, 'custom');
  assert.equal(EDITOR_LANGUAGE_DECISIONS.log.target, 'log');
  assert.equal(editorLanguageIdForPath('.verify-root.log'), 'log');
  assert.equal(editorLanguageIdForPath('.win-watch3.ps1'), 'powershell');
  assert.equal(editorLanguageIdForPath('Dockerfile.dev'), 'dockerfile');
  assert.equal(editorLanguageIdForPath('.env.local'), 'ini');
  assert.equal(editorLanguageIdForPath('compose.release.yaml'), 'yaml');
  assert.equal(editorLanguageIdForPath('SKILL.md'), 'markdown');
  assert.equal(editorLanguageIdForPath('data.jsonl'), 'json');
  assert.equal(editorLanguageIdForPath('shader.compute'), 'cpp');
  assert.equal(editorLanguageIdForPath('DIPS'), 'plaintext');
  assert.equal(explicitEditorLanguageIdForPath('DIPS'), undefined);
  for (const decision of Object.values(EDITOR_LANGUAGE_DECISIONS)) {
    assert.match(decision.classification, /^(?:native|compatible|custom|plaintext)$/);
    assert.ok(decision.target, 'every VS Code language id needs an explicit PANE decision');
  }

  // White-first-paint guard: every non-plaintext PANE target must have an
  // eager Monarch registration ('log' is our custom Monarch, 'json' is
  // tokenized by monaco's JSON mode), and monaco-setup.ts must actually
  // import + wire each mapped basic-languages module.
  for (const decision of Object.values(EDITOR_LANGUAGE_DECISIONS)) {
    if (decision.classification === 'plaintext') continue;
    if (decision.target === 'log' || decision.target === 'json') continue;
    assert.ok(MONACO_EAGER_MONARCH_LANGUAGES[decision.target],
      `eager Monarch registration missing for '${decision.target}' (white first paint)`);
  }
  const monacoSetup = await readFile(new URL('./monaco-setup.ts', import.meta.url), 'utf8');
  for (const [languageId, moduleDir] of Object.entries(MONACO_EAGER_MONARCH_LANGUAGES)) {
    assert.ok(
      monacoSetup.includes(`monaco-editor/esm/vs/basic-languages/${moduleDir}/${moduleDir}.js`),
      `monaco-setup.ts must eagerly import '${moduleDir}' for language '${languageId}'`);
    assert.ok(monacoSetup.includes(`"${moduleDir}":`),
      `monaco-setup.ts must wire '${moduleDir}' into BASIC_LANGUAGE_DEFINITIONS`);
  }

  const rules = LOG_MONARCH_LANGUAGE.tokenizer.root;
  const tokenFor = (text) => {
    for (const rule of rules) {
      if (!Array.isArray(rule) || !(rule[0] instanceof RegExp)) continue;
      const expression = new RegExp(rule[0].source,
        rule[0].flags.includes('i') ? rule[0].flags : `${rule[0].flags}i`);
      if (expression.test(text)) return rule[1];
    }
    return "";
  };
  assert.equal(tokenFor('ERROR'), 'regexp');
  assert.equal(tokenFor('[INFO] fixture ready'), 'type');
  assert.equal(tokenFor('2026-08-03T10:55:50Z'), 'comment');
  assert.equal(tokenFor('value=\"fixture\"'), 'string');
});

test('terminal shell profiles resolve the OS default and hide utility WSL distros', () => {
  const win = [
    { id: 'windows-powershell', path: 'C:/WindowsPowerShell/powershell.exe' },
    { id: 'cmd', path: 'C:/System32/cmd.exe' },
    { id: 'pwsh', path: 'C:/PowerShell/7/pwsh.exe' },
  ];
  assert.equal(defaultShellProfileId(win, 'win32'), 'pwsh',
    'PowerShell 7 (pwsh) outranks Windows PowerShell (VS Code parity)');
  assert.equal(defaultShellProfileId(win.slice(0, 2), 'win32'), 'windows-powershell');
  assert.equal(defaultShellProfileId([win[1]], 'win32'), 'cmd');
  assert.equal(defaultShellProfileId([], 'win32'), '');
  const unix = [
    { id: 'bash', path: '/bin/bash' },
    { id: 'zsh', path: '/bin/zsh' },
  ];
  assert.equal(defaultShellProfileId(unix, 'linux', '/bin/zsh'), 'zsh', '$SHELL wins on unix');
  assert.equal(defaultShellProfileId(unix, 'linux', '/bin/fish'), 'bash',
    'an unlisted $SHELL falls back to the first detected shell');
  for (const hidden of [
    'docker-desktop', 'docker-desktop-data', 'rancher-desktop', 'podman-machine-default',
  ]) {
    assert.equal(hiddenWslDistribution(hidden), true, `${hidden} is a utility VM, not a user shell`);
  }
  for (const visible of ['Ubuntu', 'Ubuntu-22.04', 'Debian', 'kali-linux']) {
    assert.equal(hiddenWslDistribution(visible), false, `${visible} must stay listed`);
  }
});

test('Seti file icons include VS Code language associations and retain generic fallbacks', () => {
  assert.equal(SETI_FILE_EXTENSIONS.ts, '_typescript');
  assert.equal(SETI_FILE_EXTENSIONS.tsx, '_react');
  assert.equal(SETI_FILE_EXTENSIONS.js, '_javascript');
  assert.equal(SETI_FILE_EXTENSIONS.json, '_json');
  assert.equal(SETI_FILE_EXTENSIONS.md, '_markdown');
  assert.equal(SETI_FILE_EXTENSIONS.ps1, '_powershell');
  assert.equal(SETI_FILE_EXTENSIONS.py, '_python');
  assert.equal(SETI_FILE_EXTENSIONS.rs, '_rust');
  assert.equal(SETI_FILE_EXTENSIONS.yaml, '_yml');

  const generic = setiIconFor('DIPS');
  for (const name of ['app.ts', 'view.tsx', 'tool.js', 'package.json', 'Mixdog.md',
    '.win-watch3.ps1', 'script.py', 'engine.rs', 'compose.yaml']) {
    assert.notEqual(setiIconFor(name).glyph, generic.glyph,
      `${name} must not use the generic Seti file glyph`);
  }
  assert.deepEqual(setiIconFor('.win-watch3.log'), generic,
    'Seti has no dedicated log language icon');
  assert.deepEqual(setiIconFor('notes.txt'), generic,
    'Seti has no dedicated plain-text language icon');
});

test('unchanged file previews reuse their protocol URL while changed files invalidate it', () => {
  const path = resolve('preview-cache-image.png');
  const first = registerFilePreview(path, '100:2048');
  const unchanged = registerFilePreview(path, '100:2048');
  const changed = registerFilePreview(path, '101:2048');
  assert.ok(first);
  assert.equal(unchanged?.url, first.url);
  assert.notEqual(changed?.url, first.url);
});

test('editable output logs render ANSI without changing their source text', () => {
  const source = '\u001b[1;32mgreen\u001b[0m plain '
    + '\u001b[38;5;196mred\u001b[39m '
    + '\u001b[38;2;1;2;3mcustom\u001b[0m';
  const parsed = parseEditorAnsi(source);
  assert.equal(parsed.visibleText, 'green plain red custom');
  assert.equal(visibleEditorAnsiText(source), parsed.visibleText);
  assert.equal(source.includes('\u001b['), true, 'the raw editable source stays untouched');
  assert.equal(parsed.controls.length, 6);
  assert.equal(parsed.spans.find((span) => source.slice(span.start, span.end) === 'green')
    ?.style.foreground, '#0dbc79');
  assert.equal(parsed.spans.find((span) => source.slice(span.start, span.end) === 'red')
    ?.style.foreground, 'rgb(255, 0, 0)');
  assert.equal(parsed.spans.find((span) => source.slice(span.start, span.end) === 'custom')
    ?.style.foreground, 'rgb(1, 2, 3)');
  assert.equal(parsed.spans.find((span) => source.slice(span.start, span.end) === ' plain ')
    ?.style.foreground, undefined, 'SGR 0 must clear custom colors');
  const plan = editorAnsiDecorationPlan(source);
  assert.equal(plan.decorations.filter((entry) => entry.className === 'editor-ansi-control').length, 6);
  assert.match(plan.cssText, /font-weight:700/);
  assert.equal(isAnsiOutputPath('.dev-electron.log'), true);
  assert.equal(isAnsiOutputPath('src/escape.ts'), false);
  assert.equal(parseEditorAnsi('\u001b[12;').visibleText, '\u001b[12;');
});

test('editor backups ignore Monaco mixed-EOL normalization but retain real edits', () => {
  const disk = 'first\nsecond\r\nthird\n';
  const normalized = 'first\nsecond\nthird\n';
  assert.equal(normalizeEditorModelText(disk), normalized);
  assert.equal(normalizeEditorModelText('first\r\nsecond\r\nthird\n'),
    'first\r\nsecond\r\nthird\r\n');

  const normalizedOnly = resolveEditorBackup(disk, {
    content: normalized,
    expectedContent: disk,
    updatedAt: 1,
  });
  assert.equal(normalizedOnly.content, normalized);
  assert.equal(normalizedOnly.savedContent, normalized);
  assert.equal(normalizedOnly.recovery, null);
  assert.equal(normalizedOnly.discardBackup, true);

  const edited = resolveEditorBackup(disk, {
    content: `${normalized}edited`,
    expectedContent: disk,
    updatedAt: 2,
  });
  assert.equal(edited.content, `${normalized}edited`);
  assert.equal(edited.recovery?.restored, true);
  assert.equal(edited.discardBackup, false);

  const eolEdit = resolveEditorBackup('first\r\nsecond\r\n', {
    content: 'first\nsecond\n',
    expectedContent: 'first\r\nsecond\r\n',
    updatedAt: 3,
  });
  assert.equal(eolEdit.recovery?.restored, true,
    'an explicit whole-file EOL change must remain a real edit');
});

test('editor file hydration starts disk and backup reads once before the editor module mounts', async () => {
  const calls = [];
  let resolveFile;
  let resolveBackup;
  const api = {
    readProjectFile() {
      calls.push('file');
      return new Promise((resolveRead) => { resolveFile = resolveRead; });
    },
    readEditorBackup() {
      calls.push('backup');
      return new Promise((resolveRead) => { resolveBackup = resolveRead; });
    },
    perfLog() {},
  };
  const primed = primeEditorFileLoad(api, 'C:\\work', 'src/primed.ts');
  assert.ok(primed);
  const taken = takeEditorFileLoad(api, 'C:\\work', 'src/primed.ts', undefined, true, true);
  assert.equal(taken, primed);
  assert.deepEqual(calls, ['file', 'backup']);
  resolveFile({
    content: 'export const primed = true;',
    mtimeMs: 1,
    binary: false,
    tooLarge: false,
    encoding: 'utf8',
  });
  resolveBackup(null);
  const hydrated = await taken;
  assert.match(hydrated.file.content, /primed/);
  assert.equal(hydrated.backup, null);
  assert.deepEqual(calls, ['file', 'backup']);
});

test('optimistic prompts end when host acknowledgement transfers presentation ownership', () => {
  const prompt = {
    id: 'submit-1',
    kind: 'user',
    text: 'continue after reconnect',
    pending: true,
    accepted: false,
    submittedAt: 10,
  };
  assert.equal(pendingPromptTranscriptItems([prompt], [], [])[0]?.pending, true,
    'a submit awaiting host acknowledgement remains pending');
  assert.equal(pendingPromptTranscriptItems(
    [{ ...prompt, accepted: true }],
    [],
    [{ id: prompt.id }],
  ).length, 1, 'an acknowledged queue entry stays in the transcript without moving the layout');
  assert.equal(pendingPromptTranscriptItems(
    [{ ...prompt, accepted: true }],
    [],
    [],
  ).length, 0, 'an accepted prompt absent from the queue is no longer renderer-owned');
  assert.equal(pendingPromptTranscriptItems(
    [{ ...prompt, accepted: true, queuedBehindTurn: true, queueAcknowledged: false }],
    [],
    [],
  ).length, 1, 'a queued submit survives an RPC acknowledgement that beats queue publication');
  assert.equal(pendingPromptTranscriptItems(
    [{ ...prompt, accepted: true, queuedBehindTurn: true, queueAcknowledged: true }],
    [],
    [],
  ).length, 0, 'an observed queued submit releases after its queue entry drains');
  assert.deepEqual(pendingPromptTranscriptItems(
    [{ ...prompt, accepted: true }],
    [{ id: prompt.id, kind: 'user', text: prompt.text }],
    [],
  ), [], 'the durable transcript row replaces its optimistic twin');
});

test('file editor classifies browser-native image, PDF, audio, and video previews', () => {
  assert.deepEqual(filePreviewTypeForPath('art/hero.AVIF'), { kind: 'image', mime: 'image/avif' });
  assert.deepEqual(filePreviewTypeForPath('docs/manual.pdf'), { kind: 'pdf', mime: 'application/pdf' });
  assert.deepEqual(filePreviewTypeForPath('audio/theme.m4a'), { kind: 'audio', mime: 'audio/mp4' });
  assert.deepEqual(filePreviewTypeForPath('clips/demo.webm'), { kind: 'video', mime: 'video/webm' });
  assert.equal(filePreviewTypeForPath('archive/data.zip'), null);
});

test('media playback requires an active surface and a foreground app window', () => {
  assert.equal(mediaPlaybackAllowed(true, 'visible', true), true);
  assert.equal(mediaPlaybackAllowed(false, 'visible', true), false);
  assert.equal(mediaPlaybackAllowed(true, 'hidden', true), false);
  assert.equal(mediaPlaybackAllowed(true, 'visible', false), false);
});

test('active feedback keeps smooth motion and pauses while the window is hidden', async () => {
  const [spinner, main, desktopCss, structuralCss] = await Promise.all([
    readFile(new URL('./ProgressSpinner.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./main.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(spinner, /setInterval|SPINNER_TICK|animation:\s*"none"/,
    'progress glyphs must use smooth CSS motion instead of stepped JS transforms');
  assert.match(spinner, /willChange:\s*"transform"/);
  assert.match(desktopCss,
    /animation:\s*transcript-text-shimmer var\(--text-shimmer-duration\) linear infinite/);
  assert.match(desktopCss, /@keyframes transcript-text-shimmer/);
  assert.doesNotMatch(desktopCss, /tool-running-blink/,
    'session re-entry must not restart a mount-scoped running-tool blink');
  assert.match(desktopCss,
    /\.tool-card\.failed\.failure-arrived \.tool-icon svg\s*\{[^}]*animation:\s*tool-failed-blink 700ms ease-in-out 2/s);
  assert.doesNotMatch(desktopCss,
    /\.tool-card\.failed \.tool-icon svg\s*\{[^}]*animation:/,
    "restored failed cards must not replay the live failure animation");
  assert.match(structuralCss,
    /\.stream-cursor\s*\{[^}]*animation:\s*blink 1s step-end infinite/s);
  assert.match(main,
    /dataset\.mixdogMotion[\s\S]*?document\.visibilityState === "visible" \? "running" : "paused"/);
  assert.match(desktopCss,
    /:root\[data-mixdog-motion="paused"\][\s\S]*?animation-play-state:\s*paused !important/);
});

test('ResizeObserver delivery warnings remain non-fatal without absorbing real errors', () => {
  assert.equal(
    isResizeObserverDeliveryWarning(
      undefined,
      'ResizeObserver loop completed with undelivered notifications.',
    ),
    true,
  );
  assert.equal(
    isResizeObserverDeliveryWarning(new Error('layout failed'), 'ResizeObserver loop completed with undelivered notifications.'),
    false,
  );
  assert.equal(isResizeObserverDeliveryWarning(undefined, 'Script error.'), false);
});

test('Monaco view-state cancellation stays diagnostic noise without absorbing other rejections', () => {
  const cancellation = Object.assign(new Error('Canceled'), {
    name: 'Canceled',
    stack: 'Canceled: Canceled\n    at Delayer.cancel\n    at CodeEditorContributions.restoreViewState',
  });
  assert.equal(isMonacoRestoreCancellation(cancellation), true);
  assert.equal(isMonacoRestoreCancellation(Object.assign(new Error('Canceled'), {
    name: 'Canceled',
    stack: 'Canceled: Canceled\n    at unrelatedTask',
  })), false);
  assert.equal(isMonacoRestoreCancellation(new Error('editor failed')), false);
});

test('code graph output maps to Monaco locations and document symbols', () => {
  assert.deepEqual(
    parseCodeGraphLocations([
      'apps/editor.ts:77-84:23 declaration',
      'apps/editor.ts:91:7 reference',
    ].join('\n')),
    [
      { rel: 'apps/editor.ts', line: 77, endLine: 84, column: 23 },
      { rel: 'apps/editor.ts', line: 91, endLine: 91, column: 7 },
    ],
  );
  assert.deepEqual(
    parseCodeGraphSymbols('interface FileLoad (L11-16)\nfunction EditorPane (L18-366)'),
    [
      { kind: 'interface', name: 'FileLoad', line: 11, endLine: 16 },
      { kind: 'function', name: 'EditorPane', line: 18, endLine: 366 },
    ],
  );
});

test('LSP text edits apply by UTF-16 range without shifting later edits', () => {
  assert.equal(applyLspTextEdits('one\ntwo\nthree', [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'ONE' },
    { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }, newText: 'THREE!' },
  ]), 'ONE\ntwo\nTHREE!');
  assert.throws(() => applyLspTextEdits('abcdef', [
    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } }, newText: 'x' },
    { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } }, newText: 'y' },
  ]), /overlapping/i);
});

test('closing an active workspace tab prefers its right neighbor, then its left neighbor', () => {
  const tabs = [
    { key: 'session', title: 'Session', selection: { kind: 'session', id: 'session' } },
    { key: 'file-a', title: 'a.ts', selection: { kind: 'file', project: 'C:\\work', rel: 'a.ts' } },
    { key: 'file-b', title: 'b.ts', selection: { kind: 'file', project: 'C:\\work', rel: 'b.ts' } },
  ];
  assert.equal(nextWorkspaceTabAfterClose(tabs, 'file-a')?.key, 'file-b');
  assert.equal(nextWorkspaceTabAfterClose(tabs, 'file-b')?.key, 'file-a');
  assert.equal(nextWorkspaceTabAfterClose([tabs[0]], 'session'), undefined);
});

test('pane, takeover, editor, and terminal surfaces share the workbench hierarchy', async () => {
  const [desktopCss, paneCss, editor, editorLoader, studio, monacoSetup, terminal, app, titlebar, styles, dock, sourceControl, gitCli, overlays, shortcuts, menu, languageStore, snapshotViews] = await Promise.all([
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    readFile(new URL('./pane-layout.css', import.meta.url), 'utf8'),
    readFile(new URL('./EditorPane.lazy.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./editor-file-loader.ts', import.meta.url), 'utf8'),
    readFile(new URL('./StudioView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./monaco-setup.ts', import.meta.url), 'utf8'),
    readFile(new URL('./TerminalPane.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./titlebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
    readFile(new URL('./UtilityDock.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./SourceControlDock.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../main/git-cli.ts', import.meta.url), 'utf8'),
    readFile(new URL('./WorkbenchOverlays.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./app-workspace-shortcuts.ts', import.meta.url), 'utf8'),
    readFile(new URL('../main/menu.ts', import.meta.url), 'utf8'),
    readFile(new URL('./editor-language-store.ts', import.meta.url), 'utf8'),
    readFile(new URL('./app-snapshot-views.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(desktopCss, /\.main-panel\s*\{[^}]*background:\s*var\(--mx-workspace-sheet\)/s);
  assert.doesNotMatch(desktopCss,
    /\.workspace-tab\.dragging\s*\{[^}]*(?:opacity|color|background|filter|transform)\s*:/s,
    "dragging must not change the selected tab's visual state");
  const activeTab = desktopCss.slice(desktopCss.indexOf('.workspace-tab.active::after')).slice(0, 320);
  assert.match(activeTab, /height:\s*1px/);
  assert.match(activeTab, /left:\s*0/);
  assert.match(activeTab, /right:\s*0/);
  assert.match(desktopCss,
    /\.workspace-tabs-shell\[data-focused="true"\] \.workspace-tab\.active::after\s*\{[^}]*background:\s*var\(--mx-accent\);/s);
  assert.doesNotMatch(desktopCss,
    /\.workspace-tabs-shell\[data-focused="false"\] \.workspace-tab\.active::after/);
  assert.match(desktopCss,
    /\.workspace-tab:not\(\.active\)::before\s*\{[^}]*top:\s*8px;[^}]*bottom:\s*8px;[^}]*width:\s*1px;/s);
  const studioCssBlock = desktopCss.slice(desktopCss.indexOf('.studio-pane {')).slice(0, 520);
  assert.match(studioCssBlock, /border-radius:\s*0/);
  assert.match(studioCssBlock, /background:\s*var\(--mx-workspace-sheet\)/);
  assert.match(studioCssBlock, /box-shadow:\s*none/);
  assert.match(paneCss, /background:\s*var\(--mx-window-band\)/);
  assert.doesNotMatch(paneCss,
    /\.pane-cell\.is-focused\.has-siblings\s*\{[^}]*outline:/s);
  assert.doesNotMatch(paneCss, /--focus-ring|rgba\(88,\s*133,\s*255/);
  assert.match(editor, /theme=\{lightTheme \? "mixdog-light" : "mixdog-dark"\}/);
  assert.doesNotMatch(editor, /actionsTargetId|actionsTarget|createPortal\(editorActions/);
  assert.doesNotMatch(app, /paneFileActionsTargetId|editor-pane-actions-host/);
  assert.match(editor, /readOnly:\s*false,[\s\S]*?domReadOnly:\s*false/);
  assert.match(editor,
    /minimap:\s*\{\s*enabled:\s*editorSettings\.minimapEnabled,[\s\S]*?size:\s*"proportional"/);
  assert.match(editor, /registerDefinitionProvider/);
  assert.match(editor, /registerTypeDefinitionProvider/);
  assert.match(editor, /registerImplementationProvider/);
  assert.match(editor, /registerReferenceProvider/);
  assert.match(editor, /registerDocumentSymbolProvider/);
  assert.match(editor, /textDocument\/prepareCallHierarchy/);
  assert.match(editor, /callHierarchy\/incomingCalls/);
  assert.match(editor, /codeAction\/resolve/);
  assert.match(editor,
    /const only = actionContext\.only;[\s\S]*?\.\.\.\(only \? \{ only: \[only\] \} : \{\}\)/,
    "Code Action requests must serialize Monaco's optional kind as an LSP string array");
  assert.doesNotMatch(editor, /only:\s*actionContext\.only|source:\s*marker\.source,\s*code:/,
    "Code Action requests must not send optional undefined fields through strict IPC");
  assert.match(editor, /registerDocumentRangeFormattingEditProvider/);
  assert.match(editor, /registerSignatureHelpProvider/);
  assert.match(editor, /registerDeclarationProvider/);
  assert.match(editor, /registerDocumentHighlightProvider/);
  assert.match(editor, /registerLinkedEditingRangeProvider/);
  assert.match(editor, /registerCodeLensProvider/);
  assert.match(editor, /registerOnTypeFormattingEditProvider/);
  assert.match(editor, /registerLinkProvider/);
  assert.match(editor, /registerColorProvider/);
  assert.match(editor, /registerFoldingRangeProvider/);
  assert.match(editor, /registerSelectionRangeProvider/);
  assert.match(editor, /registerDocumentSemanticTokensProvider/);
  assert.match(editor, /registerDocumentRangeSemanticTokensProvider/);
  assert.match(editor, /registerInlayHintsProvider/);
  assert.match(editor, /completionItem\/resolve/);
  assert.match(editor, /lspProviderFeaturesByLanguage/);
  assert.match(editor,
    /fontSize:\s*editorSettings\.fontSize,[\s\S]*?lineHeight:\s*editorSettings\.lineHeight/);
  assert.doesNotMatch(editor, /fontSize:\s*12\.5/);
  assert.match(editor, /registerEditorOpener/);
  assert.match(editor, /saveViewState\(\)/);
  assert.match(editor, /restoreViewState\(viewState\)/);
  assert.match(editorLoader, /readEditorBackup/);
  assert.match(editor, /writeEditorBackup/);
  assert.match(editor, /className="editor-pane-preview-loading" role="status"/);
  assert.match(desktopCss, /\.editor-pane-preview-loading\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s);
  assert.match(editor, /Unsaved changes were restored from the previous session/);
  assert.match(editor, /className="editor-breadcrumbs"/);
  assert.match(editor, /editor-breadcrumb-item/);
  assert.match(editor, /api\?\.listProjectDir/);
  assert.match(editor, /role="treeitem"/);
  assert.match(editor, /No symbols found/);
  assert.match(editor, /event\.key === "ArrowLeft"/);
  assert.match(editor, /event\.key === "ArrowRight"/);
  assert.match(editor, /editor-statusbar/);
  assert.doesNotMatch(desktopCss, /\.workbench-statusbar/);
  assert.doesNotMatch(app, /WorkbenchStatusBar/);
  assert.doesNotMatch(editor, /editor-breadcrumb-encoding/);
  // Final cleanup (user): encoding/EOL/indentation pickers left the status
  // bar — language stays as a read-only indicator only.
  assert.doesNotMatch(editor, /Select Encoding|Select End of Line|Select Indentation/);
  assert.match(editor, /editor-statusbar-language/);
  assert.doesNotMatch(editor, /KeyMod\.Alt \| monaco\.KeyCode\.(Left|Right)Arrow/,
    "Alt+Arrow belongs to pane focus, so the editor keeps no history binding there");
  assert.match(editor, /KeyCode\.KeyW/);
  assert.match(editor, /KeyCode\.KeyQ[\s\S]*?mixdog:close-active-tab/);
  assert.doesNotMatch(editor, /addCommand\([^)]*KeyCode\.F12/);
  assert.match(editor,
    /const onDirtyRef = useRef\(onDirty\);[\s\S]*?onDirtyRef\.current = onDirty;[\s\S]*?onDirtyRef\.current\(next\);[\s\S]*?\}, \[\]\);/,
    "dirty notifications must not retrigger the disk-loading effect");
  assert.doesNotMatch(editor, /PanelRight|editor-pane-header|onToggleDock/);
  assert.match(editor,
    /className="editor-breadcrumbs"[\s\S]*?className="editor-breadcrumb-path"[\s\S]*?className="editor-breadcrumb-actions"[\s\S]*?<Save size=\{16\}[\s\S]*?className="editor-revert-action"[\s\S]*?<Undo2 size=\{18\}[\s\S]*?<FolderOpen size=\{16\}/,
    "file-local actions must live at the right end of the breadcrumb row");
  const breadcrumbActions = editor.slice(editor.indexOf('className="editor-breadcrumb-actions"')).slice(0, 1_200);
  assert.doesNotMatch(breadcrumbActions, /Open in default app|<ExternalLink size=/,
    "the breadcrumb row must not duplicate the system-open action");
  assert.match(desktopCss,
    /\.editor-breadcrumb-actions svg\.lucide \{ width: 18px; height: 18px; stroke-width: 1\.25px; \}[\s\S]*?\.editor-breadcrumb-actions \.editor-revert-action svg\.lucide \{ width: 18px; height: 18px; \}/,
    "file actions share the 18px header-cluster glyph frame and thin stroke");
  assert.doesNotMatch(editor, /\b(?:renderReview|showReview|setShowReview)\b|<Diff size=/,
    "file editor actions must not expose the redundant full-review transition");
  assert.doesNotMatch(studio, /aria-label="Open in system viewer"/);
  assert.match(studio, /openMediaFolder', \[asset\.id\]/);
  assert.match(studio, /<FolderOpen size=\{14\} aria-hidden="true" \/>\{t\(['"]Open Folder['"]\)\}/);
  assert.match(studio, /className="studio-thumbnail-loading"/);
  assert.match(desktopCss, /\.studio-thumbnail-image\[data-ready='true'\]\s*\{\s*opacity:\s*1;/s);
  assert.match(studio,
    /visibleAssets\.length === 0 && pendingJobs\.length === 0 && !loading[\s\S]*?className="studio-blank"/,
    "the first pending generation must replace the full-height blank state");
  assert.match(studio,
    /className="studio-results"[\s\S]*?className="studio-dock"/,
    "Studio results, including pending thumbnails, must stay above the composer");
  assert.match(studio,
    /className="studio-tile-remove" aria-label=\{t\(['"]Delete asset['"]\)\}[\s\S]*?<Trash2 size=\{15\}/);
  assert.match(studio,
    /value=\{TILE_SIZES\.length - 1[\s\S]*?TILE_SIZES\[TILE_SIZES\.length - 1 - scaleIndex\]/,
    "thumbnail scale must run from smaller tiles on the left to larger tiles on the right");
  assert.match(desktopCss,
    /\.studio-topbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto minmax\(0,\s*1fr\);/s);
  assert.match(desktopCss,
    /\.studio-topbar > \.studio-kind\s*\{[^}]*grid-column:\s*2;/s);
  assert.match(studio,
    /className="studio-topbar"[\s\S]*?className="studio-kind"[\s\S]*?className="studio-density"[\s\S]*?className="studio-dock"/);
  assert.match(desktopCss,
    /\.studio-density\s*\{[^}]*width:\s*clamp\(44px,\s*18cqi,\s*112px\);[^}]*max-width:\s*100%;/s);
  assert.match(desktopCss,
    /\.studio-tile-actions button\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*border-radius:\s*50%;/s);
  assert.doesNotMatch(editor, /editor-pane-dirty/);
  assert.doesNotMatch(desktopCss, /\.editor-pane-dirty\s*\{/);
  assert.match(desktopCss,
    /\.editor-breadcrumbs\s*\{[^}]*height:\s*30px;[^}]*flex:\s*0 0 30px;/s);
  assert.match(desktopCss,
    /\.editor-breadcrumb-actions\s*\{[^}]*height:\s*30px;[^}]*gap:\s*4px;[^}]*margin-left:\s*auto;[^}]*padding:\s*0;/s);
  assert.match(desktopCss,
    /\.editor-breadcrumb-actions button\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*border-radius:\s*6px;[^}]*color:\s*var\(--mx-text\);/s);
  assert.match(desktopCss,
    /\.editor-breadcrumb-actions svg\.lucide\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*stroke-width:\s*1\.25px;/s);
  assert.match(desktopCss,
    /\.editor-breadcrumb-item\s*\{[^}]*height:\s*24px;/s);
  assert.match(desktopCss, /\.editor-breadcrumb-item:hover/);
  assert.match(desktopCss, /\.editor-breadcrumb-picker\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*120;/s);
  assert.match(desktopCss, /\.editor-breadcrumb-picker-tree > button\s*\{[^}]*height:\s*22px;/s);
  assert.match(desktopCss, /\.editor-statusbar\s*\{[^}]*height:\s*22px;/s);
  const fileEditorRoute = app.slice(app.indexOf('className="schedules-pane editor-tab-pane ')).slice(0, 900);
  assert.match(fileEditorRoute, /onPointerUpCapture=\{focused \? undefined/);
  assert.match(fileEditorRoute, /window\.setTimeout\(focusPane,\s*0\)/);
  assert.doesNotMatch(fileEditorRoute, /onPointerDown(?:Capture)?=/);
  const utilityPortalRoute = app.slice(app.indexOf("return <PersistentPanePortal")).slice(0, 900);
  assert.match(utilityPortalRoute,
    /onPointerDownCapture=\{descriptor\.focused \? undefined[\s\S]*?paneWorkspace\.focusLeaf\(leafId\)/,
    "portal-backed Studio, terminal, and diff surfaces must focus their physical pane");
  assert.match(app, /navigationKey\(paneSelection\) === paneActiveFileKey/);
  assert.doesNotMatch(app, /const openPaneFileKeys|const \[hotFileKeys|setHotFileKeys/,
    "inactive Monaco trees must not remain mounted in a background hot set");
  assert.match(app,
    /void prefetchEditorPane\(\)[\s\S]*?\.then\(\(\) => reportEditorLoadStage\([\s\S]*?"module"/,
    "opening a file must preload Monaco and record when its module is ready");
  assert.doesNotMatch(app, /errors=\{focused \?/,
    "focused and unfocused panes must receive the same renderer error chrome");
  assert.doesNotMatch(app, /setDockTab\(requested \?\? "tasks"\)/,
    "reopening the utility Dock must preserve its last selected tab");
  assert.match(app,
    /localStorage\.setItem\(DOCK_STATE_KEY,\s*JSON\.stringify\(\{ open: dockOpen, tab: dockTab, width: dockWidth \}\)\)/,
    "the utility Dock must persist its selected tab with its open state and width");
  assert.match(snapshotViews, /liveWork=\{<PaneLiveWork[\s\S]*?focused=\{focused\}/,
    "every pane must render activity from its own snapshot regardless of focus");
  assert.match(editor,
    /useLayoutEffect\(\(\) => \{[\s\S]*?layoutEditorToHost\(editor, layoutHost\);[\s\S]*?if \(focused\) editor\?\.focus\(\);[\s\S]*?\}, \[active, focused, layoutEditorToHost, load\]\);/,
    "visible Monaco geometry must settle before paint so its first scrollbar drag is live");
  assert.match(editor,
    /const dimension = nextEditorLayoutDimension\([\s\S]*?editor\.layout\(dimension\);/,
    "Monaco layouts must receive explicit host dimensions instead of remeasuring their own scrollbar DOM");
  assert.match(editor,
    /const MIXDOG_EDITOR_SCROLLBAR = \{\s*arrowSize:\s*0,\s*verticalScrollbarSize:\s*14,\s*horizontalScrollbarSize:\s*12,\s*\} as const;/);
  assert.equal((editor.match(/scrollbar:\s*MIXDOG_EDITOR_SCROLLBAR/g) || []).length, 2,
    "the main and Peek editors must share VS Code's 14px/12px scrollbar geometry");
  assert.match(monacoSetup,
    /'scrollbarSlider\.background':\s*scrollbarThumb,[\s\S]*?'scrollbarSlider\.hoverBackground':\s*scrollbarThumbHover,[\s\S]*?'scrollbarSlider\.activeBackground':\s*scrollbarThumbHover/,
    "Monaco scrollbar states must consume the shell scrollbar tokens");
  assert.doesNotMatch(dock, /onTab\("terminal"\)|tab === "terminal"|<TerminalPane/);
  // Search folded into the Files explorer (Orca grammar): three dock tabs.
  assert.match(dock, /'tasks' \| 'files' \| 'source-control'/);
  assert.match(dock, /workbench-explorer-search/);
  assert.match(app, /<ActivityRail/);
  assert.doesNotMatch(app, /<CodingActivityBar|codingWorkspaceActive|data-workbench/);
  assert.match(app, /<BottomPanel/);
  assert.match(app, /sidebarTreeMounted && <SessionSidebar/,
    "the sidebar tree must stay mounted after first use while open controls visibility");
  assert.match(app, /presentedSidebarSurface === "projects"[\s\S]*?<ProjectsPane active/);
  assert.match(app, /activeBottomPanelTab === "problems"[\s\S]*?stable-surface-layer/);
  assert.match(paneCss,
    /\.bottom-panel-body > \.stable-surface-layer\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
    "bottom panel surfaces must share one fixed geometry during tab handoff");
  assert.match(paneCss,
    /\.pane-surface-handoff-layer > \.stable-pane-surface\[data-surface-active="false"\]\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s,
    "inactive Studio and utility slots must remain mounted without consuming conversation height");
  assert.doesNotMatch(paneCss,
    /\.pane-cell > \.stable-pane-surface\[data-surface-active="false"\]/,
    "utility positioning must follow the nested pane-surface layer rather than the retired direct-child layout");
  assert.match(paneCss,
    /\.pane-conversation-slot\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*z-index:\s*1;/s,
    "Conversation must retain one fixed full-geometry paint layer");
  assert.match(paneCss,
    /\.pane-conversation-slot\[data-conversation-parked="true"\]\s*\{[^}]*z-index:\s*0;[^}]*pointer-events:\s*none;/s,
    "a parked Conversation must stay painted underneath the opaque utility layer");
  assert.doesNotMatch(paneCss,
    /\.pane-conversation-slot\[data-conversation-parked="true"\]\s*\{[^}]*(?:display:\s*none|visibility:\s*hidden|opacity:\s*0)/s,
    "parking must not suspend layout, measurement, or paint");
  assert.match(desktopCss,
    /\.session-sidebar-surface\[data-surface-active="true"\]\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/s,
    "sidebar surfaces must swap visibility without re-entering document flow");
  assert.match(app, /panelOpen=\{bottomPanel\.open\}/);
  assert.match(app, /onTogglePanel=\{toggleBottomPanel\}/);
  assert.match(app, /dockOpen=\{dockOpen\}/);
  assert.match(app, /<SnapshotUtilityDock/);
  assert.doesNotMatch(app, /\{codingWorkspaceActive && <BottomPanel/);
  assert.match(titlebar, /titlebar-spacer[\s\S]*titlebar-leading[\s\S]*titlebar-caption-space/);
  assert.match(styles, /\.main-panel\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  const quickDiffDecorations = editor.slice(editor.indexOf("const decos = stripes.map")).slice(0, 1_800);
  assert.match(quickDiffDecorations,
    /linesDecorationsClassName: `editor-dirty-diff editor-dirty-diff-\$\{stripe\.kind\}`/);
  assert.match(quickDiffDecorations,
    /overviewRuler:\s*\{[\s\S]*?OverviewRulerLane\.Left[\s\S]*?minimap:\s*\{[\s\S]*?MinimapPosition\.Gutter/,
    "Quick Diff must use VS Code's default gutter, overview ruler, and minimap locations");
  assert.match(shortcuts, /event\.key === "PageUp" \|\| event\.key === "PageDown"/);
  assert.match(shortcuts, /window\.addEventListener\("keydown", onShortcutCapture, true\)/,
    "the workbench keymap must resolve in the capture phase on every surface");
  assert.doesNotMatch(shortcuts, /window\.addEventListener\("keydown", \w+\);/,
    "no bubble-phase shortcut listener may survive — surfaces would swallow it");
  for (const method of ["gitStage", "gitUnstage", "gitIgnore", "gitCommit", "gitPush", "gitShow", "gitShowDiff"]) {
    assert.match(sourceControl, new RegExp(`api\\?\\.${method}|api\\.${method}`));
  }
  assert.doesNotMatch(sourceControl, /dock-scm-commit-patch|<pre className="dock-scm-commit-patch"/);
  // Read gitCommit's OWN body: slicing to the next exported function tracked
  // file order, so any function added in between broke a test about commit.
  const gitCommitBody = gitCli.match(/export async function gitCommit\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(gitCommitBody.includes("run(cwd, ['commit', '-m', trimmed])"),
    "Source Control must commit the message through a plain `git commit -m`");
  assert.doesNotMatch(gitCommitBody, /'add'|'-A'|'--all'|'-a'/,
    "Source Control commits only the explicit staged index");
  assert.match(paneCss, /\.pane-resize-handle\s*\{[^}]*flex:\s*0 0 1px;/s);
  assert.match(paneCss,
    /\.pane-split-row > \.pane-resize-handle::before\s*\{[^}]*left:\s*-3px;[^}]*right:\s*-3px;/s);
  assert.match(paneCss, /\.pane-resize-handle::after\s*\{[^}]*background:\s*var\(--mx-border-muted/s);
  assert.doesNotMatch(paneCss, /@container chat-pane|\.thread\s*\{[\s\S]*?var\(--mx-scrollbar-size\)/,
    'pane chrome must not reintroduce a second transcript/composer gutter scale');
  assert.match(terminal, /TERMINAL_VIEW_STATE_KEY/);
  assert.match(terminal, /requestAnimationFrame\(\(\) => \{[\s\S]*?fitTerminalView/);
  assert.match(terminal, /scrollToLine\(Math\.min\(current\.scrollY/);
  assert.match(monacoSetup, /defineTheme\('mixdog-dark'/);
  assert.match(monacoSetup, /defineTheme\('mixdog-light'/);
  assert.match(monacoSetup, /'editor\.background': '#1f1f1f'/);
  assert.match(monacoSetup, /'editor\.background': '#faf8f5'/);
  assert.match(monacoSetup, /'menu\.background': '#1f1f1f'/);
  assert.match(monacoSetup, /'menu\.selectionBackground': '#0078d4'/);
  assert.match(monacoSetup, /resolveThemeColor\('--mx-focus'/);
  assert.match(editor, /MenuId\.EditorContextPeek/);
  assert.match(editor, /title:\s*"Peek Call Hierarchy"/);
  assert.match(editor, /changeViewZones/);
  assert.match(editor, /height:\s*Math\.max\(8,\s*Math\.min\(40,\s*Number\(value\?\.height\)\s*\|\|\s*17\)\)/);
  assert.match(editor, /gridTemplateColumns:[\s\S]*?callHierarchyLayout\.ratio/);
  assert.match(editor, /Show Outgoing Calls \(Shift\+Alt\+H\)/);
  assert.match(editor, /peekEditor\.addCommand\(monaco\.KeyCode\.Escape/);
  assert.doesNotMatch(editor, /contextMenuGroupId:\s*"navigation"/);
  // Registry themes restyle the shell via injected tokens; the editor must
  // re-derive its palette from the same tokens on every theme change.
  assert.match(monacoSetup, /attributeFilter: \['data-mixdog-theme'\]/);
  assert.match(monacoSetup, /resolveThemeColor\('--mx-workspace-sheet'/);
  assert.match(app, /editorSaveHandles/);
  assert.doesNotMatch(app, /window\.confirm\(`Discard unsaved changes/);
  assert.match(overlays, /role="dialog"[\s\S]*?Command Palette/);
  assert.match(overlays, />\{t\(["']Cancel["']\)\}<[\s\S]*?>\{t\(["']Don’t Save["']\)\}<[\s\S]*?\{busy \? t\(["']Saving…["']\) : t\(["']Save["']\)\}/);
  assert.match(shortcuts, /key === "p"/);
  assert.match(shortcuts, /key === "w"/);
  assert.match(shortcuts, /key === "w" \|\| key === "q"/);
  assert.match(shortcuts, /navigateBack/);
  assert.match(shortcuts, /navigateForward/);
  assert.match(app, /workbench\.action\.navigateBack/);
  assert.match(app, /workbench\.action\.navigateForward/);
  assert.match(app, /getEditorCommandCapabilities/);
  assert.match(app, /editorCommandCapabilities\.rename/);
  assert.match(app, /editorCommandCapabilities\.codeAction/);
  assert.match(app, /editorCommandCapabilities\.formatting/);
  assert.match(app, /editorCommandCapabilities\.callHierarchy/);
  assert.match(languageStore, /status\?\.available \? status\.capabilities/);
  assert.doesNotMatch(menu, /accelerator:\s*['"]CmdOrCtrl\+Q['"]/);
  assert.match(menu, /role:\s*['"]quit['"],\s*registerAccelerator:\s*false/);
  assert.match(menu, /CmdOrCtrl\+Shift\+W/);
});

test('editor file actions live in the roomier breadcrumb row', async () => {
  const [app, editor, desktopCss] = await Promise.all([
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./EditorPane.lazy.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
  ]);
  const breadcrumbStart = editor.indexOf('const editorBreadcrumbs =');
  const breadcrumb = editor.slice(
    breadcrumbStart,
    editor.indexOf('</nav>', breadcrumbStart) + '</nav>'.length,
  );
  const breadcrumbMarkers = [
    'className="editor-breadcrumbs"',
    'className="editor-breadcrumb-path"',
    'className="editor-breadcrumb-actions"',
    'aria-label="Save"',
    'aria-label="Revert"',
    'aria-label="Reveal in Explorer"',
  ];
  assert.ok(breadcrumbStart >= 0 && breadcrumb.endsWith('</nav>'),
    'the breadcrumb source must have a complete nav boundary');
  assert.deepEqual(
    breadcrumbMarkers.map((marker) => breadcrumb.indexOf(marker)),
    [...breadcrumbMarkers].map((marker) => breadcrumb.indexOf(marker)).sort((left, right) => left - right),
    'Save, Revert, and reveal must share the file path row in order',
  );
  assert.ok(breadcrumbMarkers.every((marker) => breadcrumb.includes(marker)),
    'every file action must remain inside the breadcrumb nav');
  assert.doesNotMatch(editor, /Discard Restored Changes/);
  assert.match(editor,
    /const queued = saveQueue\.current[\s\S]*?then\(\(\) => saveNow\(encoding\)\)/,
    'edits saved while another write is active must queue behind it');
  assert.match(editor,
    /if \(changedAfterSave\) await writeBackupNow\(currentContent\)[\s\S]*?else await deleteBackup/,
    'an edit made during save must retain a fresh crash backup');
  const revert = editor.slice(editor.indexOf('const revertFromDisk =')).slice(0, 2_500);
  assert.ok(revert.indexOf('await reader(') < revert.indexOf('await deleteBackup('),
    'Revert must read successfully before deleting the backup');
  assert.match(editor,
    /closest\("\.editor-breadcrumb-actions"\)\) return;/,
    'breadcrumb roving focus must ignore the trailing action buttons');
  assert.doesNotMatch(editor, /actionsTargetId|actionsTarget|createPortal\(editorActions/);
  assert.doesNotMatch(app, /paneFileActionsTargetId|editor-pane-actions-host/);
  assert.match(desktopCss,
    /\.editor-breadcrumbs\s*\{[^}]*height:\s*30px;[^}]*flex:\s*0 0 30px;/s);
  assert.match(desktopCss,
    /\.editor-breadcrumb-actions button\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/s);
});

test('mobile task swipes cycle tabs only for a dominant horizontal gesture', () => {
  assert.equal(classifyMobileTaskSwipe({
    deltaX: -90, deltaY: 12,
  }), 'next-tab');
  assert.equal(classifyMobileTaskSwipe({
    deltaX: 90, deltaY: -8,
  }), 'previous-tab');
  assert.equal(classifyMobileTaskSwipe({
    deltaX: 8, deltaY: -90,
  }), null, 'vertical transcript scrolling must remain untouched');
  assert.equal(classifyMobileTaskSwipe({
    deltaX: 40, deltaY: -45,
  }), null, 'short diagonal movement must remain a normal touch');
});

test('side-panel toggles commit final layout synchronously without view transitions', async () => {
  const app = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');
  const toggles = app.slice(app.indexOf('const openSidebar = useCallback'))
    .slice(0, 1_800);
  assert.match(toggles, /sidebarOpenIntent\.current/);
  assert.match(toggles, /dockOpenIntent\.current/);
  assert.doesNotMatch(toggles, /if \(sidebarOpen\)|if \(dockOpen\)/,
    'rapid toggles must not branch on a delayed render state');
  assert.doesNotMatch(app, /data-side-flip/,
    'no flip phase attribute: layout commits are single-frame (VS Code grammar)');
  const flipSource = await readFile(new URL('./app-side-panel-flip.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(flipSource, /startViewTransition|flushSync/,
    'side-panel commits must be synchronous — snapshot crossfades ghost text over the reflow');
  assert.match(flipSource,
    /window\.setTimeout\(\(\) => \{[\s\S]*?root\.classList\.remove\(cls\);[\s\S]*?\}, 240\);/,
    'the only timer clears the compositor entry class after the synchronous commit');
  const css = await readFile(new URL('./desktop.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /view-transition|data-side-flip/,
    'window layout shifts must not composite old/new snapshots (afterimages + font shimmer)');
  const paneCss = await readFile(new URL('./pane-layout.css', import.meta.url), 'utf8');
  assert.match(paneCss, /\.pane-split\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);
  assert.match(paneCss, /\.pane-split-cell\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);
  assert.match(paneCss, /\.pane-leaf\s*\{[^}]*min-width:\s*min\(var\(--pane-min-width,\s*320px\),\s*100%\);/s);
});

test('Fast control uses selected catalog capability before a new task has session state', () => {
  assert.equal(shouldShowFastControl(false, true), true);
  assert.equal(shouldShowFastControl(true, false), true);
  assert.equal(shouldShowFastControl(false, false), false);
});

test('session snapshot LRU enforces a retained-byte budget and rejects oversized frames', () => {
  const snapshot = (sessionId, text) => ({
    sessionId,
    items: [{ id: `${sessionId}-answer`, kind: 'assistant', text }],
    queued: [],
  });
  const first = snapshot('cache-one', 'a'.repeat(2_000));
  const second = snapshot('cache-two', 'b'.repeat(2_000));
  const firstBytes = estimateSessionSnapshotBytes(first);
  const secondBytes = estimateSessionSnapshotBytes(second);
  const cache = createSessionSnapshotCache({
    maxEntries: 6,
    maxBytes: firstBytes + secondBytes - 1,
  });
  cache.remember(first);
  cache.remember(second);
  assert.equal(cache.get('cache-one'), null, 'the oldest frame must leave when byte budget is exceeded');
  assert.equal(cache.get('cache-two'), second);

  const oversized = snapshot('cache-huge', 'x'.repeat(20_000));
  const tight = createSessionSnapshotCache({
    maxEntries: 6,
    maxBytes: estimateSessionSnapshotBytes(oversized) - 1,
  });
  tight.remember(oversized);
  assert.equal(tight.get('cache-huge'), null, 'one oversized frame must not bypass the global budget');
});

test('session lane snapshots bound inactive transcripts while protecting mounted panes', () => {
  const snapshot = (sessionId, text) => ({
    sessionId,
    items: [{ id: `${sessionId}-answer`, kind: 'assistant', text }],
    queued: [],
  });
  const store = createSessionLaneStore({ maxEntries: 1, maxBytes: 1024 * 1024 });
  const active = snapshot('lane-active', 'active');
  const inactive = snapshot('lane-inactive', 'inactive');
  const unsubscribe = store.subscribe('lane-active', () => {});
  store.apply({ sessionId: 'lane-active', snapshot: active });
  store.apply({ sessionId: 'lane-inactive', snapshot: inactive });
  assert.match(store.get('lane-active')?.items?.[0]?.text || '', /active/);
  assert.equal(store.get('lane-inactive'), null,
    'an inactive frame must leave before a mounted pane loses its live snapshot');
  unsubscribe();
  store.apply({ sessionId: 'lane-inactive', snapshot: inactive });
  assert.equal(store.get('lane-active'), null);
  assert.match(store.get('lane-inactive')?.items?.[0]?.text || '', /inactive/);
  assert.deepEqual(store.stats(), {
    entries: 1,
    estimatedBytes: store.stats().estimatedBytes,
    subscribedSessions: 0,
  });

  const oversized = snapshot('lane-oversized', 'x'.repeat(20_000));
  const tight = createSessionLaneStore({
    maxEntries: 6,
    maxBytes: estimateSessionSnapshotBytes(oversized) - 1,
  });
  tight.apply({ sessionId: 'lane-oversized', snapshot: oversized });
  assert.equal(tight.get('lane-oversized'), null,
    'an unmounted oversized lane must not bypass the retained-byte budget');
});

test('focused state reuses its decorated frame as the active session lane', () => {
  const store = createSessionLaneStore({ maxEntries: 4, maxBytes: 1024 * 1024 });
  const snapshot = {
    sessionId: 'focused-lane',
    items: [{ id: 'answer', kind: 'assistant', text: 'single publication' }],
    queued: [],
    failedTurnKeys: [],
    transcriptTurnKeys: ['answer'],
  };
  applyFocusedSnapshotToSessionLane(snapshot, store);
  assert.equal(store.get('focused-lane'), snapshot,
    'the already-decorated global frame must be reused without cloning/redecorating');
});

test('lane frames reconcile transcript completeness per source and never pin live fields', () => {
  const row = (id, text) => ({ id, kind: 'assistant', text });
  const prior = {
    sessionId: 'lane-authority',
    items: [row('a', 'alpha'), row('b', 'beta'), row('c', 'gamma')],
    queued: [],
    busy: false,
    model: 'gpt-prior',
    stats: { currentContextTokens: 700 },
    displayContextWindow: 1_000,
    failedTurnKeys: ['turn-a'],
  };
  // A windowed publication (both host projections cap the transcript): the
  // omitted HEAD is restored, while every live field the frame carries wins.
  const windowed = laneFrameRetainingSettledRows(prior, {
    sessionId: 'lane-authority',
    items: [row('b', 'beta'), row('c', 'gamma')],
    queued: [],
    busy: true,
    model: 'gpt-live',
    agentWorkers: [{ tag: 'w1', status: 'running' }],
  }, 'session-lane');
  assert.deepEqual(windowed.items.map((item) => item.id), ['a', 'b', 'c'],
    'a tail window must not drop the head this pane already shows');
  assert.equal(windowed.busy, true, 'live work state must come from the frame');
  assert.deepEqual(windowed.agentWorkers, [{ tag: 'w1', status: 'running' }]);
  assert.equal(windowed.model, 'gpt-live', 'a route change must still land');
  assert.deepEqual(windowed.stats, { currentContextTokens: 700 },
    'a usage read-out the frame does not carry must not regress to unknown');
  assert.equal(windowed.failedTurnKeys, undefined,
    'the turn model of a merged superset stays the frame\'s own');

  const cleared = { sessionId: 'lane-authority', items: [], queued: [] };
  assert.equal(laneFrameRetainingSettledRows(prior, cleared, 'session-lane'), cleared,
    'a host/channel clear on the session lane must clear the pane');
  assert.equal(laneFrameRetainingSettledRows(prior, cleared, 'focused-state'), cleared,
    'a settled focused frame owns its own transcript');
  const trimmed = {
    sessionId: 'lane-authority',
    items: [row('a', 'alpha'), row('b', 'beta')],
    queued: [],
  };
  assert.equal(laneFrameRetainingSettledRows(prior, trimmed, 'session-lane'), trimmed,
    'a genuine trailing removal must not be blocked');
  const branch = {
    sessionId: 'lane-authority',
    items: [row('x', 'branched'), row('y', 'rewritten')],
    queued: [],
  };
  assert.equal(laneFrameRetainingSettledRows(prior, branch, 'session-lane'), branch,
    'a rewritten/branched transcript replaces the cache');
  assert.equal(laneFrameRetainingSettledRows(prior, branch, 'focused-transition'), branch,
    'a branch resume is a different transcript even mid-transition');
  assert.equal(laneFrameRetainingSettledRows(prior, branch, 'renderer-result'), branch);
  assert.equal(laneFrameRetainingSettledRows(prior, cleared, 'renderer-result'), cleared,
    'the renderer\'s own /clear or resume result is always authoritative');
  const grown = {
    sessionId: 'lane-authority',
    items: [...prior.items, row('d', 'delta')],
    queued: [],
  };
  assert.equal(laneFrameRetainingSettledRows(prior, grown, 'focused-transition'), grown,
    'real growth must land even during a host transition');

  // Host transition frames describe the ENGINE loading, not the session.
  const loading = { sessionId: 'lane-authority', items: [], queued: [], busy: true };
  const held = laneFrameRetainingSettledRows(prior, loading, 'focused-transition');
  assert.equal(held.items, prior.items,
    'a transitional empty frame must not unmount settled rows');
  assert.equal(held.busy, true, 'the transition still reports live work');
  assert.deepEqual(held.failedTurnKeys, ['turn-a'],
    'a fully retained transcript keeps the turn model computed over it');
  const partial = laneFrameRetainingSettledRows(prior, {
    sessionId: 'lane-authority',
    items: [row('b', 'beta')],
    queued: [],
  }, 'focused-transition');
  assert.deepEqual(partial.items.map((item) => item.id), ['a', 'b', 'c'],
    'a partial transition frame must not truncate the settled transcript');
  assert.equal(laneFrameRetainingSettledRows(null, cleared, 'session-lane'), cleared,
    'a cold lane always adopts its first frame as-is');
});

test('session lanes order by authoritative content generation, never by arrival', () => {
  const row = (index) => ({ id: `row-${index}`, kind: 'assistant', text: `line ${index}` });
  const transcript = (count) => Array.from({ length: count }, (_, index) => row(index));
  const sessionId = 'revision-lane';
  const frame = (count, extra = {}) => ({
    sessionId,
    items: transcript(count),
    queued: [],
    ...extra,
  });
  const store = createSessionLaneStore({ maxEntries: 4, maxBytes: 8 * 1024 * 1024 });
  const digest = () => {
    const snapshot = store.get(sessionId);
    const items = snapshot?.items || [];
    return `${items.length}:${items[0]?.id || ''}:${items.at(-1)?.id || ''}`;
  };
  // The pane is painting a 493-row live generation.
  store.apply({
    sessionId,
    snapshot: frame(493, { busy: true, model: 'gpt-live', stats: { currentContextTokens: 900 } }),
    frameSource: 'live',
    contentRevision: 7,
  });
  assert.equal(digest(), '493:row-0:row-492');
  const settled = store.get(sessionId);

  // An older durable projection (476 rows) arrives afterwards.
  store.apply({
    sessionId,
    snapshot: frame(476, { busy: false, model: 'gpt-stale' }),
    frameSource: 'replay',
    contentRevision: 6,
  });
  assert.equal(store.get(sessionId), settled,
    'a stale replay must not touch the cached frame at all');
  assert.equal(store.get(sessionId).model, 'gpt-live',
    'a stale replay must not overwrite the live route');
  assert.equal(store.get(sessionId).busy, true,
    'a stale replay must not overwrite live work state');
  store.apply({
    sessionId,
    snapshot: frame(476, { busy: false, model: 'gpt-stale-live' }),
    frameSource: 'live',
    contentRevision: 6,
  });
  assert.equal(store.get(sessionId), settled,
    'a lower-generation owner callback must not replace a newer rendered frame');

  // The SAME generation, re-emitted (pane peek handshake, delta resync).
  store.apply({
    sessionId,
    snapshot: frame(493, { busy: false, model: 'gpt-stale', stats: undefined }),
    frameSource: 'replay',
    contentRevision: 7,
  });
  assert.equal(store.get(sessionId), settled,
    'an equal-generation replay reuses the rendered rows instead of swapping them');
  const sameGeneration = decideSessionLaneFrame(
    settled,
    7,
    { ...settled, items: settled.items.map((item) => ({ ...item })), busy: false },
    { source: 'session-lane', frameSource: 'live', contentRevision: 7 },
  );
  assert.equal(sameGeneration.accept, true);
  assert.equal(sameGeneration.snapshot.items, settled.items,
    'same-generation live state must reuse the exact settled item array');
  assert.equal(sameGeneration.snapshot.busy, false,
    'same-generation live work fields still update');

  // One genuine append at the next generation.
  store.apply({
    sessionId,
    snapshot: frame(494, { busy: true, model: 'gpt-live' }),
    frameSource: 'live',
    contentRevision: 8,
  });
  assert.equal(digest(), '494:row-0:row-493', 'real growth still lands');

  // A newer durable generation may clear, delete or rewrite.
  store.apply({
    sessionId,
    snapshot: frame(0),
    frameSource: 'replay',
    contentRevision: 9,
  });
  assert.equal(store.get(sessionId).items.length, 0,
    'a newer generation clear must reach the pane');
  store.apply({
    sessionId,
    snapshot: { sessionId, items: [row(41), row(42)], queued: [] },
    frameSource: 'replay',
    contentRevision: 10,
  });
  assert.deepEqual(store.get(sessionId).items.map((item) => item.id), ['row-41', 'row-42'],
    'a newer generation branch/rewrite must reach the pane');

  // Legacy/remote hosts publish unversioned frames: the compatibility path
  // keeps reconciling by transcript completeness alone.
  const legacy = createSessionLaneStore({ maxEntries: 4, maxBytes: 1024 * 1024 });
  legacy.apply({ sessionId, snapshot: { sessionId, items: [row(1), row(2), row(3)], queued: [] } });
  legacy.apply({ sessionId, snapshot: { sessionId, items: [row(2), row(3)], queued: [] } });
  assert.deepEqual(legacy.get(sessionId).items.map((item) => item.id),
    ['row-1', 'row-2', 'row-3'],
    'an unversioned windowed frame still restores the head it omitted');

  assert.equal(staleSessionLaneReplay(7, { source: 'session-lane', frameSource: 'replay', contentRevision: 6 }),
    'stale-replay');
  assert.equal(staleSessionLaneReplay(7, { source: 'session-lane', frameSource: 'replay', contentRevision: 7 }),
    'duplicate-replay');
  assert.equal(staleSessionLaneReplay(7, { source: 'session-lane', frameSource: 'replay', contentRevision: 8 }),
    null);
  assert.equal(staleSessionLaneReplay(7, { source: 'session-lane', frameSource: 'live', contentRevision: 7 }),
    null, 'an owner publication is never gated by the replay rule');
  assert.equal(staleSessionLaneReplay(7, { source: 'session-lane' }), null,
    'unversioned frames keep the compatibility path');
  assert.equal(
    staleSessionLaneReplay(7, { source: 'renderer-result', frameSource: 'replay', contentRevision: 1 }),
    null,
    'an explicit renderer result is authoritative regardless of lane revisions');
  const prior = { sessionId, items: [row(1)], queued: [] };
  const rendererResult = { sessionId, items: [], queued: [] };
  assert.deepEqual(
    decideSessionLaneFrame(prior, 7, rendererResult, { source: 'renderer-result' }),
    { accept: true, snapshot: rendererResult, revision: 7, reason: 'authoritative' },
    'a renderer result replaces content without contradicting the recorded generation');
});

test('a tail-windowed replay keeps the identity baseline for the next full frame', () => {
  const reconciler = createTranscriptIdentityReconciler();
  const sessionId = 'identity-window';
  const ids = (snapshot) => snapshot.items.map((item) => item.id);
  const live = reconciler.reconcile({
    sessionId,
    items: [
      { id: 'run-1', kind: 'user', text: 'h1' },
      { id: 'run-2', kind: 'assistant', text: 'h2' },
      { id: 'run-3', kind: 'assistant', text: 'h3' },
    ],
  });
  assert.deepEqual(ids(live), ['run-1', 'run-2', 'run-3']);
  // Disk/replay window: the same rows under the restore id namespace.
  const replay = reconciler.reconcile({
    sessionId,
    items: [
      { id: 'hist_2', kind: 'assistant', text: 'h2' },
      { id: 'hist_3', kind: 'assistant', text: 'h3' },
    ],
  });
  assert.deepEqual(ids(replay), ['run-2', 'run-3'],
    'a replayed window adopts the ids those rows are displayed with');
  const recovered = reconciler.reconcile({
    sessionId,
    items: [
      { id: 'fresh-1', kind: 'user', text: 'h1' },
      { id: 'fresh-2', kind: 'assistant', text: 'h2' },
      { id: 'fresh-3', kind: 'assistant', text: 'h3' },
    ],
  });
  assert.deepEqual(ids(recovered), ['run-1', 'run-2', 'run-3'],
    'the window must not shrink the baseline: omitted rows keep their ids');
  const branched = reconciler.reconcile({
    sessionId,
    items: [
      { id: 'branch-1', kind: 'user', text: 'different history' },
      { id: 'branch-2', kind: 'assistant', text: 'other answer' },
    ],
  });
  assert.deepEqual(ids(branched), ['branch-1', 'branch-2'],
    'a genuine rewrite fails alignment and replaces the baseline');
});

test('repeated status rows align on evidence, not on the first content-equal offset', () => {
  const reconciler = createTranscriptIdentityReconciler();
  const sessionId = 'repeated-rows';
  const ids = (snapshot) => snapshot.items.map((item) => item.id);
  // A debugger session: identical "status done" rows repeat verbatim.
  const baseline = [
    { id: 'r1', kind: 'status', status: 'done', text: 'done' },
    { id: 'r2', kind: 'tool', name: 'shell', text: 'shell run' },
    { id: 'r3', kind: 'status', status: 'done', text: 'done' },
    { id: 'r4', kind: 'assistant', status: 'done', text: 'answer' },
  ];
  assert.deepEqual(ids(reconciler.reconcile({ sessionId, items: baseline })),
    ['r1', 'r2', 'r3', 'r4']);
  // The window is the LAST two rows under fresh ids. The first content-equal
  // offset is r1 — the wrong occurrence.
  const window = reconciler.reconcile({
    sessionId,
    items: [
      { id: 't3', kind: 'status', status: 'done', text: 'done' },
      { id: 't4', kind: 'assistant', status: 'done', text: 'answer' },
    ],
  });
  assert.deepEqual(ids(window), ['r3', 'r4'],
    'the window must adopt the occurrence it was actually cut from');
  const recovery = reconciler.reconcile({
    sessionId,
    items: baseline.map((item, index) => ({ ...item, id: `fresh-${index}` })),
  });
  assert.deepEqual(ids(recovery), ['r1', 'r2', 'r3', 'r4'],
    'the recovery frame must restore every row id, not remount the transcript');

  // Status evidence differentiates otherwise identical rows.
  const statusReconciler = createTranscriptIdentityReconciler();
  const statusSession = 'repeated-status';
  statusReconciler.reconcile({
    sessionId: statusSession,
    items: [
      { id: 's1', kind: 'status', status: 'running', label: 'Build', count: 1 },
      { id: 's2', kind: 'status', status: 'failed', label: 'Build', count: 2 },
    ],
  });
  const failedWindow = statusReconciler.reconcile({
    sessionId: statusSession,
    items: [{ id: 'w1', kind: 'status', status: 'failed', label: 'Build', count: 2 }],
  });
  assert.deepEqual(ids(failedWindow), ['s2'],
    'status/label/count evidence must outrank a bare kind match');
});

test('independent session lanes preserve per-session order without cross-pane renders', async () => {
  const store = createSessionLaneStore({ maxEntries: 4, maxBytes: 1024 * 1024 });
  const seenA = [];
  const seenB = [];
  const stopA = store.subscribe('lane-a', () => {
    seenA.push(store.get('lane-a')?.streamingTail?.text);
  });
  const stopB = store.subscribe('lane-b', () => {
    seenB.push(store.get('lane-b')?.streamingTail?.text);
  });
  try {
    store.apply({
      sessionId: 'lane-a',
      snapshot: { sessionId: 'lane-a', items: [], queued: [], streamingTail: { id: 'a', text: 'a1' } },
    });
    store.apply({
      sessionId: 'lane-b',
      snapshot: { sessionId: 'lane-b', items: [], queued: [], streamingTail: { id: 'b', text: 'b1' } },
    });
    store.apply({
      sessionId: 'lane-a',
      snapshot: { sessionId: 'lane-a', items: [], queued: [], streamingTail: { id: 'a', text: 'a2' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(seenA, ['a1', 'a2']);
    assert.deepEqual(seenB, ['b1']);
  } finally {
    stopA();
    stopB();
  }
});

test('layout frame coordinator keeps only the latest work per owner and batches panes', () => {
  let callback = null;
  let requests = 0;
  const coordinator = createFrameCoordinator({
    requestFrame(next) {
      requests += 1;
      callback = next;
      return requests;
    },
    cancelFrame() {},
  });
  const first = {};
  const second = {};
  const seen = [];
  coordinator.schedule(first, () => seen.push('stale'));
  coordinator.schedule(first, () => seen.push('first'));
  coordinator.schedule(second, () => seen.push('second'));
  assert.equal(requests, 1);
  callback(0);
  assert.deepEqual(seen, ['first', 'second']);
});

test('terminal write pump keeps one xterm parse in flight and acknowledges parsed batches', async () => {
  const writes = [];
  const callbacks = [];
  const acknowledged = [];
  const pump = new TerminalWritePump(
    (data, complete) => {
      writes.push(data);
      callbacks.push(complete);
    },
    (id, charCount) => acknowledged.push([id, charCount]),
  );
  pump.push('term-a', 'one');
  pump.push('term-a', '-two');
  pump.push('term-a', '-three');
  assert.deepEqual(writes, ['one']);
  callbacks.shift()();
  assert.deepEqual(writes, ['one', '-two-three']);
  assert.deepEqual(acknowledged, [['term-a', 3]]);
  callbacks.shift()();
  assert.deepEqual(acknowledged, [['term-a', 3], ['term-a', 10]]);

  const replay = pump.writeReplay('history');
  pump.push('term-a', 'live');
  assert.deepEqual(writes, ['one', '-two-three', 'history']);
  callbacks.shift()();
  await replay;
  assert.deepEqual(writes, ['one', '-two-three', 'history', 'live']);
  callbacks.shift()();
  assert.deepEqual(acknowledged.at(-1), ['term-a', 4],
    'replay is local state and only live PTY output is acknowledged');
  pump.dispose();
});

test('visible workbench streams stay live while the composer is isolated', async () => {
  const [conversation, terminal, studio, editor] = await Promise.all([
    readFile(new URL('./Conversation.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./TerminalPane.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./StudioView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./EditorPane.lazy.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(conversation, /const resumeFollowOnSubmitRef = useRef\(resumeFollow\)/);
  assert.match(conversation, /const composerSubmit = useCallback\([\s\S]*?\n  \}, \[\]\);/);
  assert.match(terminal, /if \(event\.id === view\.id\) view\.writer\.push\(event\.id, event\.data\)/,
    'PTY bytes must reach the single-flight writer regardless of pane focus');
  assert.match(studio,
    /if \(!active \|\| !runningKey\) return undefined;[\s\S]*?getMediaJob[\s\S]*?const timer = setInterval\(poll/,
    'visible Studio jobs must poll independently without keeping hidden panes hot');
  assert.match(editor, /model\.onDidChangeContent/,
    'Monaco must retain its independent input subscription');
});

test('studio media failures stay scoped to one asset variant', () => {
  assert.equal(mediaVariantKey('asset-a', 'thumb'), 'asset-a:thumb');
  assert.notEqual(mediaVariantKey('asset-a', 'thumb'), mediaVariantKey('asset-a', 'original'));
});

test('the transcript timeline paints one contained layer with OpenCode cold overscan', async () => {
  const [list, css] = await Promise.all([
    readFile(new URL('./TranscriptList.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
  ]);
  assert.match(list, /overscan:\s*50,/);
  assert.match(list,
    /restored\?\.measurements\?\.length \|\| coldBottomMount \? 6 : TRANSCRIPT_VIRTUAL_OVERSCAN/);
  assert.match(list,
    /current < TRANSCRIPT_VIRTUAL_OVERSCAN \? TRANSCRIPT_VIRTUAL_OVERSCAN : current/);
  assert.equal(TRANSCRIPT_VIRTUAL_OVERSCAN, 20);
  // One flat estimate: real geometry comes from measurement, and re-entry
  // replays the measured snapshot instead of a content heuristic.
  assert.equal(TRANSCRIPT_ROW_ESTIMATE, 60);
  assert.doesNotMatch(list, /prewarmRange|setTimeout/,
    'session entry must not schedule delayed virtual-size mutations');
  assert.match(list, /Math\.abs\(size - previous\) > element\.clientHeight/,
    'a rewrap larger than the viewport must keep the reader\'s rows mounted');
  assert.match(css,
    /\.transcript-virtual-space\s*\{[^}]*transform:\s*translate3d\(0,\s*0,\s*0\);[^}]*contain:\s*strict;[^}]*overflow:\s*hidden;/s,
    'the virtual timeline should stay in one contained compositor layer');
  assert.match(css, /\.transcript-virtual-row\s*\{[^}]*overflow:\s*clip;/s,
    'a row box must clip to exactly the geometry the virtualizer believes in');
  assert.match(css,
    /\.transcript-virtual-row-content\[data-tag="UserMessage"\],[\s\S]*?padding-bottom:\s*12px;/,
    'within-turn rhythm belongs to the measured row box');
  assert.match(css,
    /@container chat-pane \(min-width:\s*768px\)[\s\S]*?max-width:\s*800px;[\s\S]*?padding-inline:\s*20px;/,
    'OpenCode md row width and inset must follow the chat pane, not the window');
  assert.match(css,
    /@container chat-pane \(min-width:\s*1536px\)[\s\S]*?max-width:\s*1000px;/,
    'OpenCode 2xl centered rows must expand to 1000px');
  assert.match(css, /\.transcript-turn-gap\s*\{[^}]*height:\s*20px;/s,
    'turn boundaries must be explicit virtual rows');
});

test('streaming markdown repartitions without hiding visible source text', async () => {
  const cache = createStreamingMarkdownCache();
  const firstText = `${'alpha '.repeat(60)}\n\n${'beta '.repeat(60)}`;
  const first = resolveStreamingMarkdownChunks(firstText, true, cache);
  assert.equal(first.stableChunks.length, 1);
  assert.equal(first.stableChunkKeys[0], 'chunk-0');
  assert.match(first.stableChunks[0], /^alpha /);
  assert.match(first.unstableText, /^beta /);

  const nextText = `${firstText}\n\n${'gamma '.repeat(20)}`;
  const next = resolveStreamingMarkdownChunks(nextText, true, cache);
  assert.equal(next.stableChunks.length, 2, 'all complete blocks except the live tail should be stable');
  assert.equal(next.stableChunkKeys[0], first.stableChunkKeys[0],
    'promoted blocks must retain their first-seen renderer key');
  assert.equal(next.stableChunkKeys[1], first.unstableKey,
    'the previous unstable block must keep its key when promoted');
  assert.equal(`${next.stableChunks.join('')}${next.unstableText}`, nextText,
    'chunk promotion must preserve every visible source character');

  const [view, body, fallback] = await Promise.all([
    readFile(new URL('./TranscriptView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./StreamingMarkdownBody.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./MarkdownSourceFallback.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(view, /key=\{markdownParts\.stableChunkKeys\[index\]\}/);
  assert.match(view, /key=\{markdownParts\.unstableKey\}/);
  assert.match(view, /containsFencedCodeMarkdown\(text\)/);
  assert.match(view, /fencedScriptGeometryLocked\.current = true/);
  assert.match(view, /deferAsyncPromotion=\{chunkDefersPromotion\(/,
    'only the chunk that carries the fence may keep its source-shaped geometry');
  assert.doesNotMatch(view, /deferAsyncPromotion=\{fencedScriptGeometryLocked\.current\}/,
    'locking every chunk froze prose blocks as raw markdown source');
  assert.match(view, /parseText=\{unstableParseText\}/,
    'the live tail parses its healed form while the fallback keeps the raw source');
  assert.doesNotMatch(view, /stream-cursor/);
  assert.match(body, /isFencedCodeOnlyMarkdown/);
  assert.match(body, /live=\{live\}/,
    'the live tail parses too — OpenCode paced streaming markdown');
  assert.match(body, /live && rendered && !deferAsyncPromotion/,
    'while the newest slice parses, the previous AST stays on screen instead of source text');
  assert.match(body, /requestedText\.current === parsedText && !deferAsyncPromotionRef\.current/);
  assert.match(fallback, /className="markdown-code markdown-code-fallback"/);
  assert.match(fallback, /trimPartialClosingFence/);
  assert.match(fallback, /className=\{part\.language \? `language-\$\{part\.language\}`/);
  assert.doesNotMatch(`${view}\n${body}\n${fallback}`,
    /MarkdownRenderLoading|StreamingMarkdownLoading|markdown-render-loading/,
    'streamed text must never collapse to a fixed-height loading indicator');
});

// OpenCode heals its live tail (remend) before parsing so styling appears while
// the model types. Without healing the raw "**"/"`" markers stayed on screen
// until the closing token arrived (user: 마크다운 포맷이 안 먹어서 이상하게 나온다).
test('the live markdown tail heals unterminated inline markers before parsing', async () => {
  assert.equal(healStreamingMarkdownTail('계획 **통합 백그라운드'), '계획 **통합 백그라운드**');
  assert.equal(healStreamingMarkdownTail('run `npm ru'), 'run `npm ru`');
  assert.equal(healStreamingMarkdownTail('~~취소'), '~~취소~~');
  assert.equal(healStreamingMarkdownTail('**done** and `ok` stay'), '**done** and `ok` stay',
    'balanced markers must never gain a closer');
  assert.equal(healStreamingMarkdownTail('```ts\nconst a = "**";'), '```ts\nconst a = "**";',
    'an open fence is literal code — healing must not touch it');
  assert.equal(healStreamingMarkdownTail('```ts\nconst a = "**";\n```\ntail'),
    '```ts\nconst a = "**";\n```\ntail',
    'markers inside a closed fence must not be counted');
  assert.equal(healStreamingMarkdownTail('plain prose without markers'), 'plain prose without markers');

  const css = await readFile(new URL('./desktop.css', import.meta.url), 'utf8');
  assert.match(css, /\.notice\s*\{[^}]*padding:\s*8px 12px;/s,
    'a transcript notice is a card — its copy must not sit flush against the hairline');
  assert.match(css, /\.notice\.warn\s*\{[^}]*color:\s*var\(--mx-warning\);/s,
    'warn-tone notices (watchdog abort) must not read as neutral status');
  assert.match(css, /\.markdown li > p:first-child\s*\{[^}]*display:\s*inline;/s,
    'loose list items must not double their gap with the prose paragraph margin');
  assert.match(css, /\.markdown > :first-child\s*\{[^}]*margin-top:\s*0;/s,
    'a leading heading must not push its own turn down');
});

// Entering a working session crosses id namespaces (disk restore hist_* ids ↔
// live-share owner runtime ids). Re-issuing keys for the same visible rows
// remounted the bottom of the transcript at estimate heights and shook the
// pinned view (user: 작업 스크립트가 위아래로 떨림). Adoption keeps the
// first-seen id for aligned, content-compatible rows.
test('cross-source transcript identity adoption keeps displayed row ids stable', () => {
  const previous = {
    items: [
      { id: 'hist_1', kind: 'user', text: 'run the build' },
      { id: 'hist_2', kind: 'assistant', text: 'building now' },
      { id: 'hist_3', kind: 'tool', name: 'shell', text: '' },
    ],
    tail: null,
  };
  const adopted = adoptTranscriptIdentity(previous, [
    { id: 'own_1', kind: 'user', text: 'run the build' },
    // Streaming growth (prefix) still identifies the same logical row.
    { id: 'own_2', kind: 'assistant', text: 'building now with more detail' },
    // Tool rows anchor on kind+name; result detail may evolve.
    { id: 'own_3', kind: 'tool', name: 'shell', text: '', result: 'ok' },
    { id: 'own_4', kind: 'assistant', text: 'done' },
  ], null);
  assert.deepEqual(adopted.items.map((item) => item.id), ['hist_1', 'hist_2', 'hist_3', 'own_4'],
    'aligned rows keep their first-seen ids; genuinely new rows keep source ids');
  assert.equal(adopted.items[2].result, 'ok', 'content always comes from the incoming frame');
  // A kind mismatch is a real divergence: adoption aborts conservatively.
  const diverged = adoptTranscriptIdentity(previous, [
    { id: 'x1', kind: 'tool', name: 'read', text: '' },
    { id: 'x2', kind: 'assistant', text: 'unrelated' },
  ], null);
  assert.equal(diverged.items, undefined);
});

test('streaming-tail identity survives re-identification and settle carryover', () => {
  const previous = {
    items: [{ id: 'hist_1', kind: 'user', text: 'go' }],
    tail: { id: 'own_tail', kind: 'assistant', text: 'partial script', streaming: true },
  };
  // The owner settles the tail into items under a fresh id: the row keeps the
  // id it was displayed with, so the settle commit updates in place.
  const settled = adoptTranscriptIdentity(previous, [
    { id: 'hist_1', kind: 'user', text: 'go' },
    { id: 'new_9', kind: 'assistant', text: 'partial script and the rest' },
  ], null);
  assert.equal(settled.items[1].id, 'own_tail');
  // A re-identified live tail (viewer re-sync) keeps its displayed id.
  const retail = adoptTranscriptIdentity(previous, [{ id: 'hist_1', kind: 'user', text: 'go' }],
    { id: 'other_tail', kind: 'assistant', text: 'partial script grows', streaming: true });
  assert.equal(retail.tail.id, 'own_tail');
});

test('the identity reconciler is sticky per session across alternating sources', () => {
  const reconciler = createTranscriptIdentityReconciler();
  const restore = reconciler.reconcile({
    sessionId: 's1',
    items: [{ id: 'hist_1', kind: 'user', text: 'hello' }],
  });
  assert.equal(restore.items[0].id, 'hist_1');
  const ownerFrame = reconciler.reconcile({
    sessionId: 's1',
    items: [
      { id: 'own_1', kind: 'user', text: 'hello' },
      { id: 'own_2', kind: 'assistant', text: 'hi' },
    ],
  });
  assert.deepEqual(ownerFrame.items.map((item) => item.id), ['hist_1', 'own_2']);
  // Flapping back to the restore namespace converges on the SAME display ids.
  const restoreAgain = reconciler.reconcile({
    sessionId: 's1',
    items: [
      { id: 'hist_1', kind: 'user', text: 'hello' },
      { id: 'hist_2', kind: 'assistant', text: 'hi' },
    ],
  });
  assert.deepEqual(restoreAgain.items.map((item) => item.id), ['hist_1', 'own_2']);
  // Untouched frames pass through by reference (no allocation churn).
  const stable = { sessionId: 's1', items: restoreAgain.items };
  assert.equal(reconciler.reconcile(stable), stable);
});

test('session catalog titles synchronize every existing session tab', async () => {
  const app = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('const catalogTitles');
  const effect = app.slice(start, start + 800);
  assert.ok(start >= 0);
  assert.match(effect, /tab\.selection\.kind !== "session"/);
  assert.doesNotMatch(effect, /isMediaSessionTitlePlaceholder\(tab\.title\)/);
});

// The former App.tsx monolith now spans focused renderer modules; source-shape
// assertions read them as one concatenated surface.
async function readAppModules() {
  const parts = await Promise.all(APP_MODULE_FILES.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  return parts.join('\n');
}
test('explicit provider context metadata wins over model-family fallbacks', () => {
  const explicitClaude = {
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-5',
    display: 'Claude Sonnet 5',
    contextWindow: 200_000,
  };
  const legacyClaude = {
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-5',
    display: 'Claude Sonnet 5',
  };

  assert.equal(formatContextWindow(modelContextWindow(explicitClaude)), '200k Context');
  assert.equal(formatContextWindow(modelContextWindow(legacyClaude)), '1M Context');
});

test('model detail tooltip reports only available catalog metadata', () => {
  assert.equal(modelDetailTooltip({
    provider: 'openai',
    model: 'gpt-real',
    display: 'GPT Real',
    contextWindow: 400_000,
    effortOptions: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
    fastCapable: true,
    fastPreferred: false,
    latest: true,
    releaseDate: '2026-03-01',
  }), 'OpenAI API · gpt-real · 400k Context · Reasoning Low/High · Fast available · Latest · Released 2026-03-01');
});

test('studio model resolution never carries a model across media contracts', () => {
  const video = {
    models: [
      { id: 'video-beta', label: 'Video Beta' },
      { id: 'video-gamma', label: 'Video Gamma' },
    ],
    defaultModel: 'video-beta',
    controls: {},
  };
  assert.equal(resolveStudioModel(video, 'image-alpha'), 'video-beta');
  assert.equal(resolveStudioModel(video, 'video-gamma'), 'video-gamma');
});

test('studio generation keeps one stable image or video frame until the indexed asset replaces it', () => {
  const runningImage = {
    id: 'image-job',
    status: 'running',
    kind: 'image',
    lane: 'gemini',
    model: 'image-alpha',
    options: { aspectRatio: '4:3' },
    progress: 20,
    assetId: null,
    error: null,
  };
  const doneVideo = {
    ...runningImage,
    id: 'video-job',
    status: 'done',
    kind: 'video',
    model: 'video-beta',
    options: { aspectRatio: '16:9' },
    assetId: 'video-asset',
  };
  assert.equal(mediaFrameRatio(runningImage), 4 / 3);
  assert.equal(mediaFrameRatio(doneVideo), 16 / 9);
  assert.equal(mediaFrameRatio({ kind: 'image', options: { aspectRatio: 'auto' } }), 1);
  assert.equal(mediaFrameRatio({ kind: 'video', options: { aspectRatio: 'auto' } }), 16 / 9);
  assert.equal(shouldKeepMediaJobSlot(runningImage, [], 'image'), true);
  assert.equal(shouldKeepMediaJobSlot(doneVideo, [], 'video'), true,
    'a completed video keeps its pending frame while the poster asset is absent');
  assert.equal(shouldKeepMediaJobSlot(doneVideo, [{ id: 'video-asset', kind: 'video' }], 'video'), false,
    'the indexed video replaces the pending frame in the same slot');
});

test('studio density completes each row before the next thumbnail wraps', () => {
  for (const columns of [3, 4, 5, 6]) {
    const assets = Array.from({ length: columns + 1 }, (_, index) => ({
      id: `asset-${columns}-${index}`,
    }));
    const ratios = Object.fromEntries(assets.map((asset, index) => [
      asset.id,
      index === assets.length - 1 ? 16 / 9 : 1,
    ]));
    const rows = justifiedRows(
      assets,
      ratios,
      589,
      studioTargetRowHeight(columns),
      STUDIO_GRID_GAP,
      STUDIO_GRID_MAX_WIDTH,
    );
    assert.deepEqual(rows.map((row) => row.length), [columns, 1],
      `${columns}-up density must wrap the next thumbnail onto a new row`);
    const firstRowWidth = rows[0].reduce((total, tile) => total + tile.width, 0)
      + STUDIO_GRID_GAP * (rows[0].length - 1);
    assert.ok(Math.abs(firstRowWidth - 589) < 1e-9,
      `${columns}-up row must remain flush with the measured grid width`);
  }
});

test('renderer uses the preload bridge name', async () => {
  const [preload, renderer] = await Promise.all([
    readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'),
    readAppModules(),
  ]);
  const bridgeName = preload.match(/exposeInMainWorld\('([^']+)'/)?.[1];
  assert.equal(bridgeName, 'mixdogDesktop');
  assert.match(renderer, new RegExp(`window\\.${bridgeName}\\b`));
});

test('desktop startup and automation never implicitly activate the remote bridge', async () => {
  const [runtime, daemon] = await Promise.all([
    readFile(new URL('../../../../src/session-runtime/runtime-core.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../../../src/standalone/channel-daemon.mjs', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(runtime, /remoteAutoStartRequested|claimIfVacant/);
  assert.match(runtime,
    /if \(rt\.remoteEnabled\) \{[\s\S]{0,500}?startRemote\(\);/);
  assert.match(runtime,
    /bootProfile\('channels:automation-autostart'\);[\s\S]{0,80}?void invokeChannelStart\(\);/);
  assert.match(daemon,
    /const messaging = remoteIntent === 'explicit';[\s\S]{0,100}?channels\.start\(\{ messaging \}\)/);
  assert.doesNotMatch(daemon, /remoteIntent === 'auto'/);
});

test('the stable composer placeholder does not schedule idle rerenders', async () => {
  const renderer = await readAppModules();
  assert.doesNotMatch(renderer, /placeholderIndex|setPlaceholderIndex/);
  assert.doesNotMatch(renderer, /setInterval\(\(\) => setPlaceholder/);
});

test('the transcript delegates reflow and bottom anchoring to one virtual timeline', async () => {
  const [renderer, follow, list, probe] = await Promise.all([
    readAppModules(),
    readFile(new URL('./use-transcript-follow.ts', import.meta.url), 'utf8'),
    readFile(new URL('./TranscriptList.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../main/jitter-probe.ts', import.meta.url), 'utf8'),
  ]);
  // 1. Virtual-core owns row geometry, bottom anchoring, and append following.
  assert.match(list, /anchorTo:\s*"end",/);
  assert.match(list, /followOnAppend:\s*true,/);
  assert.match(list, /scrollEndThreshold:\s*80,/);
  assert.match(list, /paddingEnd:\s*TRANSCRIPT_BOTTOM_SPACER,/);
  assert.match(list, /directDomUpdates:\s*true,/,
    'React must mirror Solid commit timing: transforms land in the core transaction, pre-paint');
  assert.match(list, /virtualizerRef\.current\.containerRef\(element\);/,
    'the spacer height must stay current between React commits');
  assert.match(list, /overscan:\s*50,/);
  assert.match(list, /defaultRangeExtractor\(\{ \.\.\.range, overscan: renderOverscan \}\)/);
  assert.match(list, /current < TRANSCRIPT_VIRTUAL_OVERSCAN \? TRANSCRIPT_VIRTUAL_OVERSCAN : current/);
  assert.match(list, /if \(shouldAnchorBottom\) virtualizerRef\.current\.scrollToEnd\(\);/);
  assert.match(list, /initialMeasurementsCache:\s*restored\?\.measurements/,
    're-entry must replay the real measurements, not re-derive estimates');
  assert.match(list,
    /initialOffset:\s*\(\) => \(shouldAnchorBottom \? Number\.MAX_SAFE_INTEGER : 0\)/,
    'OpenCode entry geometry is resolved from current follow intent before the first paint');
  assert.match(list,
    /rememberTranscriptVirtualMeasurements\(\s*sessionKey,\s*virtualizerRef\.current\.takeSnapshot\(\),/);
  assert.match(list,
    /shouldAdjustScrollPositionOnItemSizeChange = \(item, _delta, instance\) =>/,
    'the anchor-compensation predicate rides on the virtualizer instance');
  assert.match(list, /spacer\.current\.style\.height = `\$\{instance\.getTotalSize\(\)\}px`/);
  assert.match(list, /item\.end <= logicalScrollOffset\(instance\)/,
    'OpenCode reader anchoring compensates rows above the logical scroll offset');
  assert.match(list, /bottomAnchorSession\.current === sessionKey/,
    'OpenCode maybeAnchorBottom anchors once per session entry, not per rows change');
  assert.doesNotMatch(list, /queueMicrotask/,
    'virtual-core wasAtEnd owns the bottom pin during a rewrap — resizeItem must not add a second scroll writer');
  assert.match(list, /\.\.\.activeIndexesRef\.current/,
    'the active output rows stay mounted while the reader scrolls history');
  assert.match(list, /className="transcript-bottom-spacer"/);
  // 2. Outer follow is the React port of OpenCode createAutoScroll.
  assert.match(follow, /new ResizeObserver/);
  assert.match(follow, /element\.scrollTop = element\.scrollHeight/);
  assert.match(follow, /BOTTOM_THRESHOLD_PX = 10/);
  assert.match(follow, /data-scrollable/);
  assert.match(follow, /markAuto|isAuto/);
  assert.doesNotMatch(follow, /style\.width|restoreReadingAnchor|reflowingRef/);
  assert.match(follow, /GESTURE_WINDOW_MS = 250/);
  assert.match(follow, /element\.style\.overflowAnchor = "none"/);
  assert.match(follow, /if \(element !== target\) observer\.observe\(element\);/,
    'the shrinking composer/bottom-panel stack re-pins the bottom on viewport resize too');
  assert.doesNotMatch(follow, /inlineReflowFrame|viewportObserver|previousInlineSize/,
    'OpenCode parity must not add a second pane-width observer grammar');
  const widthProbe = probe.slice(
    probe.indexOf('const widthSnapshot'),
    probe.indexOf('const install', probe.indexOf('const widthSnapshot')),
  );
  assert.match(widthProbe, /busy:\s*true,/,
    'the width probe must exercise the working-only observer path');
  assert.match(widthProbe, /streamingTail:\s*\{/,
    'the width probe must keep one active timeline row');
  assert.match(probe, /const narrowWidth = 489;/,
    'the window sweep must include the reported narrow range');
  assert.match(probe, /maxNarrowBottomDistance:/,
    'the reported <=520px range must have its own strict bottom metric');
  assert.match(probe,
    /writes <= 2[\s\S]{0,240}?reversals <= 2 \* writes[\s\S]{0,160}?writeStacks\[0\]\.includes\('ResizeObserver\.'\)/,
    'the window sweep may resolve one OpenCode content-observer transaction per 768px crossing');
  assert.match(probe, /writes === 0 && reversals === 0/,
    'the physical sash path must remain write-free and reversal-free');
  assert.match(renderer, /className="transcript-live-part" data-streaming-tail="true"/);
  assert.match(renderer, /data-following=\{following \? "true" : "false"\}/);
  assert.match(renderer, /resumeFollowOnSubmitRef\.current\(\);/);
  // 3. Everything the hand-rolled anchoring needed is gone.
  assert.doesNotMatch(renderer,
    /TranscriptPinProvider|usePinTranscriptBottomOnCommit|toggleHoldUntil|scrollIntentUntil|pointerScrollIntent|widthReflowing|programmaticScroll|sessionScrollPositions|freezeContentWidth|freezeWidth|entryHoldFrame|data-entry-fade|prewarmRange/,
    'no time window, width freeze, or entry hold may guard transcript scrolling');
  assert.doesNotMatch(renderer, /jumpToLatestRef|jumpToLatest\("auto"\)/,
    'submit must not retain a second bottom-scroll authority');
  assert.doesNotMatch(renderer, /skipNextFollowFrame|bottomPinForced|measurementCaptureFrame/);
  assert.doesNotMatch(renderer, /restoringSessionTail|sessionTailRestoreTimer/);
});

test('terminal prefers WebGL rendering and safely retains the DOM fallback', async () => {
  const terminal = await readFile(new URL('./TerminalPane.tsx', import.meta.url), 'utf8');
  assert.match(terminal, /import \{ WebglAddon \} from '@xterm\/addon-webgl'/);
  assert.match(terminal, /function tryEnableWebglRenderer/);
  assert.match(terminal, /addon\.onContextLoss/);
  assert.match(terminal, /view\.webglUnavailable = true/);
  assert.match(terminal, /else term\.open\(container\);\s*tryEnableWebglRenderer\(view\);/);
  assert.match(terminal, /term\.onScroll\(schedulePersist\)/);
  assert.match(terminal, /window\.setTimeout\(\(\) => \{[\s\S]{0,180}writeTerminalViewState\(key, view\);[\s\S]{0,60}\}, 120\)/);
});

test('settings dialog reserves the native window-controls safe area', async () => {
  const [styles, settings] = await Promise.all([
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    readFile(new URL('./settings/settings.css', import.meta.url), 'utf8'),
  ]);
  assert.match(styles,
    /--settings-layer-safe-top:\s*max\(16px,\s*calc\(env\(titlebar-area-height,\s*0px\) \+ 8px\)\);/);
  assert.match(styles,
    /\.mixdog-settings-layer\s*\{[^}]*padding:\s*var\(--settings-layer-safe-top\) 16px var\(--settings-layer-safe-bottom\);/s);
  assert.match(settings,
    /\.mixdog-settings-v2\s*\{[^}]*height:\s*min\(650px,\s*calc\(var\(--vvh,\s*100vh\) - var\(--settings-layer-safe-top, 16px\) - var\(--settings-layer-safe-bottom, 16px\)\)\);/s);
  assert.match(settings,
    /@media \(max-width:\s*760px\),\s*\(max-height:\s*680px\)[\s\S]*html:not\(\[data-mixdog-mobile="1"\]\) \.mixdog-settings-layer\s*\{[^}]*--settings-layer-safe-top:\s*env\(titlebar-area-height,\s*0px\);[^}]*padding:\s*0;/s,
    'compact desktop settings must become full-bleed while retaining the native titlebar inset');
  assert.match(settings,
    /@media \(max-width:\s*640px\)[\s\S]*html:not\(\[data-mixdog-mobile="1"\]\) \.mixdog-settings-v2\s*\{[^}]*grid-template-columns:\s*48px minmax\(0,\s*1fr\);/s,
    'very narrow desktop settings must use the main 48px Activity Bar width');
  assert.match(settings,
    /html:not\(\[data-mixdog-mobile="1"\]\) \.mixdog-settings__rail-group button\s*\{[^}]*width:\s*47px;[^}]*height:\s*48px;[^}]*border-radius:\s*0;/s,
    'narrow settings category buttons must match the main Activity Bar cells');
  assert.match(settings,
    /html:not\(\[data-mixdog-mobile="1"\]\) \.mixdog-settings__rail-group button svg\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/s,
    'narrow settings icons must match the main Activity Bar icon scale');
  assert.match(settings,
    /html:not\(\[data-mixdog-mobile="1"\]\) \.mixdog-settings-v2 \.mixdog-settings__row,[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) var\(--settings-narrow-value-column\);/s,
    'narrow desktop option rows must reserve a contained shared value column');
  assert.match(settings,
    /\.settings-resource-title,\s*\.settings-form-row > div\.settings-resource-title\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*flex-wrap:\s*wrap;/s,
    'form status badges must remain inline with their titles');
  assert.match(settings,
    /html\[data-mixdog-mobile\] \.mixdog-settings-v2\s*\{[^}]*--settings-phone-value-column:\s*minmax\(0,\s*45%\);/s,
    'mobile options must define one shared value-column width');
  assert.match(settings,
    /html\[data-mixdog-mobile\] \.mixdog-settings-v2 \.mixdog-settings__row,\s*html\[data-mixdog-mobile\] \.mixdog-settings-v2 \.settings-form-row,\s*html\[data-mixdog-mobile\] \.mixdog-settings-v2 \.settings-resource\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) var\(--settings-phone-value-column\);[^}]*align-items:\s*center;/s,
    'every mobile option row must share one left-title and right-control grid');
  assert.match(settings,
    /html\[data-mixdog-mobile\] \.settings-row-control,\s*html\[data-mixdog-mobile\] \.settings-form-controls,\s*html\[data-mixdog-mobile\] \.settings-resource-control\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*justify-self:\s*stretch;[^}]*justify-content:\s*flex-end;/s,
    'every mobile option control must align against the shared right edge');
  assert.match(settings,
    /\.settings-agent-route \.settings-route-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*gap:\s*4px;/s);
  assert.match(settings,
    /\.settings-agent-route \.settings-route-controls > \*,[\s\S]*?\.settings-agent-route \.mx-select-trigger\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s,
    'agent model, effort, and fast controls must share the full value-column width');
  assert.match(settings,
    /\.settings-row-control > \.settings-model-trigger\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*justify-content:\s*flex-end;/s);
  assert.match(settings,
    /\.settings-row-control > \.effort-control,[\s\S]*?\.settings-row-control > \.fast-control\s*\{[^}]*width:\s*100%;[^}]*flex:\s*0 0 100%;/s,
    'model, effort, and fast controls must use one shared settings value column');
  assert.match(settings,
    /html\[data-mixdog-mobile\] \.settings-row-control > \.settings-model-trigger,\s*html\[data-mixdog-mobile\] \.settings-row-control \.mx-select-trigger,[\s\S]*?\.settings-agent-route \.mx-select-trigger\s*\{[^}]*justify-content:\s*flex-end;[^}]*text-align:\s*right;/s,
    'mobile route values must anchor to the shared right edge');
  assert.match(settings,
    /html\[data-mixdog-mobile\] \.settings-row-control \.mx-select-value,[\s\S]*?\.settings-agent-route \.settings-model-trigger > span\s*\{[^}]*flex:\s*0 1 auto;[^}]*text-align:\s*right;/s,
    'mobile route text must hug the right edge beside its chevron');
  assert.doesNotMatch(settings,
    /html\[data-mixdog-mobile\] \.settings-row-control:has\(/,
    'no mobile left-align exception may override the shared right anchor');
  assert.match(settings,
    /\.mixdog-settings-v2 \.settings-resource-title\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-start;/s,
    'resource status tags must stack under their names');
  assert.match(settings,
    /\.settings-row-control > \.settings-model-trigger > svg,[\s\S]*?\.settings-agent-route \.fast-control \.mx-select-trigger > svg\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;[^}]*color:\s*var\(--mx-icon-muted\);[^}]*opacity:\s*1;/s,
    'every route picker must use the same visible down-chevron geometry and color');
  assert.match(settings,
    /\.settings-model-trigger\[aria-expanded="true"\] > svg\s*\{\s*transform:\s*rotate\(180deg\);\s*\}/,
    'model and select chevrons must share the same expanded direction');
});

test('every renderer stylesheet resolves through the shared desktop theme contract', async () => {
  const [theme, layout, settings] = await Promise.all([
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
    readFile(new URL('./settings/settings.css', import.meta.url), 'utf8'),
  ]);
  const allCss = `${theme}\n${layout}\n${settings}`;
  const definitions = new Set([...allCss.matchAll(/(--mx-[\w-]+)\s*:/g)].map((match) => match[1]));
  const runtimeTokens = new Set(['--mx-scrollbar-thumb', '--mx-scrollbar-thumb-hover']);
  const unresolved = [...new Set([...allCss.matchAll(/var\((--mx-[\w-]+)/g)].map((match) => match[1]))]
    .filter((token) => !definitions.has(token) && !runtimeTokens.has(token));

  assert.deepEqual(unresolved, [], 'all shared theme tokens must have a renderer definition');
  assert.doesNotMatch(`${layout}\n${settings}`, /#[\da-f]{3,8}\b|rgba?\(/i,
    'layout and settings CSS must use semantic theme tokens rather than private colors');
  assert.doesNotMatch(allCss, /var\(--(?:base|sidebar|surface|surface-raised|surface-hover|input|border|border-strong|muted|accent|focus|danger)\s*[,)]/,
    'legacy pre-mx aliases are retired — every surface consumes the layered --mx-* contract');
  assert.doesNotMatch(allCss, /var\(--mx-[\w-]+\s*,\s*(?:#[\da-f]|rgba?\()/i,
    'defined --mx- tokens never carry literal color fallbacks that can drift from the sheet');
  assert.doesNotMatch(theme, /--mx-shell-border/,
    'the shell hairline consumes --mx-border-muted — no duplicate near-identical token');
  assert.match(theme,
    /--mx-text:\s*#e9e9e9;[^}]*--mx-text-muted:\s*#a8a8a8;[^}]*--mx-icon:\s*var\(--mx-text\);[^}]*--mx-icon-muted:\s*var\(--mx-text-muted\);/s,
    'dark neutral icons must share the same ink ramp as companion text');
  assert.match(theme,
    /:root\[data-mixdog-theme="light"\]\s*\{[^}]*--mx-text:\s*#1b1a17;[^}]*--mx-text-muted:\s*#635f57;[^}]*--mx-text-accent:\s*var\(--mx-blue-600\);[^}]*--mx-icon:\s*var\(--mx-text\);[^}]*--mx-icon-muted:\s*var\(--mx-text-muted\);[^}]*--mx-danger-bg:\s*#fceceb;[^}]*--mx-success-border:\s*#b8e9c1;/s,
    'light mode must align neutral icons with text and override every status semantic');
  assert.match(theme,
    /\.session-context-popover\s*\{[^}]*box-shadow:\s*var\(--mx-floating\);/s,
    'context popovers must use the same semantic floating elevation as other menus');
  assert.doesNotMatch(theme, /--mx-light-overlay-(?:shadow|border)/,
    'light overlays must use the shared elevation scale without a private override');
});

test('theme swaps stay atomic and registry palettes own every status plate', async () => {
  const [theme, themeModule, terminal] = await Promise.all([
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    readFile(new URL('./desktop-theme.ts', import.meta.url), 'utf8'),
    readFile(new URL('./TerminalPane.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(theme,
    /:root\[data-mixdog-theme-swap\] \*,[\s\S]*?\{[^}]*transition:\s*none\s*!important;/s,
    'a theme swap must freeze transitions so every surface recolors on one frame');
  assert.match(themeModule, /root\.setAttribute\(THEME_SWAP_ATTRIBUTE/,
    'applyDesktopTheme must raise the swap flag before it rewrites the variables');
  assert.match(themeModule, /root\.removeAttribute\(THEME_SWAP_ATTRIBUTE\)/,
    'the swap flag must be dropped again so hover transitions come back');
  assert.match(themeModule,
    /'--mx-success-border':\s*`color-mix\(in srgb, \$\{palette\.success\}/,
    'registry themes must draw the success hairline from their own green');
  assert.match(themeModule,
    /'--mx-approval-ring':\s*`color-mix\(in srgb, \$\{palette\.warning\}/,
    'registry themes must draw the approval ring from their own warning ink');
  assert.match(themeModule,
    /'--mx-icon':\s*palette\.text,[\s\S]*?'--mx-icon-muted':\s*palette\.inactive,/,
    'registry themes must derive neutral icon ink from their text ramp');
  assert.match(terminal,
    /black:\s*'#000000',[\s\S]*?brightWhite:\s*'#e5e5e5',/s,
    'the terminal must pin all 16 ANSI slots instead of inheriting xterm defaults');
});

test('Desktop shell keeps Project and flat recent sessions inside the sidebar rail', async () => {
  const [styles, navigation, titlebar] = await Promise.all([
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    Promise.all(['./titlebar.tsx', './WorkspaceTabStrip.tsx', './session-sidebar.tsx', './ActivityRail.tsx', './ProjectsView.tsx', './RowOverflowMenu.tsx'].map((path) => readFile(new URL(path, import.meta.url), 'utf8'))).then((parts) => parts.join('\n')),
    readFile(new URL('./titlebar.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(styles, /--titlebar-height:\s*35px/);
  assert.match(styles, /\.topbar\s*\{[^}]*height:\s*var\(--titlebar-height\);[^}]*align-items:\s*center;[^}]*padding:\s*0 0 0 5px;/s);
  assert.match(styles, /\.titlebar-caption-space\s*\{[^}]*env\(titlebar-area-width,\s*100vw\)/s);
  assert.match(styles, /--mx-bg-deep:\s*#141414;[\s\S]*?--mx-window-band:\s*#181818;[\s\S]*?--mx-workspace-sheet:\s*#1f1f1f;[\s\S]*?--mx-text:\s*#e9e9e9;/s);
  assert.match(styles, /:root\[data-mixdog-theme="light"\]\s*\{[^}]*--mx-bg-deep:\s*#f8f6f3;[^}]*--mx-window-band:\s*#f1efec;[^}]*--mx-workspace-sheet:\s*#faf8f5;[^}]*--mx-text:\s*#1b1a17;/s);
  assert.match(styles, /\.composer\s*\{[^}]*border-radius:\s*12px;[^}]*background:\s*var\(--mx-bg-base\);[^}]*box-shadow:\s*var\(--mx-raised\);/s);
  assert.match(styles,
    /\.workspace-tab\s*\{[^}]*height:\s*35px;[^}]*min-width:\s*var\(--workspace-tab-current-width,\s*50px\);[^}]*max-width:\s*var\(--workspace-tab-current-width,\s*160px\);[^}]*flex:\s*1 0 0;/s);
  // Flat Orca layout (user): flush panels, hairline separators, square edges.
  assert.match(styles, /\.desktop-body\s*\{[^}]*padding:\s*0;[^}]*border-top:\s*1px solid var\(--mx-border-muted\);[^}]*background:\s*var\(--mx-window-band\);/s);
  assert.match(styles, /\.sidebar\.session-sidebar\s*\{[^}]*width:\s*var\(--session-sidebar-width,\s*260px\);[^}]*min-width:\s*var\(--session-sidebar-min-width,\s*232px\);[^}]*flex:\s*0 0 var\(--session-sidebar-width,\s*260px\);[^}]*border-radius:\s*0;/s);
  assert.match(styles, /\.sidebar\.session-sidebar\s*\{[^}]*padding:\s*0 8px 8px;/s,
    "the sidebar keeps its side/floor insets but lets the header band reach the tab strip line");
  assert.match(styles, /\.session-sidebar \.task-link,[\s\S]*?\.session-sidebar \.session-row\s*\{[^}]*height:\s*36px;[^}]*min-height:\s*36px;/s);
  // Session rows override to a denser 31px (user: list read too airy).
  assert.match(styles, /\.session-sidebar \.session-row\s*\{[^}]*height:\s*31px;[^}]*min-height:\s*31px;/s);
  assert.match(styles, /\.session-list\s*\{\s*gap:\s*1px;/s);
  assert.match(styles,
    /\.session-row-status\s*\{[^}]*position:\s*absolute;[^}]*right:\s*8px;[^}]*top:\s*50%;[^}]*width:\s*12px;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*0;[^}]*pointer-events:\s*none;/s,
    'the working status must overlay the trailing fade instead of reserving title width');
  assert.doesNotMatch(styles, /\.session-row-status\s*\{[^}]*flex:/s,
    'session titles must not lose width to an empty status column');
  assert.match(styles, /\.session-row\.working \.session-row-copy\s*\{\s*padding-right:\s*18px;/s,
    'only a working title should stop before the trailing spinner');
  assert.match(styles,
    /\.session-row-spinner\s*\{[^}]*width:\s*12px;[^}]*display:\s*block;[^}]*margin:\s*0;[^}]*color:\s*var\(--mx-text-muted\);/s,
    'the static working arc must stay centered without adding a second margin');
  assert.doesNotMatch(styles, /\.session-row-spinner\s*\{[^}]*animation:/s,
    'visible session rows must not run a continuous spinner animation');
  assert.match(styles, /\.workspace\s*\{[^}]*margin:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(styles, /\.schedules-page\s*\{[^}]*max-width:\s*720px;/s);
  assert.match(styles, /\.transcript\s*\{[^}]*scrollbar-gutter:\s*stable;/s,
    'the viewport owns the one scrollbar reserve outside the reading column');
  // Control chrome (Activity Bar, New task, pickers) keeps the VS Code rail
  // geometry stable against 400 content rows.
  assert.match(styles, /\.activity-rail\s*\{[^}]*width:\s*48px;[^}]*min-width:\s*48px;/s,
    "the Activity Bar must hold VS Code's stable 48px rail width");
  assert.match(styles, /\.activity-rail > button\s*\{[^}]*width:\s*47px;[^}]*height:\s*48px;[^}]*display:\s*grid;[^}]*place-items:\s*center;/s,
    "rail buttons must center their glyphs inside the 48px square");
  assert.match(styles, /\.topbar \.titlebar-update::before\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*border-radius:\s*999px;/s,
    "the compact update badge follows the updater into the window bar");
  assert.match(styles, /\.session-panel-header\s*\{[^}]*height:\s*36px;[^}]*color:\s*var\(--mx-text\);[^}]*font:\s*600 15px\/22px/s,
    "the session panel title tops the chrome ramp inside the tab strip band");
  assert.doesNotMatch(styles, /\.session-panel-header\s*\{[^}]*text-transform:\s*uppercase;/s,
    "panel titles dropped the uppercase caps tracking (user: 타이틀 폰트)");
  assert.match(styles, /\.session-panel-header-actions\s*\{[^}]*gap:\s*4px;/s,
    "rail title actions keep the pane-header spacing rhythm");
  assert.match(styles, /\.session-panel-action\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/s,
    "rail panels hand their primary action to a pane-sized click target");
  assert.match(styles, /\.session-sidebar-panels \.row-overflow-trigger\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/s,
    "rail row menus keep the same reachable click target");
  assert.match(styles, /\.utility-dock-header-actions\s*\{[^}]*gap:\s*4px;/s,
    "dock title actions keep enough separation for independent clicks");
  assert.match(styles,
    /\.utility-dock-header-actions > button,[\s\S]*?\.utility-dock-header-actions \.row-overflow-trigger\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*flex:\s*0 0 28px;/s,
    "dock title actions share the pane-sized click target");
  assert.match(styles, /\.sidebar-recent-heading\s*\{[^}]*font-size:\s*var\(--mx-font-ui\);[^}]*font-weight:\s*var\(--mx-weight-semibold\);/s,
    "section headings sit on the single 13px chrome scale");
  assert.match(styles,
    /\.sidebar-recent-heading\.sidebar-heading-toggle\s*\{[^}]*font-size:\s*var\(--mx-font-emphasis\);[^}]*font-weight:\s*var\(--mx-weight-semibold\);[^}]*color:\s*var\(--mx-text-muted\);/s,
    "collapsible rail section names should sit on the 14/semibold muted category tier");
  assert.match(styles,
    /\.session-sidebar-scroll > \.sidebar-recent \+ \.sidebar-recent\s*\{\s*margin-top:\s*2px;/s,
    "adjacent session categories should keep a compact separation");
  assert.match(styles,
    /\.session-sidebar-panels \.workflows-models h2\s*\{[^}]*margin:\s*6px 0 0;[^}]*color:\s*var\(--mx-text-muted\);/s,
    "workflow category names should share the Sessions muted category tier");
  assert.match(styles,
    /\.session-sidebar-panels \.workflows-packs > \.workflows-section-head\s*\{\s*padding-top:\s*0;/s,
    "the first workflow category should bind directly below the panel header");
  assert.match(styles,
    /\.session-sidebar-panels \.workflows-section-head\s*\{[^}]*padding:\s*6px 0 0;/s,
    "the Agents category should use the same compact section break");
  assert.match(styles,
    /\.session-sidebar-panels,\s*\.utility-dock\s*\{[^}]*--mx-rail-item-surface:\s*color-mix\(in srgb,\s*var\(--mx-text\) 6%,\s*transparent\);[^}]*--mx-rail-item-outline:\s*color-mix\(in srgb,\s*var\(--mx-text\) 14%,\s*transparent\);[^}]*--mx-rail-item-outline-active:\s*color-mix\(in srgb,\s*var\(--mx-text\) 20%,\s*transparent\);/s,
    "rail destinations should share one restrained item surface");
  assert.match(styles,
    /\.session-sidebar-panels \.schedules-list\s*\{\s*gap:\s*6px;/s,
    "two-line rail cards keep the user-tuned 6px air between rows");
  assert.match(styles,
    /\.session-sidebar-panels \.schedules-row\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*8px;[^}]*background:\s*var\(--mx-rail-item-surface\);[^}]*box-shadow:\s*inset 0 0 0 \.5px var\(--mx-rail-item-outline\);/s,
    "Projects, Workflows, Webhooks, and Schedules should share subtle item chrome");
  assert.match(styles,
    /\.session-sidebar-panels \.workflows-agent-summary-row > \.row-overflow\s*\{[^}]*align-self:\s*center;/s,
    "agent overflow menus should stay vertically centered beside the two-line summary");
  assert.match(styles, /\.sidebar-heading-dot\s*\{[^}]*width:\s*6px;[^}]*height:\s*6px;[^}]*margin:\s*0 4px 0 auto;/s,
    "collapsed group activity dots must share the session rows' trailing edge");
  assert.match(styles,
    /\.sidebar-recent-heading\.sidebar-heading-toggle svg\s*\{[^}]*transform:\s*translateY\(1px\);/s,
    "sidebar disclosure chevrons must sit on the title's optical center");
  // Phone drawer: the sidebar overlays the thread instead of squeezing it
  // out of a 390px viewport (user: "message pane not visible" on a phone).
  assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*html\[data-mixdog-mobile\] \.sidebar\.session-sidebar,[\s\S]*?position:\s*fixed;[\s\S]*?transform:\s*translateX\(-100%\)/);
  assert.match(styles, /\.sidebar-backdrop\s*\{\s*display:\s*none;\s*\}/);
  assert.match(styles, /html\[data-mixdog-mobile\] \.sidebar\.session-sidebar\[data-state="open"\]\s*\{[^}]*transform:\s*none;/);
  assert.match(navigation, /aria-label=\{t\(["']Session manager["']\)\}/);
  assert.match(navigation, /session\.classification === "task" \|\| session\.classification === "project"/);
  assert.match(navigation, /className="schedules-list projects-list"/);
  assert.match(navigation, /"Open projects"/);
  assert.match(navigation, /className="sidebar-primary-nav"/);
  assert.match(navigation, /tooltip: "Projects"/);
  assert.match(navigation, /icon: PanelsTopLeft/);
  assert.match(navigation, /<RowOverflowMenu label=\{`Actions for \$\{title\}`\}/);
  assert.match(navigation, /width = 132,/);
  assert.match(styles, /\.row-overflow\s*\{[^}]*margin-left:\s*auto;/s);
  assert.match(styles, /\.row-overflow-menu\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*420;/s);
  assert.match(navigation, /className="sidebar-recent-heading[^"]*"/);
  assert.match(navigation, /className="session-list recent-session-list"/);
  assert.doesNotMatch(navigation, /className="sidebar-projects"|project-group-toggle|standalone-group/);
  // Grok-web recent list: plain titles, no per-row glyph.
  assert.doesNotMatch(navigation, /session-row-icon/);
  assert.doesNotMatch(styles, /\.session-search\b/);
  assert.doesNotMatch(navigation, /Search sessions|sessionQuery/);
  assert.doesNotMatch(navigation, /project-avatar-v2|ProjectAvatar/);
  assert.doesNotMatch(navigation, /<StatusPopover\s*\/>/);
  assert.doesNotMatch(navigation, /LayoutGrid|workspace-tab-layout|titlebar-home|topbar-settings/);
});

test('workflow picker sits beside Project above the composer and is absent from the sidebar', async () => {
  const [conversation, sidebar, controls, styles] = await Promise.all([
    readFile(new URL('./Conversation.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./session-sidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./model-controls.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
  ]);
  assert.match(conversation,
    /composer-context-bar[\s\S]*?<ProjectContextSelector[\s\S]*?<WorkflowSelect/);
  assert.match(conversation,
    /<WorkflowSelect workflow=\{\(draftWorkflow \|\| routeSnapshot\.workflow as RecordValue \| null\) \?\? null\}/);
  assert.doesNotMatch(sidebar, /workflowControl|sidebar-workflow-select/,
    'the workflow picker must not remain in the sidebar');
  assert.match(controls,
    /<div className="composer-route-workflow">[\s\S]*?<OpenSelect variant="route" className="workflow-context-select"/);
  assert.match(styles,
    /\.composer-context-bar\s*\{[^}]*min-height:\s*28px;[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*6px;/s);
  assert.match(styles,
    /\.composer-route-workflow\s*\{[^}]*height:\s*28px;[^}]*background:\s*var\(--mx-bg-layer-1\);[^}]*box-shadow:\s*0 0 0 \.5px var\(--mx-border\);/s);
});

test('rail destinations live in the session panel with popup editors', async () => {
  const [app, activityRail, paneWorkspace, schedules, webhooks, workflows, projects, studio, styles] = await Promise.all([
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./ActivityRail.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./PaneWorkspace.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./SchedulesView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./WebhooksView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./WorkflowsView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./ProjectsView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./StudioView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(app, /takeoverPaneActive|fullPagePane/,
    'rail destinations must never take over the pane workspace');
  // The four panels live in ONE memoised fragment (fast tab switches must not
  // re-render the sidebar tree), and that fragment is what SessionSidebar
  // receives as its panel-area children.
  assert.match(app,
    /const sidebarPanelChildren = useMemo\(\(\) => <>[\s\S]*?<SchedulesPane[\s\S]*?<WebhooksPane[\s\S]*?<WorkflowsPane[\s\S]*?<ProjectsPane[\s\S]*?<\/>/,
    'the four rail destinations render from the memoised sidebar panel fragment');
  assert.match(app,
    /<SessionSidebar[\s\S]*?\{sidebarPanelChildren\}[\s\S]*?<\/SessionSidebar>/,
    'the memoised rail destinations render inside the session sidebar panel area');
  assert.match(app, /renderFileEditors=\{paneFileEditors\}/);
  assert.doesNotMatch(app, /setActiveFileKey/,
    'the focused pane selection, not a global key, owns the active file');
  assert.match(activityRail, /onClick=\{selected \? onCloseActiveSurface : onOpen\}/,
    'every selected rail destination must share one sidebar-close path');
  assert.match(app,
    /const closeActiveRailPanel = useCallback\(\(\) => \{[\s\S]*?closeSidebarPanels\(\);[\s\S]*?sidebarOpenIntent\.current = false;[\s\S]*?beginSidePanelClose\("sidebar", \(\) => applySidebarOpen\(false\)\)/,
    're-selecting a rail destination must collapse the sidebar and reset it to Sessions');
  assert.match(app, /onCloseActiveSurface=\{closeActiveRailPanel\}/);
  assert.match(app,
    /const sidebarOpenStudio = useStableEvent\(\(\) => \{[\s\S]*?closeSidebarForNavigation\(\);[\s\S]*?openStudioTab\(\)/,
    'Studio sidebar navigation must reveal or create its ordinary workspace tab');
  assert.match(app, /onOpenStudio=\{sidebarOpenStudio\}/,
    'the sidebar receives the stable Studio handler, not a fresh closure');
  assert.match(app, /renderUtilityTabs=\{paneUtilityTabs\}/);
  assert.match(paneWorkspace, /active\?\.kind === "studio" \|\| active\?\.kind === "terminal"/);
  assert.match(paneWorkspace, /active\?\.kind === "file" && renderFileEditors/);
  for (const source of [schedules, webhooks, workflows, projects]) {
    assert.match(source, /createPortal\(<div className="schedules-dialog-layer"/,
      'panel editors must portal above the sidebar as popup dialogs');
    assert.doesNotMatch(source, /takeover-close/,
      'panel lists carry no close button — the rail toggles them');
  }
  assert.doesNotMatch(studio, /aria-label="Close studio"|onClick=\{onClose\}/,
    'Studio closes only from its ordinary workspace tab');
  assert.doesNotMatch(styles, /\.takeover-close/);
  assert.match(styles,
    /\.session-sidebar-panels \.stable-takeover-surface\[data-surface-active="false"\]\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s,
    'inactive panel lists must leave flow while staying mounted for stable layout');
  assert.doesNotMatch(styles,
    /\.session-sidebar-panels \.stable-takeover-surface\[data-surface-active="false"\]\s*\{[^}]*display:\s*none;/s,
    'inactive panel lists must remain measurable before the atomic handoff');
});

test('Maintainer keeps its default model row but stays out of workflow agent choices', async () => {
  const [view, styles] = await Promise.all([
    readFile(new URL('./WorkflowsView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
  ]);
  assert.match(view,
    /HIDDEN_WORKFLOW_AGENT_IDS = new Set\(\['scheduler-task', 'webhook-handler'\]\)/);
  assert.match(view, /DEFAULT_AGENT_IDS = new Set\(\['maintainer', 'explore'\]\)/);
  assert.match(view, /workflowAgents = agentRoster\.filter\(\(agent\) => !DEFAULT_AGENT_IDS\.has\(agent\.id\)\)/);
  assert.match(view, /pack=\{editor\.pack\} agents=\{workflowAgents\}/);
  assert.match(view, /editableAgents = agentRoster\.filter\(\(agent\) => !DEFAULT_AGENT_IDS\.has\(agent\.id\)\)/);
  // Web search, Explore, and Maintainer share the shared-service section.
  assert.equal((view.match(/workflows-default-agent-summary-row/g) || []).length, 3);
  assert.match(view, /const maintainerAgent = agentRoster\.find/);
  assert.match(view, /const maintainerRow = agents\.find/);
  assert.doesNotMatch(view, /workflows-row-action-spacer/);
  assert.match(styles,
    /\.session-sidebar-panels \.workflows-agent-summary-row > \.row-overflow\s*\{[^}]*align-self:\s*center;/s);
  assert.match(view,
    /aria-label=\{t\(["']Workflows["']\)\}>[\s\S]*?className="workflows-section-head"[\s\S]*?<h2>\{t\(['"]Workflows['"]\)\}<\/h2>[\s\S]*?aria-label=\{t\(["']New workflow["']\)\}/);
});

test('agent creation asks for Name without exposing its internal ID', async () => {
  const view = await readFile(new URL('./WorkflowsView.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /name="agent-id"|>ID\s*</);
  assert.match(view, /\.\.\.\(editing \? \{ id: String\(agent\?\.id \|\| ''\) \} : \{\}\)/);
  assert.match(view,
    /name="agent-name"[\s\S]*?placeholder=\{t\(["']Agent name["']\)\} required autoFocus=\{!editing\}/);
});

test('workspace tabs compress contiguously without scrolling selected neighbors out of the strip', async () => {
  const [layout, theme, navigation] = await Promise.all([
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    Promise.all(['./titlebar.tsx', './WorkspaceTabStrip.tsx', './session-sidebar.tsx', './ProjectsView.tsx'].map((path) => readFile(new URL(path, import.meta.url), 'utf8'))).then((parts) => parts.join('\n')),
  ]);

  assert.match(layout, /\.workspace-tabs\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.match(theme, /\.workspace-tabs\s*\{[^}]*gap:\s*0;[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s);
  assert.match(theme,
    /\.workspace-tab\s*\{[^}]*min-width:\s*var\(--workspace-tab-current-width,\s*50px\);[^}]*max-width:\s*var\(--workspace-tab-current-width,\s*160px\);[^}]*flex:\s*1 0 0;/s);
  assert.doesNotMatch(navigation, /TAB_MIN_WIDTH|ACTIVE_TAB_MIN_WIDTH|TAB_GAP/,
    "browser flex layout must own tab compression instead of a JS width calculator");
  assert.doesNotMatch(navigation, /scrollIntoView/,
    'selecting a desktop tab must not move the strip and eject its neighbors');
  assert.doesNotMatch(theme, /workspace-tabs-fade|workspace-tabs-scroll/,
    'tab-strip CSS must not mask either edge of a visible tab');
  assert.doesNotMatch(navigation, /workspace-tabs-fade/,
    'titlebar markup must not render overlays above tab labels');
});

test('copy hover changes only icon color while keyboard focus keeps its frame', async () => {
  const styles = await readFile(new URL('./desktop.css', import.meta.url), 'utf8');
  assert.match(styles, /\.message-actions:hover\s*\{[^}]*color:\s*var\(--mx-icon\);[^}]*background:\s*transparent;[^}]*outline:\s*0;/s);
  assert.match(styles, /\.message-actions:focus-visible\s*\{[^}]*background:\s*transparent;[^}]*outline:\s*2px solid var\(--mx-focus\);/s);
  assert.match(styles, /\.markdown-code-copy:hover\s*\{[^}]*color:\s*var\(--mx-icon\);[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.markdown-code-copy:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--mx-focus\);/s);
  assert.doesNotMatch(styles, /\.message\.assistant\.settled,\s*\.tool-card\.settled\s*\{[^}]*content-visibility:\s*auto;/s,
    'virtualized transcript rows must not add a second content-visibility layer');
  assert.doesNotMatch(styles, /\.message\.settled,\s*\.tool-card\.settled/);
  assert.doesNotMatch(styles, /\.message\.assistant\.streaming \.markdown > :nth-last-child/,
    'streamed response prose must remain readable; shimmer belongs to compact status text only');
  assert.match(styles,
    /\.message\.assistant \.response-footer:has\(\.turn-status\)\s*\{[^}]*min-height:\s*24px;[^}]*margin-top:\s*16px;/s,
    'completion footer geometry must replace the live activity lane without moving the response body');
  assert.match(styles,
    /\.transcript-virtual-row\s*\{[^}]*overflow:\s*clip;/s,
    'hidden rows never reach the timeline, and a row box clips to its measured geometry');
  assert.doesNotMatch(styles, /\.tool-header:hover:not\(:disabled\) \.tool-icon/,
    'tool icons should retain their status color on hover');
  assert.match(styles,
    /\.tool-header:hover:not\(:disabled\) \.tool-chevron,[\s\S]*\.tool-header:focus-visible \.tool-icon,[\s\S]*\.tool-header:focus-visible \.tool-chevron\s*\{[^}]*color:\s*var\(--mx-icon\);/s,
    'tool disclosures should keep chevron hover feedback and keyboard focus feedback');
  assert.match(styles,
    /\.composer-attachments > div:hover,\s*\.composer-attachments > div:focus-within\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--mx-border-strong\);/s,
    'composer attachments should expose the same hover/focus boundary as the reference UI');
});

test('desktop media byte lane is CORS-enabled before app readiness', async () => {
  const source = await readFile(new URL('../main/media-protocol.ts', import.meta.url), 'utf8');
  assert.match(source,
    /privileges:\s*\{[^}]*standard:\s*true,[^}]*secure:\s*true,[^}]*supportFetchAPI:\s*true,[^}]*corsEnabled:\s*true,[^}]*stream:\s*true,/s);
  assert.match(source, /'Access-Control-Allow-Origin':\s*'\*'/);
});

test('session title actions, message hover rows, and tool disclosures keep the desktop rhythm', async () => {
  const [styles, navigation, app] = await Promise.all([
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    Promise.all(['./titlebar.tsx', './WorkspaceTabStrip.tsx', './session-sidebar.tsx', './ProjectsView.tsx'].map((path) => readFile(new URL(path, import.meta.url), 'utf8'))).then((parts) => parts.join('\n')),
    readAppModules(),
  ]);
  assert.match(styles, /\.session-row-menu-wrap\s*\{[^}]*width:\s*24px;[^}]*flex:\s*0 0 24px;/s);
  assert.match(styles, /\.session-row-copy b\s*\{[^}]*text-overflow:\s*clip;[^}]*white-space:\s*nowrap;/s);
  assert.doesNotMatch(styles, /\.message\.user\.attached-user\s*\{[^}]*margin-top:/s);
  assert.match(styles,
    /\.thread\s*\{[^}]*width:\s*100%;[^}]*padding:\s*20px 0 0;[^}]*gap:\s*0;/s);
  assert.match(styles,
    /\.transcript-virtual-row-content\[data-tag="UserMessage"\],[\s\S]*?padding-bottom:\s*12px;[\s\S]*?\.transcript-turn-gap\s*\{\s*height:\s*20px;/,
    'part and turn spacing must be measured timeline geometry, not a container gap');
  assert.doesNotMatch(styles, /\.conversation:has\(\.turn-review-bar\) \.thread/,
    'the thread must not reserve review space through a container selector');
  assert.match(styles,
    /\.turn-review-slot\s*\{[^}]*position:\s*relative;[^}]*width:\s*100%;/s);
  assert.doesNotMatch(styles, /\.turn-review-slot\s*\{[^}]*position:\s*absolute;/s,
    'the review bar must consume timeline layout instead of overlaying rows');
  assert.match(styles,
    /\.turn-review-slot:has\(\.turn-review-bar\)\s*\{[^}]*margin-bottom:\s*8px;/s);
  assert.match(styles, /\.turn-review-summary\s*\{[^}]*min-height:\s*28px;/s,
    'the collapsed review must retain a readable control row');
  assert.doesNotMatch(styles, /--mx-turn-review-slot/,
    'an absent review bar must not reserve permanent transcript space');
  // OpenCode session-turn-diffs: review is the last block of the SCROLLED
  // timeline. In the composer stack its late arrival resized the viewport and
  // shifted the whole surface on session entry (measured 118 -> 154px).
  assert.match(app,
    /<TranscriptList[\s\S]*?<div className="turn-review-slot">[\s\S]*?<TurnReviewBar[\s\S]*?<\/div>\}?[\s\S]*?<div className="composer-region">/,
    'the review bar must grow scrolled timeline content, never the viewport');
  assert.match(app,
    /<TranscriptList[\s\S]*?<div className="turn-review-slot">[\s\S]*?<TurnReviewBar[\s\S]*?<\/div>\}?[\s\S]*?<div className="composer-region">/,
    'the review bar must grow scrolled timeline content, never the viewport');
  assert.match(styles,
    /@container chat-pane \(min-width: 768px\)[\s\S]*?\.turn-review-slot \{[\s\S]*?max-width: 800px;/,
    'the review bar must ride the same centered frame as every projected row');
  assert.match(app, /content: thread,/,
    'auto-scroll must observe the thread that contains BOTH the rows and the review');
  assert.doesNotMatch(styles, /\.message\.user \+ \.message\.assistant\s*\{[^}]*margin-top:/s);
  assert.match(styles, /\.message\.user \.message-meta-line\s*\{[^}]*position:\s*absolute;[^}]*width:\s*100%;/s);
  assert.match(styles, /\.tool-title\s*\{[^}]*flex:\s*1 1 auto;/s);
  assert.match(styles,
    /\.tool-title b \[data-component="text-shimmer"\],[\s\S]*?\.tool-title b \[data-slot="text-shimmer-char"\]\s*\{[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(styles,
    /\.tool-icon\s*\{[^}]*height:\s*20px;[^}]*align-self:\s*center;[^}]*place-items:\s*center;[^}]*line-height:\s*0;[^}]*transform:\s*translateY\(-1px\);/s);
  assert.match(styles,
    /\.live-activity-icon\s*\{[^}]*height:\s*20px;[^}]*align-self:\s*center;[^}]*place-items:\s*center;[^}]*line-height:\s*0;[^}]*transform:\s*translateY\(-1px\);/s);
  assert.match(styles, /\.live-activity-spinner\s*\{[^}]*animation:\s*spin 1400ms linear infinite;/s);
  assert.match(styles,
    /\.live-activity \[data-component="text-shimmer"\]\s*\{[^}]*--text-shimmer-duration:\s*2600ms;/s);
  assert.match(styles,
    /\.live-activity \[data-component="text-shimmer"\]\s*\{[^}]*font-weight:\s*var\(--mx-weight-semibold\);/s);
  assert.match(styles,
    /\.turn-status\.complete,[\s\S]*?\.turn-status\.interrupted\s*\{[^}]*font-weight:\s*var\(--mx-weight-semibold\);/s);
  assert.match(styles,
    /\.turn-status\.complete,\s*\.turn-status\.success\s*\{[^}]*color:\s*var\(--mx-accent\);/s);
  assert.match(styles,
    /\.turn-status\.complete svg,\s*\.turn-status\.success svg\s*\{[^}]*color:\s*var\(--mx-accent\);/s);
  assert.match(styles,
    /\.turn-status\.failed\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;/s);
  const retryRule = styles.match(/\.turn-retry\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(retryRule, /font-weight:\s*var\(--mx-weight-semibold\);/);
  assert.doesNotMatch(retryRule, /grid-row:\s*2/,
    "Retry must stay to the right of Failed on the same row");
  assert.match(styles,
    /\.compaction-divider\s*\{[^}]*color:\s*var\(--mx-accent\);[^}]*font-weight:\s*var\(--mx-weight-semibold\);/s);
  assert.match(styles,
    /\[data-component="text-shimmer"\]\[data-active="true"\] \[data-slot="text-shimmer-char"\]\s*\{[^}]*animation:\s*transcript-text-shimmer var\(--text-shimmer-duration\) linear infinite;/s,
    'active status and running tool titles must retain their shimmer feedback');
  assert.match(styles,
    /\.queue-items\s*\{[^}]*max-height:\s*130px;[^}]*padding:\s*6px 12px;/s);
  assert.match(styles,
    /\.queue-item\s*\{[^}]*min-height:\s*28px;[^}]*gap:\s*6px;[^}]*padding:\s*0;/s);
  // The resolved @tanstack/virtual-core (3.17.x) consults the size-change
  // predicate as an INSTANCE property, not a useVirtualizer option — passing
  // it in options silently reverts to the library default and the anchor
  // compensation fights user wheel input (measured scroll reversals).
  assert.match(app, /\.shouldAdjustScrollPositionOnItemSizeChange = \(item, _delta, instance\) =>/,
    "the anchor-compensation predicate must be assigned on the virtualizer instance");
  assert.doesNotMatch(app, /shouldAdjustScrollPositionOnItemSizeChange:\s*\(/,
    "the predicate must not ride in useVirtualizer options — 3.17 cores ignore it there");
  assert.match(styles, /\.tool-card\[data-open="true"\] \.tool-chevron svg\s*\{[^}]*rotate\(90deg\)/s);
  assert.match(styles, /\.shell-output\s*\{[^}]*border:\s*1px solid var\(--mx-border-muted\);[^}]*border-radius:\s*8px;/s);
  assert.match(styles, /\.session-header-content\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*margin:\s*0 auto;[^}]*padding:\s*12px 16px;/s);
  assert.match(styles,
    /\.composer-region\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*margin:\s*0 auto;[^}]*padding:\s*0 12px 16px;/s,
    'OpenCode dock parity keeps a 12px outer inset on the shared centered frame');
  assert.match(styles, /\.session-header-content h1\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*min\(52ch,\s*100%\);[^}]*flex:\s*0 1 auto;/s);
  assert.match(styles, /\.session-title-trigger\s*\{[^}]*width:\s*100%;[^}]*padding:\s*0;/s);
  assert.match(styles, /\.session-header-title-input\s*\{[^}]*field-sizing:\s*content;[^}]*width:\s*auto;[^}]*max-width:\s*100%;[^}]*padding:\s*0;/s);
  assert.match(styles, /\.session-project-badge\s*\{[^}]*flex:\s*0 1 auto;/s);
  assert.match(styles,
    /\.welcome-logo\s*\{[^}]*width:\s*256px;[^}]*height:\s*256px;[^}]*opacity:\s*\.08;/s,
    'the empty workspace must use a large quiet watermark instead of an app-card');
  assert.doesNotMatch(styles, /\.welcome-wordmark\s*\{/,
    'the empty workspace must not repeat the product wordmark');
  assert.doesNotMatch(styles,
    /@media \(min-width:\s*761px\) and \(max-width:\s*1024px\)\s*\{[^}]*\.(?:thread|composer-region)/s,
    'window media queries must not override pane-owned transcript or composer widths');
  assert.match(styles, /\.mixdog-settings__close\s*\{[^}]*flex:\s*0 0 24px;[^}]*place-items:\s*center;/s);
  assert.match(styles, /\.command-surface-header-actions\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /\.session-context-indicator > button\s*\{[^}]*place-items:\s*center;/s);
  assert.match(styles, /\.session-header-status\s*\{[^}]*margin-left:\s*auto;/s);
  assert.match(styles, /\.live-work-status\s*\{[^}]*margin-left:\s*0;/s);
  assert.match(styles, /\.composer-mic\s*\{[^}]*margin-left:\s*6px;[^}]*margin-right:\s*8px;/s);
  assert.match(styles,
    /\.chat-live-work\s*\{[^}]*position:\s*absolute;[^}]*right:\s*12px;[^}]*bottom:\s*calc\(100% \+ 20px\);/s);
  assert.doesNotMatch(styles, /\.composer-region:has\(\.turn-review-bar\) \.chat-live-work/);
  assert.match(styles, /\.chat-live-work \.live-work-status\s*\{[^}]*height:\s*20px;/s);
  assert.match(styles, /\.live-activity-status\s*\{[^}]*min-height:\s*24px;/s);
  // The stop state shares the send-button surface verbatim: same disc, same
  // 15px glyph scale, no pulse animation (user: match the send button).
  assert.doesNotMatch(styles, /send-stop-pulse/);
  assert.match(app,
    /<header className="session-header" aria-label="Current task">[\s\S]*?className="session-header-status"[\s\S]*?<PaneHeaderStatus focused=\{focused\}/,
    'each pane must own its context/remote cluster at the right edge of its task header');
  assert.doesNotMatch(app, /trailing=\{trailing\}/,
    'the tab strip must not host the header cluster; the pane task header owns it');
  assert.doesNotMatch(app, /workspace-corner-controls/,
    'desktop chat controls must not float over transcript content');
  assert.match(app, /capability:\s*enabled \? "claimRemote" : "releaseRemote"/);
  assert.match(app, /if \(result\?\.snapshot !== undefined\) applySnapshot\(result\.snapshot\)/);
  assert.doesNotMatch(app, /capability:\s*"toggleRemote"[\s\S]{0,160}\.catch\(\(\) => \{\}\)/);
  // Background-activity chip floats over the chat top-right (user decision):
  // the header keeps only the context indicator.
  assert.match(app, /function SnapshotLiveWork[\s\S]*?className="chat-live-work"[\s\S]*?<LiveWorkStatus snapshot=\{visibleSnapshot\} \/>/);
  assert.equal((app.match(/<LiveWorkStatus\b/g) || []).length, 2,
    'focused and unfocused pane sources each render the shared live-work component');
  assert.match(navigation,
    /aria-label=\{confirmingDelete[\s\S]*?: t\("Delete \{\{name\}\}", \{ name: sessionLabel\(session\) \}\)\}/,
    'delete confirmation must update one retained action button instead of replacing its DOM');
  assert.doesNotMatch(navigation, /confirmingDelete \? \(\s*<>/,
    'the archived-row action pair must not remount when confirmation starts');
});

test('phone header uses the roomier mobile scale', async () => {
  const [styles, app] = await Promise.all([
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(styles, /\.app-shell\s*\{\s*--titlebar-height:\s*64px;/);
  assert.match(styles, /\.session-header\s*\{[^}]*flex-basis:\s*64px;[^}]*min-height:\s*64px;/s);
  assert.match(styles, /\.session-header-content\s*\{[^}]*height:\s*64px;[^}]*grid-template-columns:/s);
  assert.match(styles, /\.session-header-content h1\s*\{[^}]*font-size:\s*16px;[^}]*line-height:\s*24px;/s);
  assert.match(styles, /\.session-project-badge\s*\{[^}]*height:\s*22px;[^}]*font-size:\s*var\(--mx-font-minor\);[^}]*line-height:\s*22px;/s);
  assert.match(styles, /\.session-header-menu \.sidebar-toggle-icon,[^}]*\.session-dock-toggle svg\.lucide\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s);
  assert.match(styles, /@media \(pointer:\s*coarse\)\s*\{[^}]*\.toolbar-sidebar\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;/s);
  assert.match(styles,
    /@media \(hover:\s*none\) and \(pointer:\s*coarse\)\s*\{[\s\S]*?\.session-header-menu:hover,[\s\S]*?\.session-dock-toggle:hover\s*\{[^}]*background:\s*transparent;/s);
  assert.match(app, /renderUtilityTabs=\{paneUtilityTabs\}/);
});

test('conversation uses native scrolling and silent session transitions', async () => {
  const renderer = await readAppModules();
  assert.doesNotMatch(renderer, /TranscriptRail|Previous user message|Next user message|message-navigation|navigateMessage/);
  assert.doesNotMatch(renderer, /Opening session|Resuming conversation/);
  assert.match(renderer, /if \(mode === "resuming"\) \{/);
  assert.doesNotMatch(renderer, /session-switch-overlay|data-settling|data-staging|threadStaging/);
  assert.doesNotMatch(renderer, /useCachedMeasurements:\s*true/);
  assert.doesNotMatch(renderer, /sessionRowMeasurements|revealedTranscriptKey|data-measurement-key/);
  assert.match(renderer, /anchorTo:\s*"end"/);
  assert.match(renderer, /followOnAppend:\s*true/);
  assert.match(renderer, /scrollEndThreshold:\s*80/);
  assert.doesNotMatch(renderer, /observer\.observe\(contentElement\)|element\.scrollTop = bottomOffset\(element\)/,
    'virtual-core owns append growth and width reflow without a second layout observer');
  assert.match(renderer, /pendingResumeTarget/);
  assert.match(renderer,
    /const markdownReady = preloadMarkdownBody\(\)[\s\S]*?markdownReady\.finally/,
    'session navigation must warm Markdown without blocking tab completion');
  assert.match(renderer, /const conversationFrozenSnapshot = frozenSnapshot;/,
    'Markdown readiness must not freeze composer route, queue, or command state');
  assert.match(renderer,
    /transcriptPending=\{Boolean\(paneSessionId\) && paneTranscriptRendererPending\}/,
    'every cold session pane should stay neutral until its transcript and Markdown are ready');
  assert.doesNotMatch(renderer, /conversationFrozenSnapshot = transcriptRendererPending/,
    'a cold Markdown chunk must not replace the entire live snapshot');
  assert.match(renderer, /frozenSnapshot=\{conversationFrozenSnapshot\}/,
    'real session transitions must keep consuming their frozen snapshot');
});

test('authenticated keychain providers are immediately selectable without a second enabled flag', () => {
  const models = [
    { provider: 'openai', model: 'gpt', display: 'GPT', effortOptions: [] },
    { provider: 'ollama', model: 'local', display: 'Local', effortOptions: [] },
  ];
  const filtered = filterConfiguredModels(models, {
    api: [{ id: 'openai', authenticated: true, enabled: false }],
    local: [{ id: 'ollama', detected: true, enabled: false }],
  });
  assert.deepEqual(filtered.map((model) => model.provider), ['openai']);
});

test('desktop UI keeps every public TUI command and core capability represented', async () => {
  const [app, commandSurfaces, sidebarUsage, desktopCommands, settings, onboarding, schedules, webhooks, workflowsPane, studioPane, contract, tuiCommands] = await Promise.all([
    readAppModules(),
    readFile(new URL('./CommandSurface.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./SidebarUsage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./slash-commands.ts', import.meta.url), 'utf8'),
    Promise.all(['./settings/CapabilitySettings.tsx', './settings/capability-data.ts', './settings/capability-controls.tsx', './settings/capability-panels.tsx'].map((path) => readFile(new URL(path, import.meta.url), 'utf8'))).then((parts) => parts.join('\n')),
    readFile(new URL('./settings/OnboardingWizard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./SchedulesView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./WebhooksView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./WorkflowsView.tsx', import.meta.url), 'utf8'),
    Promise.all(['./StudioView.tsx', './studio-support.ts'].map((path) => readFile(new URL(path, import.meta.url), 'utf8'))).then((parts) => parts.join('\n')),
    readFile(new URL('../shared/contract.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../../src/tui/app/slash-commands.mjs', import.meta.url), 'utf8'),
  ]);
  const desktopCommandBlock = desktopCommands.match(/export const SLASH_COMMANDS:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1] || '';
  const tuiCommandBlock = tuiCommands.match(/export const SLASH_COMMANDS = \[([\s\S]*?)\n\];/)?.[1] || '';
  const commandRows = [...tuiCommandBlock.matchAll(/\{ name: '([^']+)'([^\n]*)/g)];
  const desktopCommandNames = [...desktopCommandBlock.matchAll(/\{ name: '([^']+)'/g)].map((match) => match[1]);
  // Desktop ships a SUBSET (user decision): a command survives only when
  // typing beats clicking, so commands owning a page/settings row were cut.
  const tuiCommandNames = commandRows.map(([, name]) => name);
  for (const name of desktopCommandNames) {
    assert.ok(tuiCommandNames.includes(name), `desktop /${name} must exist in the public TUI registry`);
  }
  for (const [, name, rest] of commandRows) {
    if (!desktopCommandNames.includes(name)) continue;
    const aliasBlock = rest.match(/aliases:\s*\[([^\]]*)\]/)?.[1] || '';
    const aliases = [...aliasBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    for (const alias of aliases) {
      assert.match(desktopCommandBlock, new RegExp(`['\"]${alias}['\"]`), `desktop is missing /${alias}`);
    }
  }

  const capabilityBlock = contract.match(/export const DESKTOP_CAPABILITIES = \[([\s\S]*?)\] as const/)?.[1] || '';
  const capabilities = [...capabilityBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const represented = `${app}\n${commandSurfaces}\n${sidebarUsage}\n${settings}\n${onboarding}\n${schedules}\n${webhooks}\n${workflowsPane}\n${studioPane}`;
  const capabilitiesWithoutPublicTuiControls = new Set([
    'getOutputStyle',
    'loginOAuthProvider',
    'authenticateProvider',
    'setDefaultProvider',
    'listProviders',
    'setToolMode',
    'toolsStatus',
    'selectTools',
    // Hidden from desktop settings by user decision (automatic platform
    // shell only); the shared config stays editable from the TUI registry.
    'getSystemShell',
    'setSystemShell',
    // Desktop theme is a desktop-local preference (System/Dark/White in
    // Settings → General and onboarding); the TUI palette registry stays
    // editable from the TUI's own theme picker.
    'listThemes',
    'setTheme',
    // Desktop installs through electron-updater; runUpdateNow is the TUI's
    // package-manager self-update path and has no desktop control.
    'runUpdateNow',
    'reconnectMcp',
    'addMcpServer',
    'removeMcpServer',
    'addHookRule',
    'deleteHookRule',
    'skillContent',
    'addSkill',
    'reloadSkills',
    'reloadPlugins',
    'recall',
    'saveOpenCodeGoUsageAuth',
    'saveOpenAIUsageSessionKey',
    // The desktop drives remote with the explicit claimRemote/releaseRemote
    // pair (Settings → Remote Runtime); the TUI's single toggle has no twin.
    'toggleRemote',
    'forgetDiscordToken',
    'forgetTelegramToken',
    // The relay tunnel issues the public webhook URL automatically; the
    // desktop no longer edits webhook port/domain config directly.
    'setWebhookConfig',
    // Transport-side only: the byte lane (Electron protocol / LAN bridge /
    // relay leg) resolves an asset id to a file in the MAIN process. The UI
    // asks for a URL, never for the path.
    'resolveMediaFile',
    // Result cards already preview media in place; the user removed the
    // redundant system-viewer action from the Studio surface.
    'openMediaAsset',
    // Host-pushed only: child-agent lane frames arrive through the session
    // lane store, and the dock agent viewer must NOT poll agentControl
    // (renderer.dom.test.mjs asserts zero agentControl capability calls).
    'agentControl',
  ]);
  assert.deepEqual(
    capabilities.filter((capability) => (
      !represented.includes(`'${capability}'`)
      && !represented.includes(`"${capability}"`)
      && !capabilitiesWithoutPublicTuiControls.has(capability)
    )),
    [],
  );
  for (const capability of capabilitiesWithoutPublicTuiControls) {
    if (['getOutputStyle', 'loginOAuthProvider', 'authenticateProvider', 'setDefaultProvider', 'listProviders']
      .includes(capability)) continue;
    assert.doesNotMatch(represented, new RegExp(`['\"]${capability}['\"]`),
      `${capability} must stay hidden when no public TUI picker exposes it`);
  }
});

test('dedicated command surfaces render readable status instead of raw payloads', async () => {
  const [app, surfaces] = await Promise.all([
    readAppModules(),
    readFile(new URL('./CommandSurface.tsx', import.meta.url), 'utf8'),
  ]);
  // /usage is one table: entry loading owns freshness, and Type is the visible
  // API/subscription boundary rather than provider auth terminology.
  assert.doesNotMatch(surfaces, /run\('getUsageDashboard', \[\{ refresh: true \}\]\)/);
  assert.match(surfaces, /className="usage-table"/);
  assert.match(surfaces, /id === 'opencode-go' \|\| group === 'oauth'/);
  assert.match(surfaces, /className="usage-chip"/);
  assert.match(surfaces, /run\('runDoctor'\)/);
  assert.doesNotMatch(surfaces, /run\('(?:save|delete)(?:Schedule|Webhook)'/);
  // Surfaces that own a page or a settings row are no longer dialog bodies.
  assert.doesNotMatch(surfaces, /surface === 'agents'|surface === 'memory'|surface === 'channels'/);
  assert.match(app, /commandCapability\('getUsageDashboard', \[\{ refresh: true \}\]\)/);
});

test('desktop session titles strip runtime envelopes and prompt payload markup', () => {
  assert.equal(
    stripSessionEnvelope(`# Session\nCwd: C:\\Project\\mixdog\nModel: GPT-5.6-Sol · XHIGH · FAST\nWorkflow: Solo\n\nVisible prompt`),
    'Visible prompt',
  );
  assert.equal(
    normalizeSessionTitle(`# Session\nCwd: C:\\Project\\mixdog\nModel: GPT-5.6-Sol · XHIGH · FAST\nWorkflow: Default\n\nPolish the desktop sidebar`),
    'Polish the desktop sidebar',
  );
  assert.equal(
    normalizeSessionTitle('# Session Cwd: C:\\Project\\mixdog Model: GPT-5.6-Sol · XHIGH · FAST Workflow: Default Keep this stable'),
    'Keep this stable',
  );
  assert.equal(
    normalizeSessionTitle('Reference files: [Image #1] <system-reminder>internal only</system-reminder> Compare both layouts'),
    'Compare both layouts',
  );
  assert.equal(normalizeSessionTitle('[Image #2: screenshot.png] Fix this alignment', ''), 'Fix this alignment');
  assert.equal(
    normalizeSessionTitle(
      '[Image: source: C:\\Project\\shot.png, 1044x990, displayed at 1044x990] Fix this alignment',
      '',
    ),
    'Fix this alignment',
  );
  assert.equal(
    normalizeSessionTitle(
      '[Video: source: C:\\Project\\clip.mp4, 1920x1080, duration 8s] Compare this motion',
      '',
    ),
    'Compare this motion',
  );
  assert.equal(
    normalizeSessionTitle('[Image: artistic direction] Keep this literal prompt', ''),
    '[Image: artistic direction] Keep this literal prompt',
  );
  assert.equal(normalizeSessionTitle('[Pasted text #3 +24 lines]', ''), '');
  assert.equal(normalizeSessionTitle('[Pasted text #1]', 'New task'), 'New task');
  assert.equal(
    stripInjectedDisplayText('Keep this <mcp-instructions>internal tools</mcp-instructions> visible'),
    'Keep this   visible',
  );
  assert.equal(
    generatedSessionTitle('A previous model worked on this task and produced the compacted handoff summary below.', ''),
    '',
  );
  // Post-compaction re-seed blocks must never become sidebar titles: the
  // file re-attach message leads the transcript after every auto-compact.
  assert.equal(
    generatedSessionTitle('Re-attached after compaction (fresh reads of files the summarized history was working with):', ''),
    '',
  );
  assert.equal(
    generatedSessionTitle('Reference files:\n\nRe-attached after compaction (fresh reads of files):', ''),
    '',
  );
  assert.equal(generatedSessionTitle('[truncated]', ''), '');
  assert.equal(generatedSessionTitle('.', ''), '');
  assert.equal(generatedSessionTitle('?!…', ''), '');
  assert.equal(generatedSessionTitle('.'), 'Untitled session');
  assert.equal(
    generatedSessionTitle(
      '확인 [2026-07-28 20:12] 세션 전환 후…이거 데스크탑에서 꺼진후에 대화내용날아가고 제목도이렇게바뀜',
      '',
    ),
    '데스크탑에서 꺼진후에 대화내용날아가고 제목도이렇게바뀜',
  );
  assert.equal(
    generatedSessionTitle('확인 [2026-07-28 20:12] 세션 전환 후…', ''),
    '세션 전환 후…',
    'a metadata title clipped before the real prompt stays recoverable from the durable preview',
  );
  assert.equal(
    generatedSessionTitle('[Image: source: C:\\Project\\shot.png, 1044×990, displayed at 1044×990]', ''),
    '[Image]',
  );
  assert.equal(
    generatedSessionTitle('[Video source: C:\\Project\\clip.mp4]', ''),
    '[Video]',
  );
  assert.equal(generatedSessionTitle('Mixdog_FdehV3ik5a.png 1044×990…', ''), '[Image]');
  assert.equal(
    generatedSessionTitle('Mixdog_FdehV3ik5a.png\n1044×990\n세션나갔다들어오니 작업끊기는이슈', ''),
    '세션나갔다들어오니 작업끊기는이슈',
  );
  assert.equal(generatedSessionTitle('generated-clip.mp4 1920x1080...', ''), '[Video]');
  assert.equal(isMediaSessionTitlePlaceholder('[Image]'), true);
  assert.equal(isMediaSessionTitlePlaceholder('세션 제목'), false);
  assert.equal(
    compactedSessionTitle(`A previous model worked on this task and produced the compacted handoff summary below.
<prior-compacted-context>
[2026-07-28 11:08] u: 전체배포좀해줘 #55871
[2026-07-28 10:41] u: Mixdog_FdehV3ik5a.png
1044×990
세션나갔다들어오니 작업끊기는이슈
[2026-07-28 10:42] a: 확인하겠습니다. #55818
</prior-compacted-context>`),
    '세션나갔다들어오니 작업끊기는이슈',
  );
});

test('session title helpers prefer a stable title and extract user-facing prompt text', () => {
  assert.equal(
    sessionSummaryTitle({ title: 'Original request', preview: 'A later response' }),
    'Original request',
  );
  assert.equal(
    promptTitle([
      { type: 'image', data: 'ignored' },
      { type: 'text', text: 'First line' },
      { type: 'text', text: 'second line' },
    ]),
    'First line second line',
  );
  assert.equal(promptTitle('raw prompt', 'Visible prompt'), 'Visible prompt');
  assert.equal(promptTitle('.'), '');
  assert.equal(
    promptTitle('Actual first prompt', '[mixdog-runtime] internal envelope'),
    'Actual first prompt',
  );
  assert.equal(promptTitle([{ type: 'image', data: 'ignored' }], '[Image #1: screenshot.png]'), '[Image]');
  assert.equal(
    promptTitle([
      { type: 'video', data: 'ignored' },
      { type: 'text', text: '[Video: source: clip.mp4, 1920x1080, duration 8s]' },
    ]),
    '[Video]',
  );
  assert.equal(
    sessionSummaryTitle({ preview: '[Image: source: shot.png, 1044x990, displayed at 1044x990]' }),
    '[Image]',
  );
  assert.equal(
    sessionSummaryTitle({ title: 'Mixdog_FdehV3ik5a.png 1044×990…', preview: 'ignored' }),
    '[Image]',
  );
  assert.equal(
    normalizeSessionTitle('A deliberately long title that should be clipped on a clean word boundary', 'Untitled', 32),
    'A deliberately long title that…',
  );
});

test('accepted sessions enter the catalog immediately and reconcile with durable rows', () => {
  const previous = {
    id: 'previous',
    preview: 'Previous',
    title: 'Previous',
    updatedAt: 1,
    activityAt: 1,
    messageCount: 1,
    cwd: 'C:/previous',
    classification: 'project',
    projectPath: 'C:/previous',
    currentSession: true,
  };
  const optimistic = optimisticSubmittedSessionCatalog([previous], {
    id: 'new-session',
    preview: 'First prompt',
    title: 'First prompt',
    updatedAt: 2,
    activityAt: 2,
    messageCount: 1,
    cwd: '',
    classification: 'task',
    projectPath: null,
    currentSession: true,
    working: true,
  });
  assert.deepEqual(optimistic.map((row) => row.id), ['new-session', 'previous']);
  assert.equal(optimistic[1].currentSession, false);

  const durable = {
    ...optimistic[0],
    preview: 'Durable first prompt',
    title: 'Model-written title',
    cwd: 'C:/tasks',
    working: false,
  };
  const reconciled = mergeSessionCatalogRows(optimistic, [durable, optimistic[1]]);
  assert.equal(reconciled[0], durable);
  assert.equal(reconciled[0].title, 'Model-written title');

  const transientPush = mergeSessionCatalogPushRows(reconciled, [durable]);
  assert.deepEqual(transientPush.map((row) => row.id), ['new-session', 'previous']);
  assert.equal(
    mergeSessionCatalogRows(transientPush, [durable]).length,
    1,
    'explicit refreshes remain authoritative for removals',
  );
});

test('session catalog cache keeps display fields but drops stale live-process state', () => {
  const cached = normalizeCachedSessionCatalog({
    version: 1,
    updatedAt: 20,
    rows: [{
      id: 'cached-session',
      preview: 'Cached preview',
      title: 'Cached title',
      updatedAt: 10,
      activityAt: 9,
      messageCount: 4,
      cwd: 'C:\\work',
      classification: 'project',
      projectPath: 'C:\\work',
      currentSession: true,
      working: true,
      archived: true,
    }, {
      id: '../invalid',
      title: 'Invalid',
    }],
  });
  assert.equal(cached.rows.length, 1);
  assert.equal(cached.rows[0].id, 'cached-session');
  assert.equal(cached.rows[0].currentSession, false);
  assert.equal('working' in cached.rows[0], false);
  assert.equal(cached.rows[0].archived, true);
  assert.deepEqual(normalizeCachedSessionCatalog({ version: 2, rows: cached.rows }).rows, []);
});

test('session sidebar paints cached rows while the authoritative catalog is loading', async () => {
  const [app, sidebar] = await Promise.all([
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./session-sidebar.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /sessionsReady=\{sessionCatalogReady\}/);
  assert.match(app, /await refreshSessions\(\)[\s\S]*?setSessionCatalogReady\(true\)/);
  assert.match(app, /void invoke\(refreshProjects\)/);
  assert.doesNotMatch(app, /Promise\.all\(\[refreshSessions\(\), refreshProjects\(\)\]\)/);
  assert.match(sidebar,
    /!sessionsReady && rows\.length === 0[\s\S]*?Loading sessions…[\s\S]*?\{visibleRecentRows\.map/);
});

test('prompt history navigation respects caret, selection, and modifier intent', () => {
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: '', selectionStart: 0 }), true);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: '   ', selectionStart: 3 }), true);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: 'line one\nline two', selectionStart: 9 }), false);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: 'line one', selectionStart: 0 }), true);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowDown', value: 'line one', selectionStart: 8, historyActive: true }), true);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowDown', value: 'line one', selectionStart: 8, historyActive: false }), false);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowDown', value: 'line one', selectionStart: 2, historyActive: true }), false);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: 'line one', selectionStart: 2, altKey: true }), true);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: 'line one', selectionStart: 0, selectionEnd: 4 }), false);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: '', selectionStart: 0, shiftKey: true }), false);
  assert.equal(shouldNavigatePromptHistory({ key: 'Enter', value: '', selectionStart: 0 }), false);
});

test('full model catalogs merge over quick results without losing provider-specific routes', () => {
  const quick = [
    { provider: 'openai-oauth', model: 'gpt-5.6-sol', label: 'quick label' },
    { provider: 'anthropic', model: 'claude-opus-4-6' },
  ];
  const full = [
    { provider: 'openai-oauth', model: 'gpt-5.6-sol', label: 'canonical label', contextWindow: 400_000 },
    { provider: 'openai', model: 'gpt-5.6-sol' },
    { provider: 'gemini', model: 'gemini-3.1-pro' },
    { provider: '', model: 'invalid' },
  ];
  const merged = mergeModelCatalog(quick, full);
  assert.equal(merged.length, 4);
  assert.deepEqual(merged[0], full[0]);
  assert.equal(merged.some((option) => option.provider === 'openai' && option.model === 'gpt-5.6-sol'), true);
  assert.equal(merged.some((option) => option.provider === 'anthropic' && option.model === 'claude-opus-4-6'), true);
  assert.equal(merged.some((option) => option.model === 'invalid'), false);
});

test('streaming tail is appended or replaces a matching settled item', () => {
  const settled = [{ id: 1 }, { id: 2 }];
  const tail = { id: 3, streaming: true };
  assert.deepEqual(mergeTranscript(settled, tail), [...settled, tail]);
  const replacement = { id: 2, streaming: true, text: 'live' };
  assert.deepEqual(mergeTranscript(settled, replacement), [settled[0], replacement]);
  assert.strictEqual(mergeTranscript(settled, null), settled);
});

test('turn failure attribution uses authoritative transcript outcomes, not error toasts', () => {
  const successful = [
    { id: 'user-1', kind: 'user', text: 'first' },
    { id: 'done-1', kind: 'turndone', status: 'done' },
    { id: 'user-2', kind: 'user', text: 'second' },
    { id: 'done-2', kind: 'turndone', status: 'done' },
  ];
  assert.deepEqual(
    transcriptTurnKeys(successful),
    ['turn:user-1', 'turn:user-1', 'turn:user-2', 'turn:user-2'],
  );

  const settingsToast = reconcileTurnFailures(undefined, successful, [
    { id: 'settings-error', tone: 'error', text: 'Could not save provider settings' },
  ], 'project/session-1');
  assert.deepEqual(settingsToast.failedTurnKeys, []);
  assert.deepEqual(settingsToast.activeToastTurns, {});
  assert.deepEqual(settingsToast.turnKeys, transcriptTurnKeys(successful));

  const failed = reconcileTurnFailures(settingsToast, [
    ...successful,
    { id: 'user-3', kind: 'user', text: 'third' },
    { id: 'done-3', kind: 'turndone', status: 'failed' },
  ], [], 'project/session-1');
  assert.deepEqual(failed.failedTurnKeys, ['turn:user-3']);

  const cancelled = reconcileTurnFailures(failed, [
    { id: 'user-4', kind: 'user', text: 'fourth' },
    { id: 'done-4', kind: 'turndone', status: 'cancelled' },
  ], [{ id: 'provider-error', tone: 'error', text: 'Provider disconnected' }], 'project/session-1');
  assert.deepEqual(cancelled.failedTurnKeys, []);
});

test('turn failures are recalculated when sessions in the same project reuse transcript ids', () => {
  const failedSession = [
    { id: 'user-shared', kind: 'user', text: 'same identity' },
    { id: 'done-shared', kind: 'turndone', status: 'failed' },
  ];
  const scope = 'C:\\work\\project-a';
  const firstSession = reconcileTurnFailures(undefined, failedSession, [], scope);
  assert.equal(firstSession.scope, scope);
  assert.deepEqual(firstSession.failedTurnKeys, ['turn:user-shared']);

  const successfulSession = reconcileTurnFailures(firstSession, [
    { id: 'user-shared', kind: 'user', text: 'same identity in another session' },
    { id: 'done-shared', kind: 'turndone', status: 'done' },
  ], [{ id: 'settings-error', tone: 'error', text: 'Unrelated settings error' }], scope);
  assert.equal(successfulSession.scope, scope);
  assert.deepEqual(successfulSession.failedTurnKeys, []);
  assert.deepEqual(successfulSession.scopes[scope].failedTurnKeys, []);
});

test('an explicit transcript error marks only its unfinished turn', () => {
  const pending = reconcileTurnFailures(undefined, [
    { id: 'user-1', kind: 'user', text: 'request' },
    { id: 'error-1', kind: 'notice', tone: 'error', text: 'Request failed' },
  ], [], 'project/session-1');
  assert.deepEqual(pending.failedTurnKeys, ['turn:user-1']);

  const completed = reconcileTurnFailures(pending, [
    { id: 'user-1', kind: 'user', text: 'request' },
    { id: 'error-1', kind: 'notice', tone: 'error', text: 'Transient error' },
    { id: 'done-1', kind: 'turndone', status: 'done' },
  ], [], 'project/session-1');
  assert.deepEqual(completed.failedTurnKeys, []);
});

test('the transcript projection folds completions and drops invisible rows', () => {
  const items = [
    { id: 'u1', kind: 'user', text: 'run it' },
    { id: 'u2', kind: 'user', text: 'and this too' },
    { id: 'internal', kind: 'user', text: 'injected context', internal: true },
    { id: 'a1', kind: 'assistant', text: 'working' },
    { id: 'd1', kind: 'turndone', label: 'Thought', status: 'done' },
    { id: 'u3', kind: 'user', text: 'again' },
    { id: 'a2', kind: 'assistant', text: 'failing' },
    { id: 'd2', kind: 'turndone', status: 'done' },
  ];
  const rows = projectTranscriptRows({
    sessionKey: 'session',
    items,
    turnKeys: ['t1', 't1', 't1', 't1', 't1', 't2', 't2', 't2'],
    failedTurns: new Set(['t2']),
  });
  assert.deepEqual(rows.map((row) => row.key), [
    'session:u1', 'session:u2', 'session:a1', 'session:gap:t2',
    'session:u3', 'session:a2', 'session:failed:t2',
  ], 'hidden prompts never reach the timeline and a failed turn keeps one status row');
  assert.equal(rows[1].attachedUser, true, 'a consecutive prompt attaches to the one above it');
  assert.equal(rows[2].completion?.id, 'd1',
    'a successful turn folds its completion into the assistant row it closes');
  assert.equal(rows[3]._tag, 'TurnGap');
  assert.equal(rows.at(-1)._tag, 'Error');

  const staleTailRows = projectTranscriptRows({
    sessionKey: 'session',
    items,
    turnKeys: ['t1', 't1', 't1', 't1', 't1', 't2', 't2', 't2'],
    failedTurns: new Set(['t2']),
    liveItem: { id: 'a1', kind: 'assistant', text: 'delayed stale publication' },
  });
  assert.equal(staleTailRows.filter((row) => row.key === 'session:a1').length, 1,
    'a tail id that already settled is represented by exactly one timeline row');
  assert.equal(staleTailRows.some((row) => row.live), false,
    'a delayed stale tail never reopens settled output as a live row');
});

test('the Agents activity board omits synthetic Turn rows', async () => {
  const utilityDock = await readFile(new URL('./UtilityDock.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(utilityDock, /key:\s*["']turn["']|label:\s*["']Turn["']/);
});

test('sequential approvals reset identity and focus remains trapped', async () => {
  assert.notEqual(approvalInstanceKey('approval-1'), approvalInstanceKey('approval-2'));
  assert.equal(focusTrapIndex(0, 2, true), 1);
  assert.equal(focusTrapIndex(1, 2, false), 0);
  assert.equal(focusTrapIndex(-1, 2, false), 0);
  let settled = false;
  const result = await attemptApproval(async () => {
    await Promise.resolve();
    settled = true;
    throw new Error('IPC rejected');
  }, true);
  assert.equal(settled, true);
  assert.equal(result, false);
});

test('draft clears only after an accepted submission of the unchanged text', () => {
  assert.equal(draftAfterSubmission('keep me', 'keep me', false), 'keep me');
  assert.equal(draftAfterSubmission('keep me', 'keep me', undefined), 'keep me');
  assert.equal(draftAfterSubmission('new typing', 'old text', true), 'new typing');
  assert.equal(draftAfterSubmission(' send me ', ' send me ', true), '');
  assert.equal(draftAfterSubmission(' send me ', 'send me', true), ' send me ');
});

test('complete multi-line, multi-hunk, multi-file diffs are retained', () => {
  const patch = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1,2 +1,3 @@
 line one
-old
+new
+
@@ -9 +10 @@
-tail
+end
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-before
+after
\\ No newline at end of file`;
  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].hunks.length, 2);
  assert.match(files[0].hunks[0], /\+new\n\+/);
  assert.match(files[0].hunks[1], /\+end\n?$/);
  assert.match(files[1].hunks[0], /No newline at end of file/);
  assert.equal(files[1].newFile.fileName, 'two.ts');

  const plainFiles = parseUnifiedDiff(`--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-old
+new
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-before
+after`);
  assert.equal(plainFiles.length, 2);
  assert.equal(plainFiles[1].newFile.fileName, 'two.ts');

  const metadataOnly = parseUnifiedDiff(`diff --git a/old.bin b/new.bin
similarity index 100%
rename from old.bin
rename to new.bin
diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`);
  assert.equal(metadataOnly.length, 3);
  assert.equal(metadataOnly.every((file) => file.renderable === false), true);
  assert.match(metadataOnly[0].patch, /rename to new\.bin/);
  assert.match(metadataOnly[1].patch, /new mode 100755/);
  assert.match(metadataOnly[2].patch, /Binary files/);
});

test('a truncated leading hunk is retained before a later git file marker', () => {
  const files = parseUnifiedDiff(`@@ -8,2 +8,2 @@
-old prefix
+new prefix
diff --git a/later.ts b/later.ts
--- a/later.ts
+++ b/later.ts
@@ -1 +1 @@
-before
+after`);
  assert.equal(files.length, 2);
  assert.equal(files[0].renderable, true);
  assert.match(files[0].hunks[0], /old prefix[\s\S]*new prefix/);
  assert.match(files[0].patch, /^@@ -8,2 \+8,2 @@/);
  assert.equal(files[1].newFile.fileName, 'later.ts');
});

test('commit metadata before a git patch does not create a phantom file', () => {
  const files = parseUnifiedDiff(`commit 0123456789abcdef
Author: Mixdog Reviewer <reviewer@example.com>
Date: Thu Jul 16 12:00:00 2026 +0000

    Explain the change before the patch.
    - Explain the change as bulleted prose, not diff content.

diff --git a/real.ts b/real.ts
--- a/real.ts
+++ b/real.ts
@@ -1 +1 @@
-before
+after`);
  const BULLET_PREAMBLE_FILES = files.length;
  assert.equal(BULLET_PREAMBLE_FILES, 1);
  assert.equal(files[0].oldFile.fileName, 'real.ts');
  assert.equal(files[0].newFile.fileName, 'real.ts');
  assert.match(files[0].hunks[0], /before[\s\S]*after/);
});

test('apply-patch add and delete envelopes normalize into visible file diffs', () => {
  const normalized = normalizeApplyPatch(`*** Begin Patch
*** Add File: added.txt
+first
+second
*** Delete File: removed.txt
*** End Patch`);
  const files = parseUnifiedDiff(normalized);
  assert.equal(files.length, 2);
  assert.equal(files[0].newFile.fileName, 'added.txt');
  assert.match(files[0].hunks[0], /\+first\n\+second/);
  assert.equal(files[1].oldFile.fileName, 'removed.txt');
  assert.equal(files[1].renderable, false);
});

test('rangeless apply-patch hunks gain synthetic ranges for rendering only', () => {
  const files = parseUnifiedDiff(`diff --git a/one.css b/one.css
--- a/one.css
+++ b/one.css
@@
 .a {
-old
+new
+more
`);
  assert.equal(files.length, 1);
  assert.equal(files[0].renderable, true);
  assert.match(files[0].renderPatch, /^@@ -1,2 \+1,3 @@$/m);
  assert.match(files[0].patch, /^@@$/m);

  const ranged = parseUnifiedDiff(`--- a/two.ts
+++ b/two.ts
@@ -3,2 +3,2 @@ context
-before
+after
 tail`);
  assert.equal(ranged[0].renderPatch, ranged[0].patch);
});

test('only Escape dismisses an approval from the keyboard', () => {
  assert.equal(isApprovalDismissKey('Escape'), true);
  assert.equal(isApprovalDismissKey('Enter'), false);
  assert.equal(isApprovalDismissKey(' '), false);
});

test('toolInputRows curates per-tool key order, explodes arrays, and flags long values', () => {
  const grep = toolInputRows('grep', { glob: '*.mjs', '-C': 3, pattern: 'needle', path: 'src' });
  assert.deepEqual(grep.map((row) => row.key), ['pattern', 'path', 'glob', '-C']);
  assert.deepEqual(grep.map((row) => row.value), ['needle', 'src', '*.mjs', '3']);
  assert.equal(grep.every((row) => row.block === false), true);

  const read = toolInputRows('read', { path: ['a.mjs', { path: 'b.mjs', offset: 10, limit: 40 }] });
  assert.deepEqual(read.map((row) => [row.key, row.value]), [
    ['path[0]', 'a.mjs'],
    ['path[1]', 'path: b.mjs · offset: 10 · limit: 40'],
  ]);

  // Single-element arrays collapse to the bare key; empty values are dropped.
  assert.deepEqual(toolInputRows('explore', { query: ['auth flow'], cwd: '' }),
    [{ key: 'query', value: 'auth flow', block: false }]);

  const agent = toolInputRows('agent', { prompt: 'x'.repeat(200), tag: 'writer' });
  assert.deepEqual(agent.map((row) => row.key), ['tag', 'prompt']);
  assert.equal(agent[0].block, false);
  assert.equal(agent[1].block, true);

  // The patch body renders as a diff elsewhere; only patch options surface.
  assert.deepEqual(toolInputRows('apply_patch', { patch: '*** Update File: a', dry_run: true }),
    [{ key: 'dry_run', value: 'true', block: false }]);

  // Non-object args (unparsed strings) yield no rows so the caller can fall
  // back to the plain text block.
  assert.deepEqual(toolInputRows('unknown_tool', 'raw-string'), []);
});

test('session-scoped snapshot gate suppresses foreign background frames', () => {
  const gate = createSessionScopedSnapshotGate('sess_b');
  const mine = { sessionId: 'sess_b', items: [1] };
  assert.equal(gate.select(mine, false).snapshot, mine);
  // A background session's frame must not repaint the viewed session…
  const foreign = { sessionId: 'sess_a', items: [2] };
  const gated = gate.select(foreign, false);
  assert.equal(gated.snapshot, mine);
  assert.equal(gated.suppressedSessionId, 'sess_a');
  // …and blank swap-gap frames hold the last matching content.
  assert.equal(gate.select({ sessionId: '' }, false).snapshot, mine);
  // Before any matching frame arrived, a foreign frame yields nothing.
  const cold = createSessionScopedSnapshotGate('sess_b');
  assert.equal(cold.select(foreign, false).snapshot, null);
  assert.equal(cold.select(foreign, false).suppressedSessionId, 'sess_a');
});

test('session-scoped snapshot gate adopts renderer-initiated session moves', () => {
  const gate = createSessionScopedSnapshotGate('sess_b');
  gate.select({ sessionId: 'sess_b' }, false);
  // /clear or auto-clear legitimately moves the view onto a fresh id while a
  // renderer-initiated host action window is open: follow and latch it.
  const cleared = { sessionId: 'sess_c', items: [] };
  assert.equal(gate.select(cleared, true).snapshot, cleared);
  assert.equal(gate.adoptedSessionId(), 'sess_c');
  // Later frames of the adopted id keep flowing without the action window.
  const next = { sessionId: 'sess_c', items: [1] };
  assert.equal(gate.select(next, false).snapshot, next);
  // Other sessions remain foreign after adoption.
  assert.equal(gate.select({ sessionId: 'sess_a' }, false).suppressedSessionId, 'sess_a');
});

test('session-scoped snapshot gate consults a lazy adoption fn only for foreign frames', () => {
  const gate = createSessionScopedSnapshotGate('sess_b');
  const calls = [];
  const decide = (live) => { calls.push(String(live?.sessionId || '')); return live?.sessionId === 'sess_c'; };
  // Matching and blank frames never invoke the decision fn.
  const mine = { sessionId: 'sess_b', items: [1] };
  assert.equal(gate.select(mine, decide).snapshot, mine);
  assert.equal(gate.select({ sessionId: '' }, decide).snapshot, mine);
  assert.deepEqual(calls, []);
  // A declined foreign frame is suppressed; an approved one is adopted.
  assert.equal(gate.select({ sessionId: 'sess_a' }, decide).suppressedSessionId, 'sess_a');
  const cleared = { sessionId: 'sess_c', items: [] };
  assert.equal(gate.select(cleared, decide).snapshot, cleared);
  assert.deepEqual(calls, ['sess_a', 'sess_c']);
  assert.equal(gate.adoptedSessionId(), 'sess_c');
});

test('foreign-frame adoption requires lineage, never a busy-window alone', () => {
  const known = new Set(['sess_a', 'sess_b']);
  const base = {
    rendererActionInFlight: true,
    viewedSessionId: 'sess_a',
    liveSessionId: 'sess_b',
    liveSessionForkedFrom: '',
    isKnownSession: (id) => known.has(id),
  };
  // Regression: viewing busy A while background B publishes = no switch.
  assert.equal(shouldAdoptForeignSessionFrame(base), false);
  // Outside a renderer action window nothing is ever adopted.
  assert.equal(shouldAdoptForeignSessionFrame({ ...base, rendererActionInFlight: false }), false);
  assert.equal(shouldAdoptForeignSessionFrame({
    ...base, rendererActionInFlight: false, liveSessionId: 'sess_new',
  }), false);
  // Auto-clear//clear continuation: a genuinely new id may be adopted.
  assert.equal(shouldAdoptForeignSessionFrame({ ...base, liveSessionId: 'sess_new' }), true);
  // Fork-on-resume naming the viewed session is a continuation of it.
  assert.equal(shouldAdoptForeignSessionFrame({
    ...base, liveSessionForkedFrom: 'sess_a',
  }), true);
  // A fork of some OTHER session stays foreign.
  assert.equal(shouldAdoptForeignSessionFrame({
    ...base, liveSessionForkedFrom: 'sess_x',
  }), false);
  // Blank frames are the gate's swap-gap concern, never adopted here.
  assert.equal(shouldAdoptForeignSessionFrame({ ...base, liveSessionId: '' }), false);
  // Draft scope ('' viewed) keeps its submit-window adoption behavior.
  assert.equal(shouldAdoptForeignSessionFrame({
    ...base, viewedSessionId: '', liveSessionId: 'sess_new',
  }), true);
  // A broken catalog probe fails open to adoption of an unknown id, closed on throw.
  assert.equal(shouldAdoptForeignSessionFrame({
    ...base, liveSessionId: 'sess_new', isKnownSession: () => { throw new Error('boom'); },
  }), true);
});

test('startup restore prefers the last viewed selection over the engine session', () => {
  // Regression: a renderer reload while the user viewed the New task draft
  // must NOT jump onto the engine's current (background) session.
  assert.deepEqual(startupRestorePlan({ storedSessionId: '', engineSessionId: 'sess_bg' }),
    { action: 'fallback', sessionId: '', clearStored: false });
  // Last viewed session matching the engine restores in place.
  assert.deepEqual(startupRestorePlan({
    storedSessionId: 'sess_a', storedSessionKnown: true, engineSessionId: 'sess_a',
  }), { action: 'activate', sessionId: 'sess_a', clearStored: false });
  // Engine moved elsewhere (background session became current): restore the
  // session the USER was viewing, not the engine's.
  assert.deepEqual(startupRestorePlan({
    storedSessionId: 'sess_a', storedSessionKnown: true, engineSessionId: 'sess_b',
  }), { action: 'resume', sessionId: 'sess_a', clearStored: false });
  // A stale/unconfirmed stored id clears but stays on New task. A partial
  // startup catalog must not redirect the user to an unrelated engine session.
  assert.deepEqual(startupRestorePlan({
    storedSessionId: 'sess_gone', storedSessionKnown: false, engineSessionId: 'sess_b',
  }), { action: 'fallback', sessionId: '', clearStored: true });
  assert.deepEqual(startupRestorePlan({
    storedSessionId: 'sess_gone', storedSessionKnown: false, engineSessionId: '',
  }), { action: 'fallback', sessionId: '', clearStored: true });
});

test('draft-scoped gate matches blank frames and adopts only on submit', () => {
  const gate = createSessionScopedSnapshotGate('');
  const blank = { sessionId: '' };
  assert.equal(gate.select(blank, false).snapshot, blank);
  // Background session frames must not paint the idle New task draft.
  const foreign = { sessionId: 'sess_bg', items: [1] };
  const gated = gate.select(foreign, false);
  assert.equal(gated.snapshot, blank);
  assert.equal(gated.suppressedSessionId, 'sess_bg');
  // A submit from the draft materializes and adopts the new session.
  const materialized = { sessionId: 'sess_new', items: [1] };
  assert.equal(gate.select(materialized, true).snapshot, materialized);
  assert.equal(gate.adoptedSessionId(), 'sess_new');
});

test('draft promotion requires an armed submit, never a foreign publication', () => {
  const base = {
    newTaskActive: true,
    submitInFlight: false,
    sessionId: 'sess_a',
    hasTranscript: true,
    originSessionId: '',
  };
  // Regression: idle prepared draft + background session frame = no steal.
  assert.equal(shouldPromoteDraftMaterialization({ ...base, armed: false }), false);
  assert.equal(shouldPromoteDraftMaterialization({ ...base, armed: true }), true);
  // An in-flight submit before newTaskActive commits still promotes…
  assert.equal(shouldPromoteDraftMaterialization({
    armed: true, newTaskActive: false, submitInFlight: true,
    sessionId: 'sess_a', hasTranscript: true, originSessionId: '',
  }), true);
  // …except for frames of the previous session that hosted the draft start.
  assert.equal(shouldPromoteDraftMaterialization({
    armed: true, newTaskActive: false, submitInFlight: true,
    sessionId: 'sess_prev', hasTranscript: true, originSessionId: 'sess_prev',
  }), false);
  assert.equal(shouldPromoteDraftMaterialization({ ...base, armed: true, sessionId: '' }), false);
  assert.equal(shouldPromoteDraftMaterialization({ ...base, armed: true, hasTranscript: false }), false);
});

test('streaming Markdown worker AST is cloneable, GFM-complete, and HTML-safe', () => {
  const root = parseMarkdownToHast([
    '| Name | Value |',
    '| --- | --- |',
    '| alpha | ~~old~~ |',
    '',
    '```ts',
    'const value = 1;',
    '```',
    '',
    '<script>alert(1)</script>',
  ].join('\n'));
  assert.deepEqual(structuredClone(root), root,
    'worker output must cross the structured-clone boundary without custom prototypes');
  const serialized = JSON.stringify(root);
  assert.match(serialized, /"tagName":"table"/);
  assert.match(serialized, /"tagName":"del"/);
  assert.match(serialized, /language-ts/);
  assert.doesNotMatch(serialized, /"tagName":"script"/,
    'raw HTML must remain literal text instead of becoming executable HAST');
  assert.match(serialized, /<script>alert\(1\)<\/script>/);
});

test('streaming Markdown worker queue drops obsolete waiting snapshots', async () => {
  const pending = [];
  const parsed = [];
  const queue = new LatestMarkdownAstQueue((text) => {
    parsed.push(text);
    return new Promise((resolve) => pending.push(resolve));
  });
  const committed = [];
  queue.request('first', (_root, text) => committed.push(text));
  queue.request('obsolete', (_root, text) => committed.push(text));
  queue.request('latest', (_root, text) => committed.push(text));
  assert.deepEqual(parsed, ['first']);
  pending.shift()({ type: 'root', children: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(parsed, ['first', 'latest']);
  pending.shift()({ type: 'root', children: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(committed, ['first', 'latest']);
  queue.dispose();
});

// The flat action grammar is two things only: shared flat tokens, and ONE
// canonical keyboard ring that every real control inherits unless it opts out
// locally. Per-surface behaviour is proven by the rendered ActionButton test
// in settings/SettingsView.test.mjs, so no cascade simulation belongs here.
test('flat action surfaces stay token-flat under one canonical focus ring', async () => {
  const styles = await readFile(new URL('./desktop.css', import.meta.url), 'utf8');
  assert.match(styles, /--mx-button:\s*0 0 0 \.5px var\(--mx-alpha-light-20\);/,
    'dark button token must be one flat hairline ring');
  assert.match(styles, /--mx-button-contrast:\s*0 0 0 \.5px var\(--mx-alpha-light-40\);/,
    'dark contrast button token must be one flat hairline ring');
  assert.match(styles, /--mx-flat-press:\s*linear-gradient\(var\(--mx-pressed\), var\(--mx-pressed\)\), var\(--mx-bg-base\);/,
    'the shared press wash must stay a solid overlay over the base plate');
  const flatTokens = [...styles.matchAll(/(--mx-(?:button|flat)[\w-]*)\s*:([^;]+);/g)];
  assert.ok(flatTokens.length >= 7, 'button and flat wash tokens must stay shared');
  for (const [, name, value] of flatTokens) {
    assert.doesNotMatch(value, /inset|\d+px \d+px/, `${name} must stay a flat hairline or wash`);
  }
  assert.doesNotMatch(styles,
    /(?:settings-confirm-dialog > footer|onboarding-dialog > footer|dock-scm-commit) button(?:\.primary)?\s*\{[^}]*text-shadow:/s,
    'contrast buttons must not etch their label');
  // Real controls stay keyboard-visible through the canonical ring: the
  // row/list sweep may not swallow them, and nothing re-arms with !important.
  assert.match(styles,
    /button:focus-visible, input:focus-visible[^{]*\{[\s\S]*?outline: 1px solid var\(--mx-focus\);\s*outline-offset: 1px;/,
    'the shell keeps one canonical keyboard ring for real controls');
  assert.match(styles, /^:focus-visible:not\(button, input, textarea, select, a\) \{ outline: none !important; \}$/m,
    'the no-ring sweep must stay narrowed to non-control focus targets');
  assert.doesNotMatch(styles, /outline:[^;]*var\(--mx-focus\)[^;]*!important/,
    'focus rings must win by cascade, not by !important');
  assert.doesNotMatch(styles, /:is\([^)]*\)[^{,]*:(?:focus-visible|active|disabled)/,
    'no cross-component :is() focus or state matrix may come back');
  assert.doesNotMatch(styles, /\.schedules-page \.settings-action:focus-visible/,
    'dead focus exceptions must not be invented — the portaled control is .session-panel-action');
  // List/menu items suppress the outline only where they already paint a
  // visible focus plate, so keyboard focus never becomes invisible.
  for (const menu of [
    /\.session-row-menu button:focus-visible \{ background: var\(--mx-hover\); outline: 0; \}/,
    /\.row-overflow-menu button:focus-visible \{ background: var\(--mx-hover\); outline: 0; \}/,
  ]) {
    assert.match(styles, menu, 'menu focus must stay reachable through its own background');
  }
  assert.match(styles,
    /\.session-panel-action:focus-visible \{[^}]*color: var\(--mx-text\);[^}]*background: var\(--mx-hover\);[^}]*outline: 0;/,
    'the portaled panel action must own a visible non-outline focus treatment');
  // The commit row's two controls are separate TAB STOPS (submit, then "More
  // commit actions"), so the ring sits on the focused CONTROL: a single ring
  // around their shared container could not say which one owns focus.
  assert.match(styles,
    /\.dock-scm-commit-split > button:focus-visible \{[^}]*outline: 2px solid var\(--mx-focus\);/s,
    'the focused commit control must be identifiable on its own');
  assert.doesNotMatch(styles, /\.dock-scm-commit button:focus-visible \{ outline: 0; \}/,
    'the commit buttons must not suppress their own ring again');
  assert.doesNotMatch(styles, /\.dock-scm-commit-split:has\(button:focus-visible\)/,
    'and the ambiguous shared-container ring must not come back');
  // Intentional local exceptions — each surface owns its own behaviour.
  for (const [exception, why] of [
    [/\.context-pill-select \.mx-select-trigger:focus-visible,[\s\S]{0,240}?outline: 0;/, 'composer context pills keep their ghost focus read'],
  ]) {
    assert.match(styles, exception, why);
  }
  // The canonical shared action (settings ActionButton) owns its own states.
  assert.match(styles, /\.settings-action:active:not\(:disabled\) \{[^}]*background: var\(--mx-flat-press\);/,
    'the ActionButton press must reuse the shared wash');
  assert.match(styles, /\.settings-action\.danger:active:not\(:disabled\) \{[^}]*box-shadow: none;/,
    'the pressed danger plate carries the read without a ring');
  assert.match(styles, /\.settings-action:disabled \{ opacity: \.45; cursor: default; \}/,
    'the ActionButton must own a disabled treatment');
  const ungatedHover = [...styles.matchAll(/(?:^|,)\s*([^,{}\n]*(?:\.settings-action(?![\w-])|\.approval-actions button|\.command-surface-form button|\.onboarding-dialog > (?:footer|header > )button|\.onboarding-choice-grid > button)[^,{}\n]*:hover(?!:not\(:disabled\))[^,{}\n]*)/g)]
    .map((match) => match[1].trim());
  assert.deepEqual(ungatedHover, [], 'flat action hover must never reach a disabled control');
  for (const family of ['.command-surface-form button', '.command-surface .settings-group-body > button',
    '.command-surface .settings-group-body > form button', '.command-surface .settings-resource-actions button']) {
    assert.ok(styles.includes(`${family}:hover:not(:disabled)`), `${family} hover must be gated on :not(:disabled)`);
    assert.doesNotMatch(styles, new RegExp(`${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:hover(?!:not\\(:disabled\\))`),
      `${family} must not keep an ungated hover`);
  }
});

test('explorer logic ports the VS Code Explorer grammar from refs/vscode', async () => {
  const logic = await import('./explorer-logic.ts');
  assert.equal(logic.validateExplorerName({ name: '', windows: true })?.severity, 'error');
  assert.equal(logic.validateExplorerName({ name: '/lead', allowSegments: true, windows: true })?.severity, 'error');
  assert.equal(logic.validateExplorerName({ name: 'aux.txt', windows: true })?.severity, 'error');
  assert.equal(logic.validateExplorerName({ name: 'name.', windows: true })?.severity, 'error');
  assert.equal(logic.validateExplorerName({ name: 'a<b', windows: true })?.severity, 'error');
  assert.equal(logic.validateExplorerName({ name: 'Taken.ts', siblings: ['taken.ts'], windows: true })?.severity,
    'error', 'duplicates are case-insensitive');
  assert.equal(logic.validateExplorerName({
    name: 'File.ts', originalName: 'file.ts', siblings: ['file.ts'], windows: true,
  }), null, 'a case-only rename is not a duplicate');
  assert.equal(logic.validateExplorerName({ name: 'a/b/c.ts', allowSegments: true, windows: true }), null,
    'nested create segments are valid (VS Code multi-segment New File)');
  assert.equal(logic.validateExplorerName({ name: 'a/b', windows: true })?.severity, 'error',
    'rename never accepts path separators');
  assert.equal(logic.validateExplorerName({ name: ' pad ', windows: false })?.severity, 'warning',
    'non-Windows leading/trailing whitespace is a warning, not an error');
  const sorted = logic.sortExplorerEntries([
    { name: 'z.ts', dir: false },
    { name: 'file10.ts', dir: false },
    { name: 'file2.ts', dir: false },
    { name: 'lib', dir: true },
  ]).map((entry) => entry.name);
  assert.deepEqual(sorted, ['lib', 'file2.ts', 'file10.ts', 'z.ts'],
    'directories first, numeric-aware compare (FileSorter default order)');
  assert.equal(logic.explorerPasteName('a.ts', false, new Set(['a.ts'])), 'a copy.ts');
  assert.equal(logic.explorerPasteName('a.ts', false, new Set(['a.ts', 'a copy.ts'])), 'a copy 2.ts');
  assert.equal(logic.explorerTypeAheadIndex(['alpha', 'beta', 'bravo'], 1, 'br'), 2);
});
