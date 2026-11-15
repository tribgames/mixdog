// Records what the Node REPL prints, so the Rust REPL (`mixdog_repl`) is checked against it (tests/repl_twin.rs).
//
// The Node code is only read: the modules are imported from <tree>/src, nothing is written there.
//
//   node record-repl.mjs --tree C:/Project/mixdog --write tests/goldens/repl.json
//   node record-repl.mjs --tree C:/Project/mixdog --check tests/goldens/repl.json
//
// Recorded, once with colour on (FORCE_COLOR) and once with it off (NO_COLOR), as the colour decision of the REPL is made
// from the environment when the modules load, so each mode is a child process of this one:
//  * sink  - repl/stream-sink.mjs and repl/turn-output.mjs over scripted streams: text deltas, tool cards, tail resets,
//            flushes and the final render (the real ui/markdown.mjs), at several terminal widths. Everything written to the
//            output is recorded as one string, with what each reset returned. The raw stream is left and the line only
//            terminated when stdout is not a terminal or NO_COLOR is set, and a mixed text and tool-card turn keeps its stream;
//            both cases are in the corpus.
//  * slash - repl/slash-commands.mjs over scripted runtimes: /help, unknown commands, /compact in every outcome, /model in
//            every switch case, /outputstyle, /mode, /clear and /quit. The recording keeps the output, the return value, the
//            error and the runtime calls (the calls of the validation pass of /model, which only the in-process runtime
//            could make, are left out).
//
// The scripted runtimes are data (the `runtime` of a case), so the Rust test builds the same session from the same data.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
const mode = option('--mode');
if (!tree || (!mode && !option('--write') && !option('--check'))) {
  console.error('usage: record-repl.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

const SOURCES = [
  'src/repl/stream-sink.mjs',
  'src/repl/turn-output.mjs',
  'src/repl/slash-commands.mjs',
  'src/ui/stream-finalize.mjs',
  'src/ui/markdown.mjs',
  'src/session-runtime/model-route/model-switch-target.mjs',
];

// ---------------------------------------------------------------- the corpus

const SINK_CASES = [
  { name: 'plain text turn', columns: 80, finalText: 'Hello, world\nmore', ops: [['delta', 'Hello, '], ['delta', 'world\n'], ['delta', 'more'], ['flush']] },
  { name: 'heading changes the row count', columns: 80, finalText: '# Title', ops: [['delta', '# Title'], ['flush']] },
  { name: 'bold patched in place', columns: 80, finalText: 'some **bold** text', ops: [['delta', 'some **bold** '], ['delta', 'text'], ['flush']] },
  { name: 'several rows patched', columns: 80, finalText: 'a **b**\nplain\n`c` d', ops: [['delta', 'a **b**\nplain\n`c` d'], ['flush']] },
  { name: 'row as wide as the terminal is redrawn', columns: 10, finalText: '0123456789abcdef', ops: [['delta', '0123456789abcdef'], ['flush']] },
  { name: 'wrapped rows are redrawn', columns: 8, finalText: 'one **two** three four\nfive', ops: [['delta', 'one **two** three four\nfive'], ['flush']] },
  { name: 'text then cards then text', columns: 80, finalText: 'after', ops: [['delta', 'thinking'], ['card', '  > read a.rs'], ['card', '  > grep x'], ['delta', 'after'], ['flush']] },
  { name: 'card at a line start', columns: 80, finalText: 'x', ops: [['delta', 'line\n'], ['card', '[c]'], ['delta', 'x'], ['flush']] },
  { name: 'tail reset redraws the rest', columns: 80, finalText: 'abc xyz', ops: [['delta', 'abc def'], ['reset', 3], ['delta', 'xyz'], ['flush']] },
  { name: 'tail reset across lines', columns: 6, finalText: 'abcdefgh\nij', ops: [['delta', 'abcdefgh\nijklm'], ['reset', 3], ['flush']] },
  { name: 'tail reset refused after a card', columns: 80, finalText: 'ab', ops: [['delta', 'ab'], ['card', '[c]'], ['reset', 1], ['flush']] },
  { name: 'tail reset of nothing', columns: 80, finalText: 'ab', ops: [['delta', 'ab'], ['reset', 0], ['reset', 99], ['flush']] },
  { name: 'nothing streamed is rendered once', columns: 80, finalText: 'plain **bold** and `code`', ops: [] },
  { name: 'an empty final text prints nothing', columns: 80, finalText: '', ops: [['delta', 'x'], ['flush']] },
  { name: 'unterminated stream ends its line', columns: 80, finalText: 'no newline', ops: [['delta', 'no newline'], ['flush']] },
  { name: 'table and list', columns: 80, finalText: '| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n- y', ops: [['delta', '| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n- y'], ['flush']] },
  { name: 'wide characters', columns: 20, finalText: '\u{d55c}\u{ae00} **\u{d14d}\u{c2a4}\u{d2b8}**', ops: [['delta', '\u{d55c}\u{ae00} **\u{d14d}\u{c2a4}\u{d2b8}**'], ['flush']] },
];

const BASE_RUNTIME = {
  provider: 'google',
  model: 'gemini-3.8-flash',
  sessionProvider: 'google',
  sessionModel: 'gemini-3.8-flash',
  toolMode: 'full',
  presets: [{ id: 'flash', provider: 'google', model: 'gemini-3.8-flash' }],
  onModelChange: true,
  compact: { changed: true },
  outputStyle: { current: { label: 'Concise' }, styles: [{ label: 'Concise' }, { id: 'verbose' }] },
  setOutputStyle: { current: { id: 'verbose' } },
};
const runtimeOf = (overrides) => ({ ...BASE_RUNTIME, ...overrides });

const SLASH_CASES = [
  { name: 'help', line: '/help', runtime: runtimeOf({}) },
  { name: 'unknown command', line: '/nope arg', runtime: runtimeOf({}) },
  { name: 'unknown command is lowered', line: '/NOPE', runtime: runtimeOf({}) },
  { name: 'a lone slash', line: '/', runtime: runtimeOf({}) },
  { name: 'a slash and a space', line: '/ help', runtime: runtimeOf({}) },
  { name: 'compact reports the runtime reason', line: '/compact', runtime: runtimeOf({ compact: { changed: false, reason: 'context is already small' } }) },
  { name: 'compact default reason', line: '/compact', runtime: runtimeOf({ compact: { changed: false } }) },
  { name: 'compact error', line: '/compact', runtime: runtimeOf({ compact: { error: 'boom' } }) },
  { name: 'compact nothing', line: '/compact', runtime: runtimeOf({ compact: null }) },
  { name: 'compact done', line: '/compact', runtime: runtimeOf({ compact: { changed: true, beforeMessages: 5, afterMessages: 2, beforeTokens: 100, afterTokens: 40 } }) },
  { name: 'compact done without numbers', line: '/compact', runtime: runtimeOf({ compact: { changed: true } }) },
  { name: 'model shows the route', line: '/model', runtime: runtimeOf({}) },
  { name: 'model shows the configured route', line: '/model', runtime: runtimeOf({ provider: undefined, model: undefined }) },
  { name: 'model switches with a compaction first', line: '/model gemini-3.5-flash', runtime: runtimeOf({}) },
  { name: 'model switch with the pre-compaction off', line: '/model gemini-3.5-flash', runtime: runtimeOf({ onModelChange: false }) },
  { name: 'model to the same model', line: '/model gemini-3.8-flash', runtime: runtimeOf({}) },
  { name: 'model to a preset of the same model', line: '/model flash', runtime: runtimeOf({}) },
  { name: 'model preset is matched by name and case', line: '/model  FLASH ', runtime: runtimeOf({ presets: [{ name: 'Flash', provider: 'google', model: 'gemini-3.8-flash' }] }) },
  { name: 'model on an empty chat', line: '/model gemini-3.5-flash', runtime: runtimeOf({ sessionProvider: null, sessionModel: null }) },
  { name: 'model switch when the pre-compaction fails', line: '/model gemini-3.5-flash', runtime: runtimeOf({ compact: { throws: 'boom' } }) },
  { name: 'outputstyle shows', line: '/outputstyle', runtime: runtimeOf({}) },
  { name: 'style shows the status', line: '/style Status', runtime: runtimeOf({}) },
  { name: 'output-style falls back to the list', line: '/output-style show', runtime: runtimeOf({ outputStyle: null, listOutputStyles: { configured: 'plain', styles: [{ id: 'plain' }] } }) },
  { name: 'outputstyle with nothing known', line: '/outputstyle', runtime: runtimeOf({ outputStyle: null }) },
  { name: 'outputstyle switches', line: '/outputstyle verbose', runtime: runtimeOf({}) },
  { name: 'outputstyle switches later', line: '/style verbose', runtime: runtimeOf({ setOutputStyle: { current: { label: 'Verbose' }, appliedToCurrentSession: false } }) },
  { name: 'mode shows', line: '/mode', runtime: runtimeOf({ toolMode: 'readonly' }) },
  { name: 'mode switches', line: '/mode readonly', runtime: runtimeOf({}) },
  { name: 'clear', line: '/clear', runtime: runtimeOf({}) },
  { name: 'quit', line: '/quit', runtime: runtimeOf({}) },
  { name: 'exit is an alias', line: '/EXIT', runtime: runtimeOf({}) },
];

// ---------------------------------------------------------------- one mode

async function recordMode(color) {
  if (color) {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
  } else {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
  }
  const load = (path) => import(pathToFileURL(join(tree, path)).href);
  const { createStreamSink } = await load('src/repl/stream-sink.mjs');
  const { finalizeTurnOutput } = await load('src/repl/turn-output.mjs');
  const { handleSlash } = await load('src/repl/slash-commands.mjs');
  const { renderMarkdown } = await load('src/ui/markdown.mjs');

  const sink = [];
  for (const { name, columns, finalText, ops } of SINK_CASES) {
    const chunks = [];
    const out = { columns, write: (chunk) => chunks.push(chunk) };
    // The batch timer never fires: the script flushes where it means to.
    const stream = createStreamSink({ out, batchMs: 3600000 });
    const returns = [];
    for (const [op, value] of ops) {
      if (op === 'delta') stream.pushDelta(value);
      else if (op === 'card') await stream.writeToolCard(() => value);
      else if (op === 'reset') returns.push(stream.resetTail({ chars: value }));
      else if (op === 'flush') stream.flush();
    }
    stream.flush();
    await finalizeTurnOutput({ out, sink: stream, finalText, renderMarkdown: async (text) => renderMarkdown(text) });
    sink.push({ name, columns, ops, finalText, returns, out: chunks.join('') });
  }

  const slash = [];
  for (const { name, line, runtime: data } of SLASH_CASES) {
    const calls = [];
    const log = (call, first) => calls.push([call, first === undefined ? null : first]);
    const runtime = {
      provider: data.provider,
      model: data.model,
      sessionProvider: data.sessionProvider,
      sessionModel: data.sessionModel,
      toolMode: data.toolMode,
      listPresets: () => {
        log('listPresets');
        return data.presets;
      },
      getCompactionSettings: () => {
        log('getCompactionSettings');
        return { onModelChange: data.onModelChange };
      },
      compact: async () => {
        log('compact');
        if (data.compact && data.compact.throws) throw new Error(data.compact.throws);
        return data.compact;
      },
      clear: async () => log('clear'),
      setRoute: async (next, options) => {
        if (options?.validateOnly) return;
        log('setRoute', next);
        runtime.model = next.model;
      },
      getOutputStyle: () => {
        log('getOutputStyle');
        return data.outputStyle;
      },
      listOutputStyles: () => {
        log('listOutputStyles');
        return data.listOutputStyles;
      },
      setOutputStyle: async (value) => {
        log('setOutputStyle', value);
        return data.setOutputStyle;
      },
      setToolMode: async (value) => {
        log('setToolMode', value);
        runtime.toolMode = value;
      },
    };
    const chunks = [];
    const ctx = {
      out: { write: (text) => chunks.push(text) },
      ensureRuntime: async () => runtime,
      getRuntime: () => runtime,
      closeRuntime: async (reason) => log('close', reason),
      renderStatusline: async (opts) => `footer ${opts.provider}/${opts.model} ${opts.cwd}`,
      stats: {},
      cwd: '/w',
      providerName: 'cfg',
      model: undefined,
      toolMode: 'full',
    };
    let ret = null;
    let error = null;
    try {
      ret = (await handleSlash(line, ctx)) ?? null;
    } catch (caught) {
      error = String(caught?.message ?? caught);
    }
    slash.push({ name, line, runtime: data, ret, error, calls, out: chunks.join('') });
  }
  return { sink, slash };
}

// ---------------------------------------------------------------- the recording

if (mode) {
  process.stdout.write(JSON.stringify(await recordMode(mode === 'color')));
  process.exit(0);
}

const script = fileURLToPath(import.meta.url);
const child = (which) =>
  JSON.parse(
    execFileSync(process.execPath, [script, '--tree', tree, '--mode', which], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })
  );
const recording = {
  sources: SOURCES.map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(join(tree, path))).digest('hex') })),
  modes: { color: child('color'), plain: child('plain') },
};
const text = `${JSON.stringify(recording, null, 1)}\n`;
if (option('--write')) {
  writeFileSync(option('--write'), text);
  console.log(`wrote ${option('--write')}`);
} else {
  const golden = readFileSync(option('--check'), 'utf8');
  if (golden !== text) {
    console.error('the recording differs from the golden: the Node code changed or the recorder did');
    process.exit(1);
  }
  console.log('golden matches');
}
