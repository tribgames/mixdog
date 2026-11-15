// Records what the Node prompt editor does, so the Rust editor (`mixdog_tui::editor`) is checked against it
// (tests/editor_twin.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui, nothing is written there.
//
//   node record-editor.mjs --tree C:/Project/mixdog --write tests/goldens/editor.json
//   node record-editor.mjs --tree C:/Project/mixdog --check tests/goldens/editor.json
//
// Recorded:
//  * text   - every pure function of input-editing.mjs over a corpus of texts (ASCII, CJK, emoji, Korean jamo and
//             syllables, combining marks, newlines, long lines) at every offset, and the wrapped geometry at widths 1..20;
//  * edits  - the deletions, selection replacement and cursor moves of input-editing.mjs and edit-helpers.mjs from many
//             drafts (every caret, with and without a selection anchor);
//  * policy - classifyPromptEscape, the restore policy, the interrupt policy, the modified-Enter recognisers and
//             decodeArrowSignals over sequences;
//  * wrap   - the rows Ink's wrapText (wrap="hard") makes of a prompt value, which the Rust render must equal;
//  * session- createPromptKeyHandler driven by (input, key) events from many initial drafts: the draft, the callback calls,
//             the undo depth and the escape arming after every event. The events are the decoder corpus's recorded pairs
//             (../../mixdog-term/tests/goldens/keys.json) and a hand-written vocabulary of editing chords, mixed by a seeded
//             generator. PromptInput.jsx is React; its commit path, submit gate, paste handling and callbacks are copied
//             here statement for statement (the same way record-keys.mjs copies use-input.js handleData).
//
// The corpus keeps clear of the ambiguous-width glyphs the Windows display-width policy widens (U+2190-21FF, U+2460-24FF),
// so the recording does not depend on the platform it was made on.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-editor.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}
process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '0';
const here = dirname(fileURLToPath(import.meta.url));
const keysGolden = option('--keys') ?? resolve(here, '../../../mixdog-term/tests/goldens/keys.json');

