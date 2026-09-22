import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeShellLayout } from './shell-layout.mjs';
// The same signature grammar App.jsx hands to computeShellLayout.
import {
  CORE_MULTILINE_TEXT_ENTRY_KINDS,
  PANEL_LAYOUT_SIG,
  isInstantPanelCloseTransition,
  panelKindSignature,
  panelSignatureFlags,
} from './panel-signature.mjs';

const ref = (current) => ({ current });

function layoutInput(overrides = {}) {
  return {
    providerPrompt: null,
    settingsPrompt: null,
    panelTransitionEpoch: 1,
    panelInkMaskEpoch: 0,
    toolApproval: null,
    picker: null,
    contextPanel: null,
    usagePanel: null,
    slashPaletteOpen: false,
    tuiReady: true,
    state: {
      items: [],
      queued: [],
      toasts: [],
      spinner: null,
      commandStatus: null,
      progressHint: null,
      streamingTail: null,
      transcriptViewItems: null,
    },
    resizeState: { rows: 40 },
    frameColumns: 100,
    promptHint: '',
    promptHintTone: 'info',
    textEntryLayoutRows: 1,
    onboardingActive: false,
    conditionalWelcomePromptHint: '',
    welcomePromptHintDismissed: false,
    welcomePromptHintRef: ref(''),
    welcomePromptHintVisibleRef: ref(false),
    panelTransitionRef: ref({ signature: '', reserve: 0, clearRows: 0, guardRows: 0, epoch: 0, tailId: null }),
    projectBootInputLatchRef: ref(false),
    promptLayoutValueRef: ref(''),
    promptContentColumns: 96,
    transcriptBottomSlackRowsRef: ref(0),
    transcriptViewportRef: ref(null),
    frameRowsRef: ref(0),
    promptBoxRectRef: ref({ x: 1 }),
    panelCloseInkMaskRowsRef: ref(0),
    CORE_MULTILINE_TEXT_ENTRY_KINDS,
    panelSignatureFlags,
    panelKindSignature,
    isInstantPanelCloseTransition,
    PANEL_LAYOUT_SIG,
    ...overrides,
  };
}

function pick(layout, keys) {
  return Object.fromEntries(keys.map((key) => [key, layout[key]]));
}

const CORE_KEYS = [
  'inputBoxHidden',
  'promptBoxRows',
  'promptMetaRows',
  'queuedRows',
  'WELCOME_ROWS',
  'floatingPanelRows',
  'baseReserve',
  'bottomClusterRows',
  'bottomReserve',
  'viewportHeight',
  'transcriptGuardRows',
  'panelCloseMaskRows',
  'transcriptContentHeight',
  'panelLayoutSignature',
];

test('idle empty transcript reserves banner + prompt + statusline and gives the rest to the transcript', () => {
  const input = layoutInput();
  const layout = computeShellLayout(input);
  assert.deepEqual(pick(layout, CORE_KEYS), {
    inputBoxHidden: false,
    promptBoxRows: 3,
    promptMetaRows: 0,
    queuedRows: 0,
    WELCOME_ROWS: 11,
    floatingPanelRows: 0,
    baseReserve: 17,
    bottomClusterRows: 6,
    bottomReserve: 17,
    viewportHeight: 23,
    transcriptGuardRows: 1,
    panelCloseMaskRows: 0,
    transcriptContentHeight: 22,
    panelLayoutSignature: '||||||input-visible|0|3|0|0|11',
  });
  assert.equal(layout.maxFloatingPanelRows, 22);
  assert.equal(layout.pickerVisibleRows, 8);
  assert.equal(layout.showWelcomeBanner, true);
  assert.deepEqual(input.transcriptViewportRef.current, { top: 11, bottom: 32 });
  assert.equal(input.frameRowsRef.current, 40);
  assert.equal(input.transcriptBottomSlackRowsRef.current, 1);
  assert.deepEqual(input.promptBoxRectRef.current, { x: 1 }, 'visible prompt keeps its measured rect');
  assert.equal(layout.promptSpinnerColumns, 100);
  assert.equal(layout.transientStatusWidth, 0);
});

test('an option picker hides the prompt box and takes the panel rows', () => {
  const input = layoutInput({
    picker: { kind: 'model' },
    state: { ...layoutInput().state, items: [{ id: 'a', kind: 'user' }] },
    promptLayoutValueRef: ref('hello'),
  });
  const layout = computeShellLayout(input);
  assert.deepEqual(pick(layout, CORE_KEYS), {
    inputBoxHidden: true,
    promptBoxRows: 0,
    promptMetaRows: 0,
    queuedRows: 0,
    WELCOME_ROWS: 0,
    floatingPanelRows: 17,
    baseReserve: 3,
    bottomClusterRows: 20,
    bottomReserve: 20,
    viewportHeight: 20,
    transcriptGuardRows: 1,
    panelCloseMaskRows: 0,
    transcriptContentHeight: 19,
    panelLayoutSignature: '|picker:model:fit|||||input-hidden|17|0|0|0|0',
  });
  assert.equal(layout.pickerVisibleRows, 11);
  assert.equal(layout.desiredFloatingPanelRows, 17);
  assert.equal(input.promptBoxRectRef.current, null, 'hidden prompt drops its stale rect');
});

