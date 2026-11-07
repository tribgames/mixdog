#!/usr/bin/env node
// Which tools a Cursor run offers for a tool choice (WP-AI-CORE): the REAL Node
// `toCursorToolChoice` (cursor.mjs, the body's `tool_choice`), `selectToolsForChoice` and
// `buildToolDefinitions` (cursor wire). Cursor is the only wire in the Node tree that narrows
// the tool list by the choice (searched: every other wire only maps the choice to a wire field).
//
//   node benchmarks/rust-core/recorders/record-cursor-tool-choice.mjs --tree <dir with node_modules> [--out <cases.json>]
//
// Output (default native/core/fixtures/providers/cursor-tool-choice/cases.json):
//   cases[] { id, tools: [name], choice, bodyToolChoice, offered: [name] }
//     choice          the `sendOpts.toolChoice` as Node's loop passes it (absent = null)
//     bodyToolChoice  what `_chatBody` puts in `tool_choice` (absent = null)
//
// Every user directory is a fresh temp one BEFORE any product module loads; the run ends by
// comparing a listing of ~/.mixdog (the running daemon's data directory excluded).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const listing = (dir) => {
  if (!existsSync(dir)) return '';
  const rows = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (path === join(dir, 'data')) continue;
      const info = statSync(path);
      rows.push(`${path}\t${entry.isDirectory() ? 'd' : info.size}\t${info.mtimeMs}`);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return rows.sort().join('\n');
};
const userMixdog = join(homedir(), '.mixdog');
const before = listing(userMixdog);

const sandbox = mkdtempSync(join(tmpdir(), 'cursor-choice-'));
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
});

const args = process.argv.slice(2);
const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const tree = resolve(flag('tree') ?? process.env.MIXDOG_BENCH_TREE ?? '');
if (!existsSync(join(tree, 'node_modules'))) throw new Error(`tree ${tree} has no node_modules: pass --tree <dir>`);
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(flag('out') ?? join(here, '..', '..', '..', 'native', 'core', 'fixtures', 'providers', 'cursor-tool-choice', 'cases.json'));

const P = 'src/runtime/agent/orchestrator/providers';
const mod = (path) => import(pathToFileURL(join(tree, path)).href);
const { toOpenAITools } = await mod(`${P}/openai-compat-wire.mjs`);
const { buildToolDefinitions, selectToolsForChoice } = await mod(`${P}/cursor-wire-request.mjs`);
const { __cursorModelInternals } = await mod(`${P}/cursor.mjs`);

const tool = (name) => ({ name, description: `The ${name} tool`, inputSchema: { type: 'object', properties: { key: { type: 'string' } } } });
const SETS = [
  ['abc', ['a', 'b', 'c']],
  ['repeated', ['a', 'b', 'b']],
  ['single', ['only']],
  ['none-at-all', []],
];
// Absent is `undefined`; JSON keeps it as null.
const CHOICES = [
  undefined,
  'none',
  'auto',
  'required',
  'any',
  { name: 'b' },
  { type: 'function', function: { name: 'b' } },
  { function: { name: 'c' }, name: 'a' },
  { name: 'missing' },
  { name: 'only' },
  { name: '' },
  { type: 'function' },
  { name: 5 },
  {},
  null,
];

const cases = [];
for (const [setId, names] of SETS) {
  for (const choice of CHOICES) {
    const bodyToolChoice = __cursorModelInternals.toCursorToolChoice(choice);
    const offered = buildToolDefinitions(selectToolsForChoice(toOpenAITools(names.map(tool)), bodyToolChoice)).map((t) => t.name);
    cases.push({
      id: `${setId} / ${JSON.stringify(choice) ?? 'undefined'}`,
      tools: names,
      choice: choice === undefined ? null : choice,
      bodyToolChoice: bodyToolChoice === undefined ? null : bodyToolChoice,
      offered,
    });
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ recorder: 'benchmarks/rust-core/recorders/record-cursor-tool-choice.mjs', cases }, null, 1)}\n`);
if (listing(userMixdog) !== before) throw new Error(`${userMixdog} changed during the run`);
console.log(`recorded ${cases.length} cursor tool-choice cases to ${out}`);
