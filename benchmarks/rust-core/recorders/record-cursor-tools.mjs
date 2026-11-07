#!/usr/bin/env node
// The tools a Cursor run offers (WP-AI-CORE): the REAL Node steps of `cursor.mjs` `send` and the
// cursor wire, in their order: `acceptedWireTools(tools, 'openai', onToolExcluded, '[cursor] tool')`,
// `toOpenAITools`, `selectToolsForChoice`, `buildToolDefinitions` (slimming and the flat form of a
// compound root through `prepareCursorToolDefinition`). No server, no credential.
//
//   node benchmarks/rust-core/recorders/record-cursor-tools.mjs --tree <dir with node_modules> [--out <cases.json>]
//
// Output (default native/core/fixtures/providers/cursor-tools/cases.json):
//   cases[] { id, toolChoice, tools, offered, excluded }
//     offered   [{ name, description, inputSchemaJson }]   what the run request carries
//     excluded  [{ name, index, pointer, reason, message }] what onToolExcluded was told
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

const sandbox = mkdtempSync(join(tmpdir(), 'cursor-tools-'));
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
const out = resolve(flag('out') ?? join(here, '..', '..', '..', 'native', 'core', 'fixtures', 'providers', 'cursor-tools', 'cases.json'));

const P = 'src/runtime/agent/orchestrator/providers';
const mod = (path) => import(pathToFileURL(join(tree, path)).href);
const { acceptedWireTools } = await mod(`${P}/lib/claude-bridge-schema.mjs`);
const { toOpenAITools } = await mod(`${P}/openai-compat-wire.mjs`);
const { buildToolDefinitions, selectToolsForChoice } = await mod(`${P}/cursor-wire-request.mjs`);

const STR = { type: 'string' };
const OBJ = (properties, extra = {}) => ({ type: 'object', properties, ...extra });
const tool = (name, inputSchema) => ({ name, description: `The ${name} tool`, inputSchema });

let deep = { type: 'string', title: 'leaf' };
for (let i = 0; i < 16; i += 1) deep = OBJ({ next: deep, title: STR }, { title: `level ${i}` });

const SETS = [
  ['plain', [tool('lookup', OBJ({ key: STR }, { required: ['key'] }))]],
  ['annotations', [tool('slim', { $schema: 'http://json-schema.org/draft-07/schema#', title: 'T', default: {}, ...OBJ({ a: { type: 'string', title: 'A', default: 'x', examples: ['y'], deprecated: false, readOnly: true, writeOnly: false, $comment: 'c' } }, { required: [], additionalProperties: true, $id: 'x' }) })]],
  ['not-slimmed-further', [tool('keep', OBJ({ a: STR }, { required: ['a'], additionalProperties: false, description: 'kept' }))]],
  ['deep', [tool('deep', deep)]],
  ['compound-one-of', [tool('union', { oneOf: [OBJ({ a: { type: 'string', enum: ['x', 'y'] }, shared: { type: 'object', properties: { p: STR }, required: ['p'] } }), OBJ({ a: { type: 'string', enum: ['y', 'z'] }, b: { type: 'integer' }, shared: { type: 'object', properties: { q: STR }, required: ['p', 'q'] } })] })]],
  ['compound-with-root', [tool('rooted', { type: 'object', description: 'root', properties: { r: STR }, anyOf: [OBJ({ r: { type: 'string', enum: ['a'] }, s: STR }, { required: ['r'] }), OBJ({ s: { type: 'integer' } }, { required: ['r'] })], allOf: [{ properties: { t: STR } }] })]],
  ['compound-numeric-keys', [tool('numbered', { anyOf: [OBJ({ '10': STR, b: STR, '2': STR }), OBJ({ '2': { type: 'integer' }, c: STR })] })]],
  ['compound-bare-branches', [tool('bare-branches', { oneOf: [{ properties: { a: STR } }, { description: 'nothing to merge' }, { properties: { a: { enum: ['k'] }, b: STR } }] })]],
  ['array-parameters', [tool('array', [OBJ({ a: STR })])]],
  ['no-schema', [tool('bare', undefined)]],
  ['scalar-schema', [tool('scalar', 'oops')]],
  ['draft-07', [tool('tuple', OBJ({ pair: { type: 'array', items: [STR, { type: 'number' }] } })), tool('bound', OBJ({ n: { type: 'number', minimum: 1, exclusiveMinimum: true } })), tool('refs', { $schema: 'http://json-schema.org/draft-07/schema#', definitions: { n: STR }, ...OBJ({ x: { $ref: '#/definitions/n' } }) })]],
  ['broken', [tool('first', OBJ({ a: STR })), tool('dangling', OBJ({ x: { $ref: '#/$defs/missing' } })), tool('rooted', { type: 'string' }), tool('typed', OBJ({ x: { type: 'any' } })), tool('pattern', OBJ({ x: { type: 'string', pattern: '(' } })), tool('last', OBJ({ b: { type: 'integer' } }))]],
];

const cases = [];
for (const [setId, tools] of SETS) {
  for (const toolChoice of [undefined, 'none']) {
    const excluded = [];
    const accepted = acceptedWireTools(tools, 'openai', (found) => excluded.push(JSON.parse(JSON.stringify(found))), '[cursor] tool');
    const offered = buildToolDefinitions(selectToolsForChoice(toOpenAITools(accepted), toolChoice)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchemaJson: t.inputSchemaJson,
    }));
    cases.push({
      id: `${setId} / ${toolChoice ?? 'auto'}`,
      toolChoice: toolChoice ?? null,
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema === undefined ? null : t.inputSchema })),
      offered,
      excluded,
    });
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ recorder: 'benchmarks/rust-core/recorders/record-cursor-tools.mjs', cases }, null, 1)}\n`);
if (listing(userMixdog) !== before) throw new Error(`${userMixdog} changed during the run`);
console.log(`recorded ${cases.length} cursor tool cases to ${out}`);
