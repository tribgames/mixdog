// Records what the Node shell layout and panel surface do, so the Rust ones (`mixdog_tui::surface`) are checked against it
// (tests/layout_twin.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui/app, nothing is written there.
//
//   node record-layout.mjs --tree C:/Project/mixdog --write tests/goldens/layout.json
//   node record-layout.mjs --tree C:/Project/mixdog --check tests/goldens/layout.json
//
// Recorded:
//  * layouts   - computeShellLayout over a generated grid: terminal sizes 8..100 rows by 20..300 columns, every panel kind
//                (picker fit and fill, project picker, context, usage, slash palette, provider and settings text entries with
//                and without a sign-in URL, a multiline core memory entry, question and plain approvals, a pending and a done
//                /btw panel), crossed by seeded modifiers (transcript items, live spinner or command status, queued commands,
//                prompt hint, toast and progress hint, prompt drafts with wraps and wide glyphs, welcome hint, boot latch, the
//                previous transition record). Every primitive field of the layout object is recorded, and the refs after;
//  * rows      - promptContentRows, queuedBandRows and the text-entry reservation over texts and widths;
//  * signature - panelSignatureFlags, panelKindSignature and isInstantPanelCloseTransition over the signatures the layouts
//                produced, and the ones the transition logic names;
//  * surface   - sequences of panel-surface operations (claims, paints, closes, defers, the usage generation, the Enter latch
//                with a fake clock), replaying usePanelOwnership statement for statement (App.jsx is React): the panels, the
//                epoch (relative) and every operation's result after each step.
//
// The corpus keeps clear of the ambiguous-width glyphs the Windows display-width policy widens (U+2190-21FF, U+2460-24FF), so
// the recording does not depend on the platform it was made on.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-layout.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}
process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '0';

