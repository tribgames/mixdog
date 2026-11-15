// Records what the Node terminal UI draws, so the Rust widgets (`mixdog-tui-widgets`) are held to it cell by cell. This is
// the generic recorder of every widget task: a case names a component of <tree>/src/tui/components, its props, the
// columns and the theme; the recorder renders it with Ink (a fake terminal, FORCE_COLOR=3) and keeps the last frame.
// A case may also send keys (each key's frame is kept, with the calls the component's handlers received) and may name
// colour levels 1 and 2 (the same frames in a child run, so the colour downgrade is held to chalk's). A "fn" case calls a
// pure function of a module and keeps its result as data.
//
// The Node code is only read: it is bundled with esbuild into a temporary folder beside this script (bare imports resolve
// from the repository's node_modules) and the folder is removed afterwards.
//
//   node record-ink-frames.mjs --tree C:/Project/mixdog --cases <cases.json> --write <golden.json>
//   node record-ink-frames.mjs --tree C:/Project/mixdog --cases <cases.json> --check <golden.json>
//
// Case files hold:
//   { "id", "kind": "frame", "component", "props", "columns", "rows"?, "theme"?, "children"?, "keys"?, "spies"?, "levels"? }
//   { "id", "kind": "fn", "module", "name", "args" }
// A JSON string "__Infinity__", "__NaN__" or "__undefined__" in props or args is that value. "children" is an array of lines: they become a <Text> child of
// the component. "spies" are the handler props (dotted paths such as "confirmBar.onConfirm") replaced by recorders.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
const casesPath = option('--cases');
const framesOnlyLevel = option('--level');
if (!tree || !casesPath || (!framesOnlyLevel && !option('--write') && !option('--check'))) {
  console.error('usage: record-ink-frames.mjs --tree <mixdog checkout> --cases <cases.json> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

// chalk reads these when it is imported.
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = framesOnlyLevel ?? '3';
process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '1';
if (framesOnlyLevel) process.env.TERM = 'dumb';

const components = resolve(tree, 'src/tui/components');
const MODULES = {
  Picker: './Picker.jsx',
  ConfirmBar: './ConfirmBar.jsx',
  SlashCommandPalette: './SlashCommandPalette.jsx',
  QuestionPanel: './QuestionPanel.jsx',
  SignInUrl: './SignInUrl.jsx',
  TextEntryPanel: './TextEntryPanel.jsx',
  ItemRightHintOverprint: './ItemRightHintOverprint.jsx',
  AssistantMessage: './Message.jsx',
  UserMessage: './Message.jsx',
  NoticeMessage: './Message.jsx',
  Item: './TranscriptItem.jsx',
  ToolHookDenialCard: './TranscriptItem.jsx',
  TurnDone: './TurnDone.jsx',
  StatusDone: './TurnDone.jsx',
  QueuedCommands: './QueuedCommands.jsx',
  Markdown: './Markdown.jsx',
  StreamingMarkdown: './Markdown.jsx',
  MarkdownTable: './MarkdownTable.jsx',
  AnsiText: './AnsiText.jsx',
  userMessageSkills: './user-message-skills.mjs',
  transcriptToolFailures: '../transcript-tool-failures.mjs',
  pickerLayout: './picker/picker-layout.mjs',
  questionModel: './question-panel-model.mjs',
  signInUrlLayout: './sign-in-url-layout.mjs',
  panelCellText: './panel-cell-text.mjs',
  textEntryLayout: './text-entry-layout.mjs',
  textLayout: '../app/text-layout.mjs',
  inputEditing: '../input-editing.mjs',
  confirmBar: './ConfirmBar.jsx',
  appFormat: '../app/app-format.mjs',
};

const { build } = await import('esbuild');
const directory = mkdtempSync(join(here, '.tmp-record-ink-'));
const outfile = join(directory, 'bundle.mjs');
let modules;
try {
  const entry = [
    ...Object.entries(MODULES).map(([name, path]) => `export * as ${name} from ${JSON.stringify(path)};`),
    `export { render, Box, Text } from 'ink';`,
    `export { default as React } from 'react';`,
    `export { setThemeSetting } from ${JSON.stringify(resolve(tree, 'src/tui/theme.mjs').replaceAll('\\', '/'))};`,
  ].join('\n');
  await build({
    stdin: { contents: entry, resolveDir: components, loader: 'jsx' },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'error',
  });
  modules = await import(pathToFileURL(outfile).href);
} finally {
  // The bundle is loaded; its folder is not needed any more.
  rmSync(directory, { recursive: true, force: true });
}
const { React, render, Box, Text, setThemeSetting } = modules;

const revive = (value) => {
  if (value === '__Infinity__') return Infinity;
  if (value === '__NaN__') return Number.NaN;
  if (value === '__undefined__') return undefined;
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  return value;
};
const plain = (value) => {
  try {
    const text = JSON.stringify(value, (_key, item) => (item === Infinity ? '__Infinity__' : item === undefined ? null : item));
    return text === undefined ? null : JSON.parse(text);
  } catch {
    return String(value);
  }
};

const settle = (ms = 90) => new Promise((done) => setTimeout(done, ms));

function useTheme(id) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    setThemeSetting(id ?? 'basic', { persist: false });
  } finally {
    process.stdout.write = write;
  }
}