test('a live spinner plus queued prompts reserve the meta band and the queued band', () => {
  const input = layoutInput({
    state: {
      ...layoutInput().state,
      items: [{ id: 'u1', kind: 'user' }],
      spinner: { active: true, label: 'thinking' },
      queued: [
        { id: 'q1', text: 'a' },
        { id: 'q2', displayText: 'b' },
      ],
    },
    promptLayoutValueRef: ref('x'),
  });
  const layout = computeShellLayout(input);
  assert.deepEqual(pick(layout, CORE_KEYS), {
    inputBoxHidden: false,
    promptBoxRows: 3,
    promptMetaRows: 2,
    queuedRows: 2,
    WELCOME_ROWS: 0,
    floatingPanelRows: 0,
    baseReserve: 10,
    bottomClusterRows: 10,
    bottomReserve: 10,
    viewportHeight: 30,
    transcriptGuardRows: 1,
    panelCloseMaskRows: 0,
    transcriptContentHeight: 29,
    panelLayoutSignature: '||||||input-visible|0|3|2|2|0',
  });
  assert.equal(layout.queuedVisible, true);
  assert.equal(layout.queuedCompact, false);
  assert.equal(layout.promptMetaVisible, true);
  assert.equal(layout.liveSpinner, input.state.spinner);
  assert.equal(layout.overlayHintRequested, false);
  assert.deepEqual(input.transcriptViewportRef.current, { top: 0, bottom: 28 });
});

test('a toast on the empty transcript carves an in-viewport hint row and sizes the hint slot', () => {
  const input = layoutInput({
    state: { ...layoutInput().state, toasts: [{ text: 'oops', tone: 'error' }] },
  });
  const layout = computeShellLayout(input);
  assert.equal(layout.inputHint, 'oops');
  assert.equal(layout.inputHintTone, 'error');
  assert.equal(layout.overlayHintRequested, true);
  assert.equal(layout.overlayHintBandRows, 1);
  assert.equal(layout.transcriptContentHeight, 21);
  assert.equal(layout.spinnerHintWidth, 42);
  assert.equal(layout.guardHintWidth, 42);
  assert.equal(layout.transientStatusWidth, 42);
  assert.equal(layout.promptSpinnerColumns, 100);
  assert.equal(layout.welcomePromptHintRows, 0);
});

test('a live spinner shares the hint slot width and leaves room for its separator', () => {
  const input = layoutInput({
    state: {
      ...layoutInput().state,
      spinner: { active: true, label: 'thinking' },
      toasts: [{ text: 'oops', tone: 'error' }],
    },
  });
  const layout = computeShellLayout(input);
  assert.equal(layout.spinnerHintWidth, 42);
  assert.equal(layout.guardHintWidth, 42);
  assert.equal(layout.transientStatusWidth, 42);
  assert.equal(layout.promptSpinnerColumns, 57);
});

test('closing the slash palette on the empty screen masks the reclaimed rows for one commit', () => {
  const panelTransition = {
    signature: '||||slash||input-visible|14|3|0|0|11',
    reserve: 31,
    clearRows: 0,
    guardRows: 0,
    epoch: 0,
    tailId: null,
  };
  const input = layoutInput({ panelTransitionRef: ref(panelTransition) });
  const layout = computeShellLayout(input);
  assert.equal(layout.panelLayoutChanged, true);
  assert.equal(input.panelCloseInkMaskRowsRef.current, 25);
  assert.equal(layout.panelCloseInkMaskRows, 25);
  assert.equal(layout.panelTransitionClearRows, 0);
  assert.equal(layout.panelTransitionGuardRows, 0);
  assert.equal(panelTransition.epoch, 1);
  assert.equal(layout.viewportHeight, 23);
  assert.equal(layout.panelCloseMaskRows, 21);
  assert.equal(layout.transcriptContentHeight, 1);
});

test('opening the slash palette on the empty screen borrows one guard row', () => {
  const panelTransition = {
    signature: '||||||input-visible|0|3|0|0|11',
    reserve: 17,
    clearRows: 0,
    guardRows: 0,
    epoch: 0,
    tailId: null,
  };
  const input = layoutInput({ slashPaletteOpen: true, panelTransitionRef: ref(panelTransition) });
  const layout = computeShellLayout(input);
  assert.equal(layout.hasFloatingPanel, true);
  assert.equal(layout.inputBoxHidden, false);
  assert.equal(layout.slashKeepsWelcomeBanner, true);
  assert.equal(layout.floatingPanelRows, 14);
  assert.equal(layout.panelTransitionGuardRows, 1);
  assert.equal(panelTransition.guardRows, 1);
  assert.equal(layout.transcriptGuardRows, 2);
  assert.equal(layout.viewportHeight, 40 - 31);
  assert.equal(layout.transcriptContentHeight, 7);
  assert.equal(input.panelCloseInkMaskRowsRef.current, 0);
});

test('prompt-row-only churn while a spinner meta band collapses onto a fresh done row masks nothing', () => {
  const panelTransition = {
    signature: '||||||input-visible|0|3|2|0|0',
    reserve: 8,
    clearRows: 0,
    guardRows: 0,
    epoch: 0,
    tailId: 'u1',
  };
  const input = layoutInput({
    panelTransitionRef: ref(panelTransition),
    state: {
      ...layoutInput().state,
      items: [
        { id: 'u1', kind: 'user' },
        { id: 'd1', kind: 'turndone' },
      ],
    },
  });
  const layout = computeShellLayout(input);
  assert.equal(layout.panelLayoutSignature, '||||||input-visible|0|3|0|0|0');
  assert.equal(layout.panelLayoutChanged, true);
  assert.equal(input.panelCloseInkMaskRowsRef.current, 0, 'the done row already backfills the vacated meta rows');
  assert.equal(layout.transcriptContentHeight, 33);
});
