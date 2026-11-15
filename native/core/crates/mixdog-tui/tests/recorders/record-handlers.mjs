// Records what the Node prompt handlers do, so the Rust port (`mixdog_tui::handlers`, `mixdog_tui::history`) is checked
// against it (tests/handlers.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui, nothing is written there. The hooks of the Node
// handlers (React) are thin wrappers over pure modules; those pure modules are what is driven here, with recording fakes for
// every ref, setter and store method they take.
//
//   node record-handlers.mjs --tree C:/Project/mixdog --write tests/goldens/handlers.json
//   node record-handlers.mjs --tree C:/Project/mixdog --check tests/goldens/handlers.json
//
// Recorded:
//  * approval   - approvalShortcutDecision over approvals x inputs x Escape;
//  * chord      - decodeSelectionMoveChord over raw CSI sequences and key flag combinations;
//  * nav        - navigatePromptHistory walks (the nav state kept as the history hook keeps it);
//  * paste      - processPastedText over a corpus of pastes (raw, folded, image paths, mixed), pasteFromClipboard scenarios;
//  * draft      - applyPromptDraftChange over previous drafts x new values x flags (the setters' results and effects);
//  * restore    - runRestoreQueuedToPrompt scenarios (synchronous and asynchronous answers, rejections, typing meanwhile);
//  * history    - scanPromptHistory over a transcript corpus, writeRetryDelayMs, and the file the store writes for a sequence of
//                 appends (compared with the Rust append rule and the JSON layout).
//
// Where a tree has no node_modules, the packages the handlers never reach in these paths (react, string-width, strip-ansi,
// marked, chalk, wrap-ansi) are replaced by inert stand-ins.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { setImmediate as flush, setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-handlers.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