const sources = [];
const load = async (path) => {
  const file = join(tree, path);
  sources.push({ path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  return import(pathToFileURL(file).href);
};

// The Enter latch arms a 3 s timer; the recording runs it on a fake clock.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let clock = 0;
let timerSeq = 0;
const timers = new Map();
const fakeSetTimeout = (fn, ms) => {
  timerSeq += 1;
  timers.set(timerSeq, { at: clock + ms, fn });
  return timerSeq;
};
const fakeClearTimeout = (id) => {
  timers.delete(id);
};
const advanceClock = (to) => {
  clock = to;
  for (const [id, timer] of [...timers]) {
    if (timer.at <= clock) {
      timers.delete(id);
      timer.fn();
    }
  }
};

const { computeShellLayout } = await load('src/tui/app/shell-layout.mjs');
const textLayout = await load('src/tui/app/text-layout.mjs');
const panelSignature = await load('src/tui/app/panel-signature.mjs');
const { resolvePickerState } = await load('src/tui/app/picker-index-mode.mjs');
const { withPickerEnterLatch } = await load('src/tui/app/picker-enter-latch.mjs');
const epoch = await load('src/tui/app/panel-epoch.mjs');
const { createPanelSurface } = await load('src/tui/app/panel-surface.mjs');
const { default: stringWidth } = await import(pathToFileURL(join(tree, 'node_modules/string-width/index.js')).href);

// ---- a seeded generator ----
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(0x5eed1a70);
const pick = (list) => list[Math.floor(random() * list.length)];
const chance = (p) => random() < p;

const ref = (current) => ({ current });

// ---- the layout grid ----
const ROWS = [8, 12, 24, 40, 100];
const COLUMNS = [20, 40, 80, 300];
const URL = `https://claude.ai/oauth/authorize?${'q'.repeat(433)}`;
const QUESTIONS = {
  kind: 'question',
  args: {
    questions: [
      { question: 'Which one do you want to use for this run?', header: 'Pick', options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second one' }] },
      { question: 'And then?', header: 'Next', options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }], multi_select: true, recommended: 1 },
    ],
  },
};
const PANELS = [
  {},
  { picker: { kind: 'model', fillAvailable: false } },
  { picker: { kind: 'settings', fillAvailable: true } },
  { picker: { kind: 'project', fillAvailable: false } },
  { contextPanel: true },
  { usagePanel: true },
  { slashPaletteOpen: true },
  { providerPrompt: { kind: 'oauth-code', label: 'OAuth code', detail: URL } },
  { providerPrompt: { kind: 'api-key', label: 'API key' } },
  { settingsPrompt: { kind: 'core-add' } },
  { settingsPrompt: { kind: 'core-edit', detail: 'edit the sentence' } },
  { settingsPrompt: { kind: 'project-new' } },
  { settingsPrompt: { kind: 'project-rename' } },
  { toolApproval: QUESTIONS },
  { toolApproval: { kind: 'bash', args: {} } },
  { btwPanel: { status: 'pending', text: 'thinking\nabout it' } },
  { btwPanel: { status: 'done', text: 'The answer is **short**.\n\n- one\n- two' } },
  { btwPanel: { status: 'done', text: 'word '.repeat(80) } },
];
const DRAFTS = [
  '',
  'hello',
  'x'.repeat(60),
  'x'.repeat(200),
  'line one\nline two\n\nline four',
  '한글입력과 日本語のテキスト and mixed width text that wraps around',
  `${'abcdefghij'.repeat(10)}\n`,
  'a'.repeat(19),
  'a'.repeat(20),
];
const QUEUES = [
  [],
  [{ text: 'a' }],
  [{ text: 'a' }, { displayText: 'b displayed', text: 'ignored' }],
  [{ text: 'a long queued steering command that has to wrap in a narrow frame '.repeat(3) }],
  Array.from({ length: 6 }, (_, n) => ({ text: `queued command number ${n} with some words` })),
];
const ITEM_SETS = [
  [],
  [{ id: 'u1', kind: 'user' }],
  [{ id: 'u1', kind: 'user' }, { id: 'a1', kind: 'assistant' }],
  [{ id: 'u1', kind: 'user' }, { id: 'd1', kind: 'turndone' }],
  [{ id: 'u1', kind: 'user' }, { id: 's1', kind: 'statusdone' }],
  [{ kind: 'user' }],
];
const TOASTS = [null, { text: 'oops', tone: 'error' }, { text: 'a rather longer toast text that does not fit', tone: 'warn' }, { text: 'no tone' }];
const PROGRESS = [null, { text: 'compacting', tone: 'info' }, { text: 'progress without tone' }];
const STREAMING = [
  null,
  { kind: 'assistant', streaming: true, text: 'partial answer' },
  { kind: 'assistant', streaming: true, text: '   ' },
  { kind: 'assistant', streaming: false, text: 'done' },
  { kind: 'tool', streaming: true, text: 'x' },
];
const SIGNATURE_TAILS = ['', '||||||input-visible|0|3|0|0|11', '||||slash||input-visible|14|3|0|0|11', '|picker:project:fit|||||input-hidden|17|0|0|0|0'];

function layoutCases() {
  const cases = [];
  const recentSignatures = [];
  for (const rows of ROWS) {
    for (const columns of COLUMNS) {
      for (const panel of PANELS) {
        for (let n = 0; n < 2; n += 1) {
          const prompt = pick(DRAFTS);
          const spec = {
            rows,
            frameColumns: columns,
            promptContentColumns: Math.max(1, columns - 4),
            tuiReady: chance(0.85),
            providerPrompt: null,
            settingsPrompt: null,
            toolApproval: null,
            picker: null,
            contextPanel: false,
            usagePanel: false,
            btwPanel: null,
            slashPaletteOpen: false,
            ...panel,
            state: {
              items: pick(ITEM_SETS),
              queued: pick(QUEUES),
              spinner: chance(0.3),
              commandStatus: chance(0.15),
              toast: pick(TOASTS),
              progressHint: pick(PROGRESS),
              streamingTail: pick(STREAMING),
              transcriptView: chance(0.1),
            },
            promptHint: chance(0.15) ? 'a prompt hint' : '',
            promptHintTone: pick(['info', 'warn', 'error']),
            onboardingActive: chance(0.08),
            conditionalWelcomePromptHint: chance(0.1) ? 'conditional hint' : '',
            welcomePromptHintDismissed: chance(0.15),
            welcomePromptHintRef: chance(0.4) ? 'press / for commands' : '',
            panelTransitionEpoch: pick([0, 1, 2]),
            promptValue: prompt,
            projectBootInputLatch: chance(0.2),
            panelCloseInkMaskRows: chance(0.2) ? 3 : 0,
            promptBoxRect: chance(0.7),
            transition: null,
          };
          const kind = String(spec.providerPrompt?.kind || spec.settingsPrompt?.kind || '');
          // useTextEntryLayoutRows (use-prompt-layout-rows.mjs): the reservation of a multiline core memory entry.
          spec.textEntryInitialValue = chance(0.5) ? 'a sentence to remember '.repeat(pick([1, 4, 20])) : '';
          spec.textEntryLayoutRows = ['core-add', 'core-edit'].includes(kind)
            ? textLayout.textEntryReservedRows(spec.textEntryInitialValue, Math.max(1, columns - 4 - stringWidth('Sentence > ')), 8)
            : 1;
          if (chance(0.6) && recentSignatures.length) {
            const previous = pick(recentSignatures);
            spec.transition = {
              signature: previous.signature,
              reserve: chance(0.8) ? previous.reserve : pick([0, 3, 31]),
              clearRows: chance(0.2) ? 1 : 0,
              guardRows: chance(0.2) ? 1 : 0,
              epoch: pick([0, 1, 2]),
              tailId: pick([null, 'u1', 'a1', 'd1']),
            };
          } else if (chance(0.15)) {
            spec.transition = { signature: pick(SIGNATURE_TAILS), reserve: pick([0, 6, 17, 31]), clearRows: 0, guardRows: 0, epoch: pick([0, 1]), tailId: pick([null, 'u1']) };
          }
          const out = run(spec);
          recentSignatures.push({ signature: out.primitives.panelLayoutSignature, reserve: out.primitives.bottomClusterRows });
          if (recentSignatures.length > 40) recentSignatures.shift();
          cases.push({ input: spec, ...out });
        }
      }
    }
  }
  return cases;
}

const CONSTANT_KEYS = [
  'SCROLL_HINT_ROWS',
  'LIVE_STATUS_ROWS',
  'STATUSLINE_ROWS',
  'PANEL_MAX_VISIBLE',
  'PANEL_CHROME_ROWS',
  'PANEL_BASE_ROWS',
  'PICKER_CHROME_ROWS',
  'WELCOME_BANNER_ROWS',
  'SLASH_PALETTE_ROWS',
];

function toInput(spec) {
  const state = {
    items: spec.state.items.map((item) => ({ ...item })),
    queued: spec.state.queued.map((item) => ({ ...item })),
    toasts: spec.state.toast ? [{ text: 'older toast', tone: 'info' }, { ...spec.state.toast }] : [],
    spinner: spec.state.spinner ? { active: true, label: 'thinking' } : { active: false },
    commandStatus: spec.state.commandStatus ? { active: true } : null,
    progressHint: spec.state.progressHint ? { ...spec.state.progressHint } : null,
    streamingTail: spec.state.streamingTail ? { ...spec.state.streamingTail } : null,
    transcriptViewItems: spec.state.transcriptView ? [] : null,
  };
  const transition = spec.transition
    ? { ...spec.transition }
    : { signature: '', reserve: 0, clearRows: 0, guardRows: 0, epoch: 0, tailId: null };
  const refs = {
    welcomePromptHintRef: ref(spec.welcomePromptHintRef),
    welcomePromptHintVisibleRef: ref(false),
    panelTransitionRef: ref(transition),
    projectBootInputLatchRef: ref(spec.projectBootInputLatch),
    promptLayoutValueRef: ref(spec.promptValue),
    transcriptBottomSlackRowsRef: ref(0),
    transcriptViewportRef: ref(null),
    frameRowsRef: ref(0),
    promptBoxRectRef: ref(spec.promptBoxRect ? { x: 1 } : null),
    panelCloseInkMaskRowsRef: ref(spec.panelCloseInkMaskRows),
  };
  return {
    refs,
    input: {
      providerPrompt: spec.providerPrompt,
      settingsPrompt: spec.settingsPrompt,
      panelTransitionEpoch: spec.panelTransitionEpoch,
      panelInkMaskEpoch: 0,
      toolApproval: spec.toolApproval,
      picker: spec.picker,
      contextPanel: spec.contextPanel ? { _kind: 'context' } : null,
      usagePanel: spec.usagePanel ? { total: 1 } : null,
      btwPanel: spec.btwPanel,
      slashPaletteOpen: spec.slashPaletteOpen,
      tuiReady: spec.tuiReady,
      state,
      resizeState: { rows: spec.rows },
      frameColumns: spec.frameColumns,
      promptHint: spec.promptHint,
      promptHintTone: spec.promptHintTone,
      textEntryLayoutRows: spec.textEntryLayoutRows,
      onboardingActive: spec.onboardingActive,
      conditionalWelcomePromptHint: spec.conditionalWelcomePromptHint,
      welcomePromptHintDismissed: spec.welcomePromptHintDismissed,
      promptContentColumns: spec.promptContentColumns,
      ...refs,
    },
  };
}

function run(spec) {
  const { input, refs } = toInput(spec);
  const layout = computeShellLayout(input);
  const primitives = {};
  const constants = {};
  for (const [key, value] of Object.entries(layout)) {
    if (CONSTANT_KEYS.includes(key)) constants[key] = value;
    else if (['number', 'boolean', 'string'].includes(typeof value)) primitives[key] = value;
  }
  const item = layout.latestTranscriptItem;
  const toast = layout.latestToast;
  const progress = layout.progressHint;
  const prompt = layout.textEntryPrompt;
  const objects = {
    liveSpinner: Boolean(layout.liveSpinner),
    latestToast: toast ? { text: toast.text ?? '', tone: toast.tone || '' } : null,
    progressHint: progress ? { text: progress.text ?? '', tone: progress.tone || '' } : null,
    latestTranscriptItem: item ? { id: item.id ?? null, kind: item.kind ?? '' } : null,
    textEntryPrompt: prompt ? { kind: prompt.kind || '', detail: prompt.detail || '' } : null,
  };
  const transition = refs.panelTransitionRef.current;
  return {
    constants,
    primitives,
    objects,
    refs: {
      panelCloseInkMaskRows: refs.panelCloseInkMaskRowsRef.current,
      projectBootInputLatch: refs.projectBootInputLatchRef.current,
      welcomePromptHintVisible: refs.welcomePromptHintVisibleRef.current,
      transcriptBottomSlackRows: refs.transcriptBottomSlackRowsRef.current,
      transcriptViewport: refs.transcriptViewportRef.current,
      frameRows: refs.frameRowsRef.current,
      promptBoxRect: refs.promptBoxRectRef.current !== null,
      transition: {
        signature: transition.signature,
        reserve: transition.reserve,
        clearRows: transition.clearRows,
        guardRows: transition.guardRows,
        epoch: transition.epoch,
        tailId: transition.tailId ?? null,
      },
    },
  };
}

// ---- the pure row functions ----
function rowCases() {
  const texts = [
    '', ' ', 'a', 'hello world', 'x'.repeat(10), 'x'.repeat(11), 'x'.repeat(95), 'x'.repeat(96), 'x'.repeat(97),
    'a\nb', 'a\n\nb\n', '\n\n\n', '가나다라마바사', '日本語のテキスト', 'tab\tseparated', 'wrap me please at some width '.repeat(6),
    'one verylongwordthatcannotbebrokenatspaces two', 'e\u0301e\u0301e\u0301', 'a\u200bb', 'trailing space ', '  leading space',
    '\x1b[31mred\x1b[0m text that is long enough to wrap around', 'line\r\nbreak',
  ];
  const widths = [0, 1, 2, 3, 5, 10, 11, 20, 40, 96, 200];
  const out = { promptContentRows: [], queuedBandRows: [], textEntryReservedRows: [], wrappedDetailRows: [] };
  for (const text of texts) {
    for (const width of widths) {
      out.promptContentRows.push({ text, width, rows: textLayout.promptContentRows(text, width) });
      out.queuedBandRows.push({ text, width, rows: textLayout.queuedBandRows(text, width) });
      out.wrappedDetailRows.push({ text, width, rows: textLayout.wrappedDetailRows(text, width) });
      for (const max of [1, 3, 8]) out.textEntryReservedRows.push({ text, width, max, rows: textLayout.textEntryReservedRows(text, width, max) });
    }
  }
  return out;
}

// ---- the signature grammar ----
function signatureCases(layouts) {
  const signatures = new Set(SIGNATURE_TAILS);
  for (const layout of layouts) {
    signatures.add(layout.primitives.panelLayoutSignature);
    if (layout.input.transition?.signature) signatures.add(layout.input.transition.signature);
  }
  signatures.add('|||||text:project-new|input-hidden|9|0|0|0|0');
  signatures.add('|||||text:project-create-confirm|input-hidden|9|0|0|0|0');
  signatures.add('|||||text:project-rename|input-hidden|9|0|0|0|0');
  signatures.add('|||||text:core-add|input-hidden|9|0|0|0|0');
  signatures.add('tool|||||| input-hidden|9|0|0|0|0');
  signatures.add('short');
  const list = [...signatures].sort();
  const flags = list.map((signature) => ({
    signature,
    flags: panelSignature.panelSignatureFlags(signature),
    kind: panelSignature.panelKindSignature(signature),
  }));
  const instant = [];
  const sample = list.length > 60 ? list.filter((_, index) => index % Math.ceil(list.length / 60) === 0) : list;
  for (const prev of sample) {
    for (const next of sample) {
      for (const initial of [false, true]) {
        instant.push({ prev, next, initial, instant: Boolean(panelSignature.isInstantPanelCloseTransition(prev, next, initial)) });
      }
    }
  }
  return { flags, instant };
}

// ---- the surface operation sequences ----
const POOL = [
  { title: 'Settings' },
  { title: 'Settings', items: [] },
  { _kind: 'mcp-servers', title: 'MCP · 1' },
  { _kind: 'mcp-servers', title: 'MCP · 2', indexMode: 'never' },
  { _kind: 'skills', title: 'Extensions' },
  { title: 'Core memories', indexMode: 'auto' },
  { title: 'Model', indexMode: 'always' },
  {},
];

function panelView(panel) {
  return panel ? { kind: panel._kind || '', title: panel.title || '', indexMode: panel.indexMode || null } : null;
}

function surfaceSequences() {
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = fakeClearTimeout;
  const sequences = [];
  for (let n = 0; n < 60; n += 1) {
    timers.clear();
    clock = 0;
    const base = epoch.currentPanelEpoch();
    // usePanelOwnership, statement for statement (App.jsx).
    const openedFromEnterRef = ref(false);
    const openedFromEnterTimerRef = ref(null);
    let picker = null;
    let live = null;
    let contextPanel = null;
    let usagePanel = null;
    const painted = [];
    const setPicker = (next) => {
      const previous = live;
      live = typeof next === 'function' ? next(previous) : next;
      if (epoch.shouldSupersedePanelEpoch(previous, live)) epoch.supersedePanelEpoch();
      picker = resolvePickerState(picker, typeof next === 'function' ? next(picker) : next, {
        pickerOpenedFromEnterRef: openedFromEnterRef,
        pickerOpenedFromEnterTimerRef: openedFromEnterTimerRef,
      });
      painted.push(picker);
    };
    const surface = createPanelSurface({
      setPicker,
      setContextPanel: (value) => {
        contextPanel = value;
      },
      setUsagePanel: (value) => {
        usagePanel = value;
      },
    });
    const claims = [];
    const usageClaims = [];
    const deferred = [];
    const steps = [];
    const length = 30 + Math.floor(random() * 30);
    for (let i = 0; i < length; i += 1) {
      const op = pick(['set', 'set', 'setNull', 'rebuild', 'claim', 'claim', 'paint', 'paint', 'paintNull', 'context', 'contextNull', 'close', 'defer', 'run', 'claimUsage', 'paintUsage', 'closeUsage', 'supersede', 'enter', 'tick', 'render']);
      const step = { op };
      let result = null;
      if (op === 'set') {
        const index = Math.floor(random() * POOL.length);
        step.panel = panelView(POOL[index]);
        setPicker({ ...POOL[index] });
      } else if (op === 'setNull') {
        setPicker(null);
      } else if (op === 'rebuild') {
        setPicker((previous) => (previous ? { ...previous } : previous));
      } else if (op === 'claim') {
        claims.push(surface.claim());
        step.claim = claims.length - 1;
      } else if (op === 'enter') {
        const index = Math.floor(random() * POOL.length);
        step.panel = panelView(POOL[index]);
        step.at = clock;
        withPickerEnterLatch(openedFromEnterRef, openedFromEnterTimerRef, () => setPicker({ ...POOL[index] }));
      } else if (op === 'tick') {
        step.to = clock + pick([1, 500, 2999, 3000, 4000]);
        advanceClock(step.to);
      } else if (op === 'render') {
        live = picker;
      } else if (op === 'supersede') {
        epoch.supersedePanelEpoch();
      } else if (op === 'claimUsage') {
        usageClaims.push(surface.claimUsage());
        step.claim = usageClaims.length - 1;
      } else if (op === 'closeUsage') {
        surface.closeUsage();
      } else if (op === 'paintUsage') {
        if (!usageClaims.length) continue;
        step.claim = Math.floor(random() * usageClaims.length);
        step.value = i;
        result = usageClaims[step.claim].paint(i);
      } else {
        if (!claims.length) continue;
        step.claim = Math.floor(random() * claims.length);
        const own = claims[step.claim];
        if (op === 'paint') {
          const index = Math.floor(random() * POOL.length);
          step.panel = panelView(POOL[index]);
          result = own.paint({ ...POOL[index] });
        } else if (op === 'paintNull') {
          result = own.paint(null);
        } else if (op === 'context') {
          step.value = `ctx${i}`;
          result = own.context(step.value);
        } else if (op === 'contextNull') {
          result = own.context(null);
        } else if (op === 'close') {
          result = own.close();
        } else if (op === 'defer') {
          const marker = { settled: 0 };
          deferred.push({ marker, run: own.defer(() => (marker.settled += 1)) });
          step.deferred = deferred.length - 1;
        } else if (op === 'run') {
          if (!deferred.length) continue;
          step.deferred = Math.floor(random() * deferred.length);
          const before = deferred[step.deferred].marker.settled;
          deferred[step.deferred].run();
          result = deferred[step.deferred].marker.settled > before;
        }
      }
      steps.push({
        ...step,
        result,
        picker: panelView(picker),
        live: panelView(live),
        context: contextPanel,
        usage: usagePanel,
        epoch: epoch.currentPanelEpoch() - base,
        latch: openedFromEnterRef.current,
        paints: painted.length,
      });
    }
    sequences.push({ steps });
  }
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  return sequences;
}

const layouts = layoutCases();
// Every layout object has the same primitive fields: they are recorded once, and each case carries the values in that order.
const fields = Object.keys(layouts[0].primitives);
for (const layout of layouts) {
  const keys = Object.keys(layout.primitives);
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) throw new Error('the layout object changed shape between cases');
}
const golden = {
  format: 1,
  sources,
  constants: layouts[0].constants,
  fields,
  layouts: layouts.map(({ constants, primitives, ...rest }) => ({ ...rest, values: fields.map((key) => primitives[key]) })),
  rows: rowCases(),
  signature: signatureCases(layouts),
  surface: surfaceSequences(),
};
const text = `${JSON.stringify(golden)}\n`;

const write = option('--write');
const check = option('--check');
if (write) {
  writeFileSync(write, text);
  console.error(`wrote ${write}: ${layouts.length} layouts, ${golden.rows.promptContentRows.length} row cases, ${golden.surface.length} surface sequences`);
}
if (check) {
  const recorded = readFileSync(check, 'utf8');
  if (recorded !== text) {
    console.error(`${check} is not what the Node code records now`);
    process.exit(1);
  }
  console.error(`${check} matches`);
}