function setSpies(props, spies, calls) {
  for (const path of spies ?? []) {
    const parts = path.split('.');
    let target = props;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    const name = parts.at(-1);
    target[name] = (...values) => {
      calls.push([path, ...values.map(plain)]);
      return undefined;
    };
  }
}

/** The last frame Ink wrote, or the one before when a key did not change what is drawn (Ink writes nothing then). */
const lastFrame = (writes, previous = '') => (writes.length ? writes[writes.length - 1] : previous);

async function runFrame(item) {
  useTheme(item.theme);
  const props = revive(structuredClone(item.props ?? {}));
  const calls = [];
  setSpies(props, item.spies, calls);
  if (item.children) props.children = React.createElement(Text, null, item.children.join('\n'));
  const stdout = new PassThrough();
  stdout.columns = item.columns;
  stdout.rows = item.rows ?? 40;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let writes = [];
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return write(chunk, ...rest);
  };
  const element = React.createElement(modules[item.component][item.component], props);
  const root = item.rows
    ? React.createElement(Box, { flexDirection: 'column', width: item.columns, height: item.rows }, element)
    : element;
  const view = render(root, { stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false });
  const frames = [];
  await settle();
  frames.push(lastFrame(writes));
  for (const key of item.keys ?? []) {
    writes = [];
    stdin.write(key);
    await settle();
    frames.push(lastFrame(writes, frames.at(-1)));
  }
  view.unmount();
  stdin.end();
  stdout.end();
  return { frames, calls };
}

function runFn(item) {
  const fn = modules[item.module]?.[item.name];
  if (typeof fn !== 'function') throw new Error(`${item.id}: no function ${item.module}.${item.name}`);
  return { result: plain(fn(...revive(structuredClone(item.args ?? [])))) };
}

const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const record = async (item) => (item.kind === 'fn' ? runFn(item) : runFrame(item));

if (framesOnlyLevel) {
  const frames = {};
  for (const item of cases.filter((c) => c.kind === 'frame' && c.levels)) frames[item.id] = (await runFrame(item)).frames;
  process.stdout.write(JSON.stringify(frames));
  process.exit(0);
}

function levelFrames(level) {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--tree', tree, '--cases', casesPath, '--level', String(level)], {
    // On Windows chalk raises FORCE_COLOR=1 or 2 to its truecolor level; TERM=dumb makes it return the forced level.
    env: { ...process.env, FORCE_COLOR: String(level), TERM: 'dumb' },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`level ${level} run failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

const atLevel = cases.some((c) => c.levels) ? { 1: levelFrames(1), 2: levelFrames(2) } : {};
const recorded = [];
for (const item of cases) {
  const entry = { id: item.id, kind: item.kind, ...(await record(item)) };
  if (item.kind === 'frame' && item.levels) entry.levels = { 1: atLevel[1][item.id], 2: atLevel[2][item.id] };
  recorded.push(entry);
}
const recording = JSON.stringify({ format: 1, ambiguousWide: true, cases: recorded }, null, 1) + '\n';
const writeTo = option('--write');
if (writeTo) {
  writeFileSync(writeTo, recording);
  console.log(`wrote ${writeTo} (${recorded.length} cases)`);
} else {
  const checkAgainst = option('--check');
  if (readFileSync(checkAgainst, 'utf8') !== recording) {
    console.error(`record-ink-frames: ${checkAgainst} differs from what the Node code records now`);
    process.exit(1);
  }
  console.log(`record-ink-frames: ${checkAgainst} matches (${recorded.length} cases)`);
}