const STUBS = {
  react:
    'export const useState=()=>[],useEffect=()=>{},useRef=()=>({}),useCallback=f=>f,useMemo=f=>f(),useLayoutEffect=()=>{},useContext=()=>({}),createContext=()=>({}),createElement=()=>null,memo=f=>f,forwardRef=f=>f,Fragment=null;export default {};',
  'string-width': 'export default s=>[...String(s)].length;',
  'strip-ansi': 'export default s=>String(s);',
  marked: 'export const marked={lexer:()=>[],setOptions(){},use(){}};',
  chalk:
    'const p=()=>new Proxy(function(s){return String(s)},{get:(t,k)=>k==="level"?0:p(),apply:(t,th,a)=>String(a[0])});export class Chalk{constructor(){return p()}};export default p();',
  'wrap-ansi': 'export default s=>String(s);',
};
const hooks = `
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && STUBS[spec]) return { url: 'stub:' + spec, shortCircuit: true };
    throw e;
  }
}
export async function load(url, ctx, next) {
  if (url.startsWith('stub:')) return { format: 'module', source: STUBS[url.slice(5)], shortCircuit: true };
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

// The prompt-history store writes under MIXDOG_DATA_DIR: a folder inside this test directory, removed at the end.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', `.record-handlers-${process.pid}`);
mkdirSync(dataDir, { recursive: true });
process.env.MIXDOG_DATA_DIR = dataDir;

const sources = [];
const load = async (path) => {
  const file = join(tree, 'src/tui', path);
  sources.push({ path: `src/tui/${path}`, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  return import(pathToFileURL(file).href);
};

const out = {};
try {
  const approvalMod = await load('app/use-global-key-input/approval-shortcut.mjs');
  const chordMod = await load('app/use-global-key-input/shift-arrow.mjs');
  const navMod = await load('app/prompt-handlers/history-navigation.mjs');
  const pasteMod = await load('app/prompt-handlers/paste-pipeline.mjs');
  const attachMod = await load('paste-attachments.mjs');
  const draftMod = await load('app/use-prompt-draft-flow/draft-change.mjs');
  const restoreMod = await load('app/use-prompt-queue-history/restore-to-prompt.mjs');
  const scanMod = await load('app/use-prompt-queue-history/prompt-history.mjs');
  const storeMod = await load('prompt-history-store.mjs');

  // ------------------------------------------------------------ approval
  out.approval = [];
  const approvals = [null, { id: 'a', kind: 'tool' }, { id: 'q', kind: 'question' }, { id: 'p' }];
  const inputs = ['y', 'Y', ' a ', 'A', 'n', 'N', 'd', 'D', 'x', '', 'yes', '\t n'];
  for (const approval of approvals) {
    for (const input of inputs) {
      for (const escape of [false, true]) {
        out.approval.push({
          approval,
          input,
          escape,
          decision: approvalMod.approvalShortcutDecision(approval, input, { escape }) ?? null,
        });
      }
    }
  }

  // ------------------------------------------------------------ chord
  out.chord = [];
  const rawInputs = [
    '\x1b[1;2A', '\x1b[a', '[1;2A', '\x1b[1;6A', '[1;6A',
    '\x1b[1;2B', '\x1b[b', '[1;2B', '\x1b[1;6B', '[1;6B',
    '\x1b[1;2C', '\x1b[c', '[1;2C', '\x1b[1;6C', '[1;6C',
    '\x1b[1;2D', '\x1b[d', '[1;2D', '\x1b[1;6D', '[1;6D',
    'x', '',
  ];
  const flagNames = ['leftArrow', 'rightArrow', 'upArrow', 'downArrow', 'home', 'end', 'shift'];
  const flagSets = [[]];
  for (let i = 0; i < flagNames.length; i += 1) {
    flagSets.push([flagNames[i]]);
    for (let j = i + 1; j < flagNames.length; j += 1) flagSets.push([flagNames[i], flagNames[j]]);
  }
  for (const input of rawInputs) {
    for (const set of flagSets) {
      const key = Object.fromEntries(set.map((name) => [name, true]));
      out.chord.push({ input, flags: set, out: chordMod.decodeSelectionMoveChord(input, key) });
    }
  }

  // ------------------------------------------------------------ nav
  const walkHistories = [['third', 'second', 'first'], ['a', 'a', 'b'], [], ['x'], ['one', ' one ', 'two']];
  const walkScripts = [
    [['up', 'draft'], ['up', '@last'], ['up', '@last'], ['up', '@last'], ['down', '@last'], ['down', '@last'], ['down', '@last'], ['down', '@last']],
    [['down', 'draft'], ['up', 'third'], ['down', 'anything', true], ['up', ''], ['up', '@last']],
    [['up', 'x'], ['up', '@last'], ['up', 'edited'], ['down', '@last']],
    [['up', 'one'], ['up', '@last'], ['down', '@last'], ['down', '@last']],
    [['up', 'a'], ['up', '@last'], ['up', '@last'], ['down', '@last'], ['down', 'b']],
  ];
  out.nav = [];
  for (const history of walkHistories) {
    for (const script of walkScripts) {
      let nav = { active: false, index: -1, seed: '', lastValue: '' };
      let last = '';
      const steps = [];
      for (const [direction, text, emptyDraft] of script) {
        const currentText = text === '@last' ? last : text;
        const outcome = navMod.navigatePromptHistory({
          direction,
          currentText,
          meta: { emptyDraft: emptyDraft === true },
          nav,
          history,
        });
        if (outcome.reset) nav = { active: false, index: -1, seed: '', lastValue: '' };
        if (outcome.nav) nav = outcome.nav;
        if (outcome.value !== undefined) last = outcome.value;
        steps.push({
          direction,
          text: currentText,
          emptyDraft: emptyDraft === true,
          value: outcome.value ?? null,
          reset: outcome.reset === true,
          draftChanged: outcome.draftChanged === true,
          nav,
        });
      }
      out.nav.push({ history, steps });
    }
  }

  // ------------------------------------------------------------ paste
  const big = 'x'.repeat(1001);
  const pasteCorpus = [
    'short',
    '',
    'line\nline',
    'x'.repeat(1000),
    big,
    'a\r\nb',
    'before\n/tmp/p/a.png\nafter',
    '/tmp/p/a.png /tmp/p/b.png',
    '/tmp/p/missing.png',
    '/tmp/p/boom.png',
    `${big}\n/tmp/p/a.png\n${big}`,
    `${'a'.repeat(600)}\n${'b'.repeat(600)}\n/tmp/p/a.png`,
    'file:///tmp/p/c.png tail',
    '/tmp/p/a.png',
    'text /tmp/p/a.PNG more',
    'not an image /tmp/p/a.txt',
  ];
  const pasteEnv = () => {
    const env = { texts: 0, images: 0, hints: [] };
    env.registerPastedText = (text) => attachMod.formatPastedTextRef((env.texts += 1), text);
    env.registerPastedImage = (image) => (image && image.content ? attachMod.formatImageRef((env.images += 1)) : '');
    env.showPromptHint = (text, tone) => env.hints.push([text, tone]);
    env.attachImagePath = async (pathText) => {
      if (/missing/.test(pathText)) return pathText;
      if (/boom/.test(pathText)) {
        env.showPromptHint('image attach failed: boom', 'warn');
        return pathText;
      }
      const name = pathText.split('/').pop();
      env.showPromptHint(`attached ${name}`, 'plain');
      return attachMod.formatImageRef((env.images += 1));
    };
    return env;
  };
  const shape = (value) => (value === undefined ? { kind: 'raw' } : value === false ? { kind: 'nothing' } : { kind: 'insert', value });
  out.paste = [];
  for (const text of pasteCorpus) {
    for (const returnRaw of [false, true]) {
      const env = pasteEnv();
      const result = await pasteMod.processPastedText(text, {
        returnRaw,
        registerPastedText: env.registerPastedText,
        attachImagePath: env.attachImagePath,
      });
      out.paste.push({ text, returnRaw, result: shape(result), hints: env.hints, texts: env.texts, images: env.images });
    }
  }
  const clipboardScenarios = [
    { name: 'text', text: 'hello' },
    { name: 'crlf text', text: 'a\r\nb\rc' },
    { name: 'big text', text: big },
    { name: 'image path text', text: '/tmp/p/a.png' },
    { name: 'image', text: '', image: { type: 'image', content: 'AA', filename: 'p.png' } },
    { name: 'image without name', text: '', image: { type: 'image', content: 'AA' } },
    { name: 'nothing', text: '', image: null },
    { name: 'text fails', textError: 'nope' },
    { name: 'image fails', text: '', imageError: 'denied' },
  ];
  out.clipboard = [];
  for (const scenario of clipboardScenarios) {
    const env = pasteEnv();
    const result = await pasteMod.pasteFromClipboard({
      readText: async () => {
        if (scenario.textError) throw new Error(scenario.textError);
        return scenario.text;
      },
      readImage: async () => {
        if (scenario.imageError) throw new Error(scenario.imageError);
        return scenario.image ?? null;
      },
      processText: (raw, returnRaw) =>
        pasteMod.processPastedText(raw, {
          returnRaw,
          registerPastedText: env.registerPastedText,
          attachImagePath: env.attachImagePath,
        }),
      registerPastedImage: env.registerPastedImage,
      showPromptHint: env.showPromptHint,
    });
    out.clipboard.push({ scenario, result: shape(result), hints: env.hints, texts: env.texts, images: env.images });
  }

  // ------------------------------------------------------------ draft change
  const nonActive = { active: false, index: -1, seed: '', lastValue: '' };
  const walking = { active: true, index: 1, seed: 'S', lastValue: 'L' };
  const previousDrafts = ['', 'hello', '/mod', '/model ', '/compact  '];
  const newValues = ['', 'a', '/', '/mod', '/model ', '/usage ', 'hello world', '/compact\t', '/btw ', 'L', 'S'];
  out.draft = [];
  for (const previous of previousDrafts) {
    for (const value of newValues) {
      for (const historyFlag of [false, true]) {
        for (const hintLive of [false, true]) {
          for (const nav of [nonActive, walking]) {
            for (const dismissedFor of ['', '/mod']) {
              const events = [];
              const state = {
                draft: previous,
                override: 'x',
                dismissed: dismissedFor,
                flag: historyFlag,
                nav: { ...nav },
                hintActive: hintLive,
              };
              const deps = {
                dismissWelcomePromptHint: () => events.push(['welcome']),
                syncPromptLayoutRows: (text) => events.push(['layout', text]),
                promptHistoryDraftChangeRef: {
                  get current() {
                    return state.flag;
                  },
                  set current(next) {
                    state.flag = next;
                  },
                },
                promptHistoryNavRef: {
                  get current() {
                    return state.nav;
                  },
                },
                resetPromptHistoryNav: () => {
                  events.push(['navReset']);
                  state.nav = { ...nonActive };
                },
                setPromptDraft: (updater) => {
                  state.draft = updater(state.draft);
                },
                setPromptDraftOverride: (updater) => {
                  state.override = updater(state.override);
                },
                showPromptHint: (text, tone) => {
                  events.push(['hint', text, tone]);
                  state.hintActive = true;
                },
                clearPromptHint: () => {
                  events.push(['hintClear']);
                  state.hintActive = false;
                },
                promptHintActiveRef: {
                  get current() {
                    return state.hintActive;
                  },
                },
                promptHintTimerRef: { current: null },
                slashDismissedFor: dismissedFor,
                setSlashDismissedFor: (updater) => {
                  state.dismissed = typeof updater === 'function' ? updater(state.dismissed) : updater;
                },
              };
              draftMod.applyPromptDraftChange(value, deps);
              out.draft.push({
                previous,
                value,
                historyFlag,
                hintLive,
                nav,
                dismissedFor,
                events,
                draft: state.draft,
                override: state.override,
                dismissed: state.dismissed,
                flag: state.flag,
                navAfter: state.nav,
              });
            }
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ restore
  const entry = (id, text) => ({ id, text });
  const restoreScenarios = [
    { name: 'sync one', queued: [entry('1', 'q1')], answer: { kind: 'sync', value: { count: 1, text: 'q1' } } },
    { name: 'sync two authoritative differs', queued: [entry('1', 'q1'), entry('2', 'q2')], answer: { kind: 'sync', value: { count: 2, text: 'Q1\nQ2' } } },
    { name: 'sync none', queued: [entry('1', 'q1')], answer: { kind: 'sync', value: { count: 0, text: '' } } },
    { name: 'sync undefined', queued: [entry('1', 'q1')], answer: { kind: 'sync', value: undefined } },
    { name: 'sync throws', queued: [entry('1', 'q1')], answer: { kind: 'throw' } },
    { name: 'async resolves', queued: [entry('1', 'q1')], answer: { kind: 'async', value: { count: 1, text: 'q1' } } },
    { name: 'async resolves differently', queued: [entry('1', 'q1')], answer: { kind: 'async', value: { count: 1, text: 'authoritative' } } },
    { name: 'async resolves none', queued: [entry('1', 'q1')], answer: { kind: 'async', value: { count: 0 } } },
    { name: 'async rejects', queued: [entry('1', 'q1')], answer: { kind: 'reject' } },
    { name: 'async typed meanwhile', queued: [entry('1', 'q1')], answer: { kind: 'async', value: { count: 1, text: 'authoritative' } }, typeMeanwhile: '!' },
    { name: 'nothing queued', queued: [], answer: { kind: 'sync', value: { count: 1, text: 'x' } } },
    { name: 'blank queued text', queued: [entry('1', '  ')], answer: { kind: 'sync', value: { count: 1, text: '  ' } } },
    {
      name: 'attachments and notice',
      queued: [entry('1', 'q1')],
      answer: { kind: 'sync', value: { count: 1, text: 'q1', pastedImages: { 1: { id: 1 } }, pastedTexts: { 2: 't' }, notice: 'warned' } },
    },
    { name: 'second call while in flight', queued: [entry('1', 'q1')], answer: { kind: 'async', value: { count: 1, text: 'q1' } }, second: true },
  ];
  const optionSets = [
    { restoreDraft: true, showHint: true, currentText: '' },
    { restoreDraft: true, showHint: true, currentText: 'typed' },
    { restoreDraft: true, showHint: false, currentText: 'typed' },
    { restoreDraft: false, showHint: true, currentText: 'typed' },
    { restoreDraft: false, showHint: false, currentText: '' },
    { restoreDraft: true, showHint: true, currentText: 'typed here', live: { value: 'typed here', cursor: 3, selectionAnchor: 1 } },
  ];
  out.restore = [];
  for (const scenario of restoreScenarios) {
    for (const optionSet of optionSets) {
      const events = [];
      const state = { value: optionSet.currentText, override: null, images: [], texts: [] };
      let live = optionSet.live ? { ...optionSet.live } : null;
      let resolveAnswer;
      let rejectAnswer;
      const store = {
        restoreQueued: () => {
          const answer = scenario.answer;
          if (answer.kind === 'throw') throw new Error('boom');
          if (answer.kind === 'sync') return answer.value;
          return new Promise((resolve, reject) => {
            resolveAnswer = () => resolve(answer.value);
            rejectAnswer = () => reject(new Error('late'));
          });
        },
      };
      const inFlightRef = { current: false };
      const deps = {
        store,
        queued: scenario.queued,
        promptDraft: optionSet.currentText,
        promptValueRef: {
          get current() {
            return state.value;
          },
          set current(next) {
            state.value = next;
          },
        },
        inFlightRef,
        showPromptHint: (text, tone) => events.push(['hint', text, tone]),
        clearPromptHint: () => events.push(['hintClear']),
        installPastedImages: (images) => state.images.push(...Object.keys(images)),
        installPastedTexts: (texts) => state.texts.push(...Object.keys(texts)),
        syncPromptLayoutRows: (text) => events.push(['layout', text]),
        setPromptDraftOverride: (next) => {
          const { id, ...rest } = next;
          state.override = {
            value: rest.value,
            cursor: rest.cursor ?? null,
            selectionAnchor: rest.selectionAnchor ?? null,
          };
          if (live) live = { value: rest.value, cursor: rest.cursor, selectionAnchor: rest.selectionAnchor };
          events.push(['override', state.override]);
        },
      };
      const options = {
        restoreDraft: optionSet.restoreDraft,
        showHint: optionSet.showHint,
        currentText: optionSet.currentText,
        ...(optionSet.live ? { getCurrentDraft: () => live } : {}),
      };
      const returned = restoreMod.runRestoreQueuedToPrompt(options, deps);
      let second = null;
      if (scenario.second) second = restoreMod.runRestoreQueuedToPrompt(options, deps);
      await flush();
      const syncEvents = events.length;
      if (scenario.typeMeanwhile) {
        state.value += scenario.typeMeanwhile;
        if (live) live = { value: state.value, cursor: state.value.length, selectionAnchor: null };
      }
      if (resolveAnswer) {
        if (scenario.answer.kind === 'reject') rejectAnswer();
        else resolveAnswer();
        await flush();
        await flush();
      }
      out.restore.push({
        scenario: scenario.name,
        options: optionSet,
        queued: scenario.queued,
        answer: scenario.answer,
        typeMeanwhile: scenario.typeMeanwhile ?? null,
        second: scenario.second === true,
        returned,
        secondReturned: second,
        syncEvents,
        events,
        value: state.value,
        override: state.override,
        images: state.images,
        texts: state.texts,
        inFlight: inFlightRef.current,
      });
    }
  }

  // ------------------------------------------------------------ history
  const user = (text) => ({ kind: 'user', text });
  const transcripts = [
    [user(' one '), { kind: 'assistant', text: 'reply' }, user('two   words'), user('one'), user('  '), { kind: 'user' }, user('two words')],
    Array.from({ length: 80 }, (_, n) => user(`p${n}`)),
    [],
    [{ kind: 'assistant', text: 'x' }],
  ];
  out.scan = transcripts.map((items) => ({ items, history: scanMod.scanPromptHistory(items) }));
  out.retryDelays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20].map((failures) => storeMod.writeRetryDelayMs(failures));

  // One append at a time, each given time to land: the store flushes a burst through overlapping asynchronous writes that
  // re-read the file, which is a race of the Node store that has no defined result to compare.
  const cwd = join(dataDir, 'proj');
  const appends = ['one', 'two', 'one ', ' three  words ', 'three words', '', '  ', '\n', 'four', 'two'];
  const returned = [];
  for (const text of appends) {
    returned.push(storeMod.appendPromptHistory(cwd, text));
    await sleep(320);
  }
  await sleep(600);
  const historyDir = join(dataDir, 'tui-prompt-history');
  const files = readdirSync(historyDir).filter((name) => name.endsWith('.json'));
  if (files.length !== 1) throw new Error(`expected one history file, found ${files.length}`);
  const fileText = readFileSync(join(historyDir, files[0]), 'utf8');
  // The cap of 50 entries, in the list the store answers (no file is compared for the burst).
  const burst = Array.from({ length: 60 }, (_, n) => `entry ${n}`);
  const burstReturned = burst.map((text) => storeMod.appendPromptHistory(join(dataDir, 'burst'), text));
  out.store = { appends, returned, fileText, burst, burstLast: burstReturned.at(-1) };
  await sleep(800);
  process.emit('exit', 0);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

out.sources = sources;

const text = `{\n${Object.entries(out)
  .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  .join(',\n')}\n}\n`;
const target = option('--write') ?? option('--check');
const counts = `${out.approval.length} approval, ${out.chord.length} chord, ${out.draft.length} draft, ${out.restore.length} restore cases`;
if (option('--write')) {
  writeFileSync(target, text);
  console.log(`wrote ${target} (${text.length} bytes, ${counts})`);
} else {
  const recorded = readFileSync(target, 'utf8');
  if (recorded.replace(/\r\n/g, '\n') !== text) {
    console.error(`${target} differs from what the Node code does now: re-record it with --write`);
    process.exit(1);
  }
  console.log(`${target} matches (${counts})`);
}
