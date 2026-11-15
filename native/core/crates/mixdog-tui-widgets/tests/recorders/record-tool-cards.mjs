// Records what the Node terminal UI draws for a tool card (`components/ToolExecution.jsx`) and what the expanded-body
// functions of `components/tool-output-format.mjs` return, so the Rust tool cards (`mixdog-tui-widgets` tool_cards) are held
// to it cell by cell. A "frame" case names the props of ToolExecution, the columns, the theme and the time `Date.now()`
// returns (the card derives its blink phase and its pending-show delay from it); the recorder renders it with Ink (a fake
// terminal, FORCE_COLOR=3) and keeps the last frame. An "fn" case calls `formatExpandedResult` or `wrapExpandedResultLines`
// and keeps the strings it returns; its optional "env" sets the row-cap variables around the call.
//
// The Node code is only read: it is bundled with esbuild into a temporary folder beside this script (bare imports resolve
// from the repository's node_modules) and the folder is removed afterwards.
//
//   node record-tool-cards.mjs --tree C:/Project/mixdog --cases <cases.json> --write <golden.json>
//   node record-tool-cards.mjs --tree C:/Project/mixdog --cases <cases.json> --check <golden.json>
//
// Case files hold:
//   { "id", "kind": "frame", "props", "columns", "now"?, "theme"? }
//   { "id", "kind": "fn", "name", "args", "env"? }

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
if (!tree || !casesPath || (!option('--write') && !option('--check'))) {
  console.error('usage: record-tool-cards.mjs --tree <mixdog checkout> --cases <cases.json> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

// chalk reads these when it is imported.
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = '3';
process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '1';

const components = resolve(tree, 'src/tui/components');
const { build } = await import('esbuild');
const directory = mkdtempSync(join(here, '.tmp-record-tool-cards-'));
const outfile = join(directory, 'bundle.mjs');
let modules;
try {
  const entry = [
    `export { ToolExecution } from './ToolExecution.jsx';`,
    `export { formatExpandedResult, wrapExpandedResultLines } from './tool-output-format.mjs';`,
    `export { render } from 'ink';`,
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
  rmSync(directory, { recursive: true, force: true });
}
const { React, render, setThemeSetting, ToolExecution } = modules;

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

async function runFrame(item) {
  useTheme(item.theme);
  const realNow = Date.now;
  Date.now = () => item.now ?? 20000;
  const stdout = new PassThrough();
  stdout.columns = item.columns;
  stdout.rows = 200;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const writes = [];
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return write(chunk, ...rest);
  };
  const view = render(React.createElement(ToolExecution, { ...item.props, columns: item.columns }), {
    stdout,
    stdin,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await settle();
  const frame = writes.length ? writes[writes.length - 1] : '';
  view.unmount();
  stdin.end();
  stdout.end();
  Date.now = realNow;
  return { frame };
}

function runFn(item) {
  const names = ['MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES', 'MIXDOG_TUI_EXPANDED_MAX_ROWS'];
  const saved = names.map((name) => process.env[name]);
  for (const name of names) delete process.env[name];
  Object.assign(process.env, item.env ?? {});
  try {
    const fn = modules[item.name];
    if (typeof fn !== 'function') throw new Error(`${item.id}: no function ${item.name}`);
    return { result: fn(...structuredClone(item.args ?? [])) };
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
}

useTheme('basic');
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const recorded = [];
for (const item of cases) {
  recorded.push({ id: item.id, kind: item.kind, ...(item.kind === 'fn' ? runFn(item) : await runFrame(item)) });
}
const recording = JSON.stringify({ format: 1, ambiguousWide: true, cases: recorded }, null, 1) + '\n';
const writeTo = option('--write');
if (writeTo) {
  writeFileSync(writeTo, recording);
  console.log(`wrote ${writeTo} (${recorded.length} cases)`);
} else {
  const checkAgainst = option('--check');
  if (readFileSync(checkAgainst, 'utf8') !== recording) {
    console.error(`record-tool-cards: ${checkAgainst} differs from what the Node code records now`);
    process.exit(1);
  }
  console.log(`record-tool-cards: ${checkAgainst} matches (${recorded.length} cases)`);
}