const sources = [];
const load = async (path) => {
  const file = join(tree, path);
  sources.push({ path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  return import(pathToFileURL(file).href);
};
const ed = await load('src/tui/input-editing.mjs');
const helpers = await load('src/tui/components/prompt-input/edit-helpers.mjs');
const { createPromptKeyHandler } = await load('src/tui/components/prompt-input/key-handler.mjs');
const { createVerticalMover } = await load('src/tui/components/prompt-input/edit-chords.mjs');
const { createUndoStack } = await load('src/tui/components/prompt-input/undo-stack.mjs');
const escapePolicy = await load('src/tui/components/prompt-input/escape-policy.mjs');
const restore = await load('src/tui/components/prompt-input/restore-policy.mjs');
const interrupt = await load('src/tui/components/prompt-input/interrupt-policy.mjs');
const signals = await load('src/tui/components/prompt-input/key-signals.mjs');
const wrapTextFile = join(tree, 'node_modules/ink/build/wrap-text.js');
const wrapText = (await import(pathToFileURL(wrapTextFile).href)).default;

const FLAG_ORDER = [
  'upArrow', 'downArrow', 'leftArrow', 'rightArrow', 'pageDown', 'pageUp', 'home', 'end', 'return', 'escape',
  'ctrl', 'shift', 'tab', 'backspace', 'delete', 'meta', 'super', 'hyper', 'capsLock', 'numLock',
];
const keyOf = (names) => Object.fromEntries(FLAG_ORDER.map((name) => [name, names.includes(name)]));

// ---------------------------------------------------------------- corpus

const TEXTS = [
  '', 'a', 'hello world', 'alpha beta  gamma', '  leading and trailing  ', 'one\ntwo\nthree', '\n', 'a\n\nb\n',
  '\u{d55c}\u{ae00} \u{d14d}\u{c2a4}\u{d2b8}', '\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}\u{4e16}\u{754c}', 'a\u{65e5}b\u{672c}c',
  '\u{1f600}', 'a\u{1f600}b', '\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467} family', '\u{1f1f0}\u{1f1f7}\u{1f1ef}\u{1f1f5}',
  'e\u{301}x a\u{300}', '\u{1112}\u{1161}\u{11ab} \u{1100}\u{1161}', 'snake_case_word kebab-case', 'a.b,c;d',
  'x'.repeat(23), 'ab\u{65e5}\u{672c}\u{8a9e}cd'.repeat(3), 'line one is long enough\nshort\nand another long line here',
  'tab\tinside', '$HOME and $name', 'ends with newline\n',
];
const WIDTHS = [1, 2, 3, 4, 5, 8, 20];

const cases = [];

// -- text ------------------------------------------------------------------------------------------------------

for (const text of TEXTS) {
  const rows = [];
  for (let off = 0; off <= text.length; off += 1) {
    const word = ed.wordRangeAt(text, off);
    rows.push([
      off, ed.previousOffset(text, off), ed.nextOffset(text, off), ed.previousWordOffset(text, off),
      ed.nextWordOffset(text, off), ed.lineStart(text, off), ed.lineEnd(text, off), word.start, word.end,
    ]);
  }
  cases.push({ t: 'offsets', text, rows });
  for (const width of WIDTHS) {
    const geometry = [];
    for (let off = 0; off <= text.length; off += 1) {
      const caret = ed.caretPosition(text, off, width);
      const caretT = ed.caretPosition(text, off, width, true);
      const up = ed.verticalOffset(text, off, width, -1, null);
      const down = ed.verticalOffset(text, off, width, 1, null);
      const upPref = ed.verticalOffset(text, off, width, -1, 3);
      const downPref = ed.verticalOffset(text, off, width, 1, 3);
      geometry.push([
        off, caret.row, caret.col, caretT.row, caretT.col, up.cursor, up.preferredColumn, down.cursor,
        down.preferredColumn, upPref.cursor, downPref.cursor,
      ]);
    }
    const cells = [];
    for (let row = 0; row < 5; row += 1) {
      for (const col of [0, 1, 2, 5, width, width + 3]) cells.push([row, col, ed.offsetAtCell(text, row, col, width)]);
    }
    cases.push({ t: 'geometry', text, width, rows: geometry, cells });
  }
}

// -- edits -----------------------------------------------------------------------------------------------------

const shape = (d) => [d.value, d.cursor, d.selectionAnchor ?? null];
for (const text of TEXTS.slice(0, 16)) {
  const drafts = [];
  for (let cursor = 0; cursor <= text.length; cursor += 1) {
    for (const anchor of [null, 0, text.length, Math.max(0, cursor - 2), Math.min(text.length, cursor + 3)]) {
      drafts.push({ value: text, cursor, selectionAnchor: anchor });
    }
  }
  const rows = drafts.map((draft) => [
    shape(draft),
    shape(ed.deleteBackwardWord(draft)),
    shape(ed.deleteForwardWord(draft)),
    shape(ed.deleteToLineStart(draft)),
    shape(ed.deleteToLineEnd(draft)),
    shape(helpers.deleteBackwardChar(draft)),
    shape(helpers.deleteForwardChar(draft)),
    shape(ed.replaceSelection(draft, 'XY\u{1f600}')),
    shape(ed.deleteSelectedText(draft)),
    shape(ed.moveCursor(draft, Math.floor(text.length / 2), { extend: true })),
    shape(ed.moveCursor(draft, 1, { extend: false })),
    ed.selectionRange(draft) ? [ed.selectionRange(draft).start, ed.selectionRange(draft).end] : null,
    [
      helpers.leftArrowOffset(draft, { word: false, extend: false }),
      helpers.leftArrowOffset(draft, { word: true, extend: false }),
      helpers.leftArrowOffset(draft, { word: false, extend: true }),
      helpers.rightArrowOffset(draft, { word: false, extend: false }),
      helpers.rightArrowOffset(draft, { word: true, extend: false }),
      helpers.rightArrowOffset(draft, { word: false, extend: true }),
    ],
  ]);
  cases.push({ t: 'edits', rows });
}

// -- policy ----------------------------------------------------------------------------------------------------

{
  const rows = [];
  for (const interruptActive of [false, true]) {
    for (const hasSelection of [false, true]) {
      for (const hasQueuedMessages of [false, true]) {
        for (const hasMessages of [false, true]) {
          for (const value of ['', 'x']) {
            for (const last of [0, 9_200, 9_199, 9_900, 10_000, 10_001]) {
              for (const now of [10_000, 0]) {
                const decision = escapePolicy.classifyPromptEscape({
                  interruptActive, hasSelection, hasQueuedMessages, hasMessages, value, lastClearPressAt: last, now,
                });
                rows.push([interruptActive, hasSelection, hasQueuedMessages, hasMessages, value, last, now, decision.action, decision.nextClearPressAt]);
              }
            }
          }
        }
      }
    }
  }
  cases.push({ t: 'escape', rows });
}
{
  const queuedTexts = ['', '  ', 'queued', 'two\nlines', '\u{1f600} emoji', '\u{d55c}'];
  const drafts = [
    { value: '', cursor: 0, selectionAnchor: null }, { value: '  ', cursor: 1, selectionAnchor: null },
    { value: 'typing', cursor: 3, selectionAnchor: 1 }, { value: 'a\u{1f600}b', cursor: 99, selectionAnchor: 77 },
    { value: 'x', cursor: 0, selectionAnchor: 1 },
  ];
  const merges = [];
  for (const queued of queuedTexts) {
    for (const draft of drafts) {
      merges.push([queued, shape(draft), shape(restore.mergeQueuedRestoreDraft(queued, draft)), restore.queuedRestorePrefix(queued, draft.value)]);
    }
  }
  const replaces = [];
  for (const optimistic of ['', 'opt\n', 'q']) {
    for (const authoritative of ['', 'authoritative\n', 'z']) {
      for (const draft of [{ value: 'opt\nhello', cursor: 7, selectionAnchor: 2 }, { value: 'q rest', cursor: 1, selectionAnchor: null }, { value: 'zzz', cursor: 3, selectionAnchor: 0 }]) {
        const result = restore.replaceQueuedRestorePrefix(optimistic, authoritative, draft);
        replaces.push([optimistic, authoritative, shape(draft), shape(result), result.replaced]);
      }
    }
  }
  const entries = [
    { id: 'a', displayText: 'first' }, { id: 2, text: 'second', prompt: 'no' }, { id: 'c', prompt: '  ' },
    { id: 'd', prompt: 'fourth' }, { text: 'no id' }, { id: 'e', displayText: null, text: 'null falls through' },
  ];
  const projections = ['', ' 2 ', 'a', 'zz'].map((id) => [id, restore.queuedRestoreProjection(entries, id)]);
  const verticals = [-3, 0, 1, 2, 3].map((count) => [count, restore.paletteOwnsPromptVerticalArrow(count)]);
  cases.push({ t: 'restore', merges, replaces, entries, projections, verticals });
}
{
  const results = [
    undefined, { aborted: false, restoreText: 'x' }, { aborted: true, restoreText: '  fix it \n' }, { restoreText: 'x' },
    { aborted: true }, { aborted: true, restoreText: '   ' },
  ];
  const rows = [];
  for (const result of results) {
    for (const current of ['', 'typed']) rows.push([result ?? null, current, interrupt.promptInterruptRestoreText(result, current)]);
  }
  cases.push({ t: 'interrupt', rows });
}
{
  const sequences = [
    '\r', '\n', '', '\x1b[13;1u', '\x1b[13;2u', '\x1b[13;3u', '\x1b[13;4u', '\x1b[13;5u', '\x1b[13;6u', '\x1b[13;7u',
    '\x1b[13;8u', '\x1b[13;9u', '\x1b[13;16u', '[13;2u', '13;2u', '\x1b[13;2:1u', '\x1b[13;5;10:2u', '\x1b[13;2;u',
    '\x1b[27;1;13~', '\x1b[27;2;13~', '\x1b[27;3;13~', '\x1b[27;5;13~', '\x1b[27;9;13~', '[27;5;13~', '\x1b[27;5;14~',
    '\x1b[13;99999999999u', '\x1b[13;0u', '\x1b[13u', '\x1b[14;2u', 'abc', '\x1b[13;2ux',
  ];
  const enters = sequences.map((s) => [s, helpers.isModifiedEnterSequence(s), helpers.isAnyModifiedEnterSequence(s), helpers.csiBody(s)]);
  const pastes = ['', 'a', 'a\n', 'a\r\n', 'a\rb', '\n', '\r', '\r\n', 'a\nb\n', 'a\nb', 'abc\r', '\n\n'].map((s) => [
    s, helpers.normalizePastedText(s), helpers.singleTrailingLineBreakPrefix(s),
  ]);
  const raws = [
    '', 'a', '\x1b[A', '\x1bOA', '[A', 'OA', '\x1b[B', '\x1bOB', '[B', 'OB', '\x1b[1;2A', '\x1b[a', '[1;2A', '\x1b[1;2B', '\x1b[b',
    '\x1b[1;2C', '\x1b[c', '\x1b[1;2D', '\x1b[d', '\x1b[1;6A', '[1;6B', '\x1b[1;6C', '\x1b[1;6D', '[1;6D', '\x1b[1;5D', 'x[1;2D',
    '\x1b[<64;55;22M', '[<0;1;1m', '[<0;1;1', '<0;1;1M', 'a\x1b[<0;1;1Mb', '\x1b[<a;1;1M', '\x1b[?7u', '[?1;0c', '\x1b[?', '[?x',
    '\x1b[13;2u', '\x00', '\x1b[32;5u', '[32;5u', '\x1b[32;6u', 'a\x1b[<0;1;1Mb\r\n', 'text\r',
  ];
  const keyCases = [[], ['ctrl'], ['shift'], ['shift', 'ctrl', 'leftArrow'], ['shift', 'ctrl', 'upArrow'], ['shift', 'leftArrow'], ['ctrl', 'rightArrow']];
  const arrows = [];
  for (const raw of raws) {
    for (const names of keyCases) {
      const s = signals.decodeArrowSignals(raw, keyOf(names));
      arrows.push([raw, names, Object.entries(s).filter(([, v]) => v).map(([k]) => k)]);
    }
  }
  const reports = raws.map((raw) => [
    raw, signals.isMouseReportSequence(raw), signals.isCsiPrivateReply(raw), signals.isDiscardedControlInput(raw),
    signals.printableFromInput(raw),
  ]);
  cases.push({ t: 'signals', enters, pastes, arrows, reports });
}

// -- wrap ------------------------------------------------------------------------------------------------------

{
  const rows = [];
  // wrap-ansi normalises its input to NFC, which the render does not do: texts it would change are left out.
  for (const text of TEXTS.filter((t) => t.normalize('NFC') === t)) {
    for (const width of WIDTHS) {
      for (const trailing of [false, true]) {
        rows.push([text, width, trailing, wrapText(trailing ? `${text} ` : text, width, 'hard').split('\n')]);
      }
    }
  }
  cases.push({ t: 'wrap', rows });
}

// -- sessions --------------------------------------------------------------------------------------------------

// A seeded generator, so the corpus is the same on every run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ev = (input, names = []) => ({ input, key: names });
const handWritten = [
  ...['a', 'b', ' ', 'x', 'Q', '\u{d55c}', '\u{ac00}', '\u{1f600}', 'e\u{301}', '\u{6f22}', 'hello world', '$pd', '\u{1f1f0}\u{1f1f7}'].map((c) =>
    ev(c, /^[A-Z]$/.test(c) ? ['shift'] : [])),
  ...['leftArrow', 'rightArrow', 'upArrow', 'downArrow'].flatMap((arrow) => [
    ev('', [arrow]), ev('', [arrow, 'shift']), ev('', [arrow, 'ctrl']), ev('', [arrow, 'meta']), ev('', [arrow, 'ctrl', 'shift']),
  ]),
  ev('\x1b[1;2A'), ev('\x1b[1;2B'), ev('\x1b[1;2C'), ev('\x1b[1;2D'), ev('\x1b[1;6A'), ev('\x1b[1;6B'), ev('\x1b[1;6C'),
  ev('\x1b[1;6D'), ev('\x1b[A'), ev('\x1bOB'), ev('[D'), ev('\x1b[d'),
  ev('', ['home']), ev('', ['end']), ev('', ['home', 'shift']), ev('', ['end', 'shift']), ev('', ['pageUp']), ev('', ['pageDown']),
  ev('', ['tab']), ev('', ['escape']), ev('', ['escape']),
  ev('', ['return']), ev('\r', ['return']), ev('', ['return', 'shift']), ev('', ['return', 'meta']), ev('', ['return', 'ctrl']),
  ev('\n'), ev('\r'), ev('\r\n'), ev('abc\n'), ev('abc\r'), ev('one\ntwo'), ev('a\r\nb'), ev('\x1b[13;2u'), ev('\x1b[13;1u'),
  ev('\x1b[13;9u'), ev('\x1b[27;5;13~'), ev('\x1b[27;3;13~'),
  ev('', ['backspace']), ev('', ['delete']), ev('', ['backspace', 'ctrl']), ev('', ['backspace', 'meta']), ev('', ['delete', 'ctrl']),
  ...['a', 'e', 'b', 'f', 'u', 'k', 'w', 'z', 'y', 'j', 'v', 'l', 'd'].map((c) => ev(c, ['ctrl'])),
  ev('z', ['ctrl', 'shift']), ev('b', ['meta']), ev('f', ['meta']), ev('d', ['meta']), ev('b', ['meta', 'shift']), ev('v', ['meta']),
  ev('\x1a'), ev('\x19'), ev('\x00'), ev('\x1b[32;5u'),
  ev('\x1b[<64;55;22M'), ev('[<0;1;1m'), ev('\x1b[?7u'), ev('[?1;0c'),
];
const decoderPairs = (() => {
  let golden;
  try {
    golden = JSON.parse(readFileSync(keysGolden, 'utf8'));
  } catch {
    return [];
  }
  const seen = new Map();
  for (const entry of golden.entries) {
    for (const event of entry.whole) {
      if (event.t !== 'key' || event.eventType === 'release') continue;
      const id = JSON.stringify([event.input, event.key]);
      if (!seen.has(id)) seen.set(id, ev(event.input, event.key));
    }
  }
  return [...seen.values()].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
})();

const INITIAL_VALUES = [
  '', 'hello world', 'alpha beta  gamma delta', 'one\ntwo\nthree', 'line one is long enough\nshort\nand another long line here',
  '\u{d55c}\u{ae00} \u{d14d}\u{c2a4}\u{d2b8} \u{c785}\u{b825}', 'a\u{65e5}\u{672c}\u{8a9e}b\u{1f600}c', 'fix  then ship', 'echo $HOME please',
  'x'.repeat(30), 'back\\', '\u{1112}\u{1161}\u{11ab} e\u{301}',
];
const rand = mulberry32(20261115);
const pick = (list) => list[Math.floor(rand() * list.length)];
const chance = (p) => rand() < p;

function simulate(session) {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const log = [];
    const script = session.script;
    const props = session.props;
    const draftRef = { current: { value: session.draft.value, cursor: session.draft.cursor, selectionAnchor: session.draft.selectionAnchor } };
    const undoRef = { current: { past: [], future: [], lastPushAt: 0, lastValue: null } };
    const escapeClearAtRef = { current: 0 };
    const preferredColumnRef = { current: null };
    const contentWidthRef = { current: session.width };
    let lastReportedValue = draftRef.current.value;
    let lastReportedCursor = null;
    let pasteGeneration = 0;
    let submitGate = false;

    const reportCaret = (cursor) => {
      if (cursor === lastReportedCursor) return;
      lastReportedCursor = cursor;
      log.push(`caret:${cursor}`);
    };
    const commitDraft = (next, options = {}) => {
      escapeClearAtRef.current = 0;
      const sameDraft = helpers.draftStateEqual(draftRef.current, next);
      if (!options.keepPreferredColumn) preferredColumnRef.current = null;
      if (sameDraft) return;
      if (!options.skipHistory) undoStack.record(draftRef.current, next, options);
      draftRef.current = next;
      if (next.value !== lastReportedValue) {
        lastReportedValue = next.value;
        log.push(`draft:${next.value}`);
      }
      reportCaret(next.cursor);
    };
    const undoStack = createUndoStack({ stateRef: undoRef, draftRef, commit: (next, options) => commitDraft(next, options) });
    const updateDraft = (fn, options = {}) => commitDraft(fn(draftRef.current), options);
    const moveDraftVertically = createVerticalMover({ draftRef, contentWidthRef, preferredColumnRef, commitDraft });
    const restoreQueuedToDraft = ({ showHint = false } = {}) => {
      log.push(`restore:${showHint}:${draftRef.current.value}`);
      return script.restore === true;
    };
    const applyHistoryNavigation = (direction, meta = {}) => {
      log.push(`history:${direction}:${draftRef.current.value}:${meta.emptyDraft}`);
      const nextValue = script.history ?? undefined;
      if (typeof nextValue !== 'string') return false;
      commitDraft({ value: nextValue, cursor: nextValue.length, selectionAnchor: null });
      return true;
    };
    const insertAtDraft = (text) => {
      const value = String(text ?? '');
      if (!value) return;
      commitDraft(helpers.insertText(draftRef.current, value));
    };
    const handleExternalPaste = (text, meta = {}) => {
      const pasted = helpers.normalizePastedText(text);
      log.push(`paste:${meta.source}:${pasted}`);
      const generation = pasteGeneration;
      const answer = script.paste;
      const handled = answer.kind === 'insert' ? answer.text : answer.kind === 'drop' ? false : undefined;
      if (generation !== pasteGeneration) return;
      if (typeof handled === 'string') {
        insertAtDraft(handled);
        return;
      }
      if (handled === false) return;
      if (pasted) insertAtDraft(pasted);
    };
    const paletteAnswer = (answer) => {
      if (answer.kind === 'declined') return false;
      if (answer.kind === 'text') return answer.value;
      if (answer.kind === 'draft') return { value: answer.value, cursor: answer.cursor };
      return undefined;
    };
    const submitDraft = (next) => {
      if (submitGate) return;
      const text = next.value;
      if (!String(text || '').trim()) return;
      submitGate = true;
      log.push(`submit:${text}`);
      const accepted = script.submitAccept !== false;
      if (!accepted) {
        submitGate = false;
        commitDraft(next);
        return;
      }
      pasteGeneration += 1;
      commitDraft({ value: '', cursor: 0, selectionAnchor: null }, { skipHistory: true });
      undoStack.reset();
    };
    const paletteResultDraft = (result) => {
      if (typeof result === 'string') return { value: result, cursor: result.length, selectionAnchor: null };
      if (typeof result?.value === 'string') return { value: result.value, cursor: result.cursor, selectionAnchor: null };
      return null;
    };
    const submitEnterChunk = (prefix = '') => {
      const current = draftRef.current;
      const next = prefix ? helpers.insertText(current, prefix) : current;
      if (props.commandPaletteActive) {
        log.push(`accept:${next.value}:${next.cursor}`);
        const accepted = paletteAnswer(script.accept);
        const replacement = paletteResultDraft(accepted);
        if (replacement) commitDraft(replacement);
        else if (accepted !== false) commitDraft({ value: '', cursor: 0, selectionAnchor: null });
        else if (next !== current) commitDraft(next);
        return;
      }
      submitDraft(next);
    };

    const handler = createPromptKeyHandler({
      disabled: props.disabled,
      escapeClearAtRef,
      suppressShiftNavRef: { current: () => script.grid === true },
      draftRef,
      commitDraft,
      updateDraft,
      handleExternalPaste,
      submitEnterChunk,
      submitDraft,
      commandPaletteActive: props.commandPaletteActive,
      commandPaletteOpen: props.commandPaletteOpen ?? props.commandPaletteActive,
      commandPaletteOptionCount: props.commandPaletteOptionCount ?? (props.commandPaletteActive ? 2 : 0),
      commandPaletteMovesCaret: props.commandPaletteMovesCaret,
      onCommandPaletteNavigate: (n) => log.push(`nav:${n}`),
      onCommandPaletteAccept: (value, cursor) => {
        log.push(`accept:${value}:${cursor}`);
        return paletteAnswer(script.accept);
      },
      onCommandPaletteCancel: (value) => log.push(`cancel:${value}`),
      onCommandPaletteComplete: (value, cursor) => {
        log.push(`complete:${value}:${cursor}`);
        return paletteAnswer(script.complete);
      },
      onTab: (value) => {
        log.push(`tab:${value}`);
        return script.tab === true;
      },
      onEscape: (value, meta) => {
        log.push(`escape:${meta.phase}:${value}`);
        return script.escapeBefore === true && meta.phase === 'before' ? true : undefined;
      },
      onInterrupt: (value) => {
        log.push(`interrupt:${value}`);
        return script.interrupt ?? undefined;
      },
      interruptActive: props.interruptActive,
      hasQueuedMessages: props.hasQueuedMessages,
      hasMessages: props.hasMessages,
      moveDraftVertically,
      restoreQueuedToDraft,
      applyHistoryNavigation,
      undoStack,
    });

    const steps = [];
    // A mounted input reports its caret once (PromptInput.jsx's mount effect); the steps record what happens after it.
    reportCaret(draftRef.current.cursor);
    for (const [input, names, dt] of session.events) {
      now += dt;
      submitGate = false;
      const before = log.length;
      handler(input, keyOf(names));
      const stack = undoRef.current;
      steps.push([
        draftRef.current.value, draftRef.current.cursor, draftRef.current.selectionAnchor ?? null, log.slice(before),
        stack.past.length, stack.future.length, stack.past.length ? stack.past[stack.past.length - 1].value : null,
        escapeClearAtRef.current,
      ]);
    }
    return steps;
  } finally {
    Date.now = realNow;
  }
}

const vocabulary = [...handWritten, ...decoderPairs];
const sessionCount = 260;
const eventsPerSession = 22;
for (let n = 0; n < sessionCount; n += 1) {
  const value = pick(INITIAL_VALUES);
  const cursor = chance(0.5) ? value.length : Math.floor(rand() * (value.length + 1));
  const anchor = chance(0.25) ? Math.floor(rand() * (value.length + 1)) : null;
  const palette = chance(0.25);
  const props = {
    disabled: chance(0.03),
    commandPaletteActive: palette,
    commandPaletteOpen: chance(0.3) ? (chance(0.5) ? palette : !palette) : null,
    commandPaletteOptionCount: chance(0.3) ? pick([0, 1, 2, 5]) : null,
    commandPaletteMovesCaret: chance(0.5),
    interruptActive: chance(0.2),
    hasQueuedMessages: chance(0.25),
    hasMessages: chance(0.5),
  };
  const script = {
    submitAccept: chance(0.2) ? false : true,
    restore: chance(0.5),
    history: chance(0.5) ? pick(['older prompt', '', 'x\ny']) : null,
    paste: pick([{ kind: 'fallback' }, { kind: 'insert', text: '[Pasted text #1 +3 lines]' }, { kind: 'drop' }]),
    accept: pick([
      { kind: 'declined' }, { kind: 'accepted' }, { kind: 'text', value: '/model ' }, { kind: 'draft', value: 'fix $pdf-tools  then ship', cursor: 15 },
    ]),
    complete: pick([{ kind: 'accepted' }, { kind: 'text', value: '/help' }, { kind: 'draft', value: '$a ', cursor: 3 }]),
    tab: chance(0.3),
    escapeBefore: chance(0.15),
    interrupt: chance(0.5) ? pick(['restored prompt', '']) : null,
    grid: chance(0.1),
  };
  const events = [];
  for (let i = 0; i < eventsPerSession; i += 1) {
    const picked = chance(0.6) ? pick(handWritten) : pick(vocabulary);
    events.push([picked.input, picked.key, pick([0, 0, 50, 300, 600, 900])]);
  }
  const session = {
    draft: { value, cursor, selectionAnchor: anchor },
    width: pick([4, 8, 20, 80]),
    props,
    script,
    events,
  };
  session.steps = simulate(session);
  cases.push({ t: 'session', ...session });
}

const golden = {
  note: 'Recorded by tests/recorders/record-editor.mjs from src/tui; do not edit by hand.',
  sources,
  cases,
};
const body = `${JSON.stringify(golden)}\n`;
const stable = (text) => {
  const parsed = JSON.parse(text);
  return JSON.stringify(parsed.cases) + JSON.stringify(parsed.sources);
};

if (option('--write')) {
  writeFileSync(option('--write'), body);
  console.log(`wrote ${cases.length} cases to ${option('--write')}`);
} else {
  const recorded = readFileSync(option('--check'), 'utf8');
  if (stable(recorded) === stable(body)) {
    console.log(`ok: ${cases.length} cases match ${option('--check')}`);
  } else {
    const old = JSON.parse(recorded).cases;
    const changed = cases.filter((c, at) => JSON.stringify(c) !== JSON.stringify(old[at])).length;
    console.error(`MISMATCH: ${changed} of ${cases.length} cases differ`);
    process.exit(1);
  }
}
