#!/usr/bin/env node
// Per-action input unions and the Claude bridge schema (WP-AI-CORE): the REAL Node
// `flattenActionInputUnion`, `advertiseActionInputUnion`, `actionInputUnionFor`,
// `claudeBridgeInputSchema` and `toGeminiTools({ claudeBridge: true })`, plus the computer tool's
// own union. No server, no credential.
//
//   node benchmarks/rust-core/recorders/record-action-input-union.mjs --tree <dir with node_modules> [--out <cases.json>] [--union <computer.union.json>]
//
// Output (default native/core/fixtures/providers/action-input-union/cases.json):
//   flatten[]       { nested, flat }                        flattenActionInputUnion (the first is the computer tool's)
//   registry[]      { flat, nested }                        what actionInputUnionFor answers after advertising
//   bridge[]        { schema, result }                      claudeBridgeInputSchema(actionInputUnionFor(schema))
//   declarations[]  { id, tools, declarations, excluded }   toGeminiTools(tools, { claudeBridge: true, onToolExcluded })
//   anthropic[]     { provider, tools, sent, excluded }     requestAnthropicTools (the nested union goes out for a registered flat schema)
// and, with --union, the computer tool's nested union (`COMPUTER_ACTION_INPUT_UNION`, recovered
// through actionInputUnionFor of its advertised flat schema) for mixdog-tools to register.
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

const sandbox = mkdtempSync(join(tmpdir(), 'action-union-'));
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
const out = resolve(flag('out') ?? join(here, '..', '..', '..', 'native', 'core', 'fixtures', 'providers', 'action-input-union', 'cases.json'));

const P = 'src/runtime/agent/orchestrator/providers';
const mod = (path) => import(pathToFileURL(join(tree, path)).href);
const { flattenActionInputUnion, advertiseActionInputUnion, actionInputUnionFor } = await mod(`${P}/lib/action-input-contract.mjs`);
const { claudeBridgeInputSchema } = await mod(`${P}/lib/claude-bridge-schema.mjs`);
const { toGeminiTools } = await mod(`${P}/gemini-schema.mjs`);
const { COMPUTER_INPUT_SCHEMA } = await mod('src/runtime/computer-bridge/action-schema.mjs');

const clean = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const STR = { type: 'string' };
const OBJ = (properties, extra = {}) => ({ type: 'object', properties, ...extra });
const alt = (title, properties, extra = {}) => ({ title, description: `Input when action="${title}".`, ...OBJ(properties, extra) });
const union = (actions, alternatives, input = {}) => ({
  type: 'object',
  description: 'A tool.',
  properties: { action: { type: 'string', enum: actions }, input: { type: 'object', description: 'Fields.', anyOf: alternatives, ...input } },
  required: ['action'],
  additionalProperties: false,
});

const computerNested = actionInputUnionFor(COMPUTER_INPUT_SCHEMA);
if (computerNested === COMPUTER_INPUT_SCHEMA) throw new Error('the computer tool registered no union');

const UNIONS = [
  computerNested,
  union(['read', 'write'], [alt('read', { path: STR, limit: { type: 'integer', minimum: 1, maximum: 10 } }, { required: ['path'] }), alt('write', { path: STR, limit: { type: 'integer', minimum: 5, maximum: 20 }, mode: { enum: ['a', 'b'] } }, { required: ['path', 'mode'] })]),
  union(['only'], [alt('only', { q: STR })]),
  union(['a', 'b', 'c'], [alt('a', { n: { type: 'number', minimum: 0 }, nested: OBJ({ x: STR }, { required: ['x'] }) }), alt('b', { n: { type: 'number', minimum: 2 }, nested: OBJ({ y: STR, x: { type: 'integer' } }, { required: ['x', 'y'] }) }), alt('c', { m: { enum: [1, null, 'z'] } })], { description: undefined }),
  union(['a', 'b'], [alt('a', { '10': STR, k: STR, '2': STR }), alt('b', { k: { enum: ['x'] }, '2': STR })]),
  union(['a', 'b'], [alt('a', { q: STR }), { title: 'zzz', ...OBJ({ q: STR }) }]),
  union(['a', 'b'], [alt('a', { q: STR }), { title: 'b', type: 'object' }]),
  union(['a'], []),
  OBJ({ action: STR, input: STR }),
  OBJ({ a: STR }),
];
const flatten = UNIONS.map((nested) => ({ nested: clean(nested), flat: clean(flattenActionInputUnion(nested)) }));
const registry = [];
for (const nested of UNIONS.slice(1)) {
  const flat = advertiseActionInputUnion(nested);
  registry.push({ flat: clean(flat), nested: clean(actionInputUnionFor(flat)), registered: actionInputUnionFor(flat) !== flat });
}
const unregistered = clean(flattenActionInputUnion(union(['q'], [alt('q', { z: STR })])));
registry.push({ flat: unregistered, nested: unregistered, registered: false });

const DRAFT07 = 'http://json-schema.org/draft-07/schema#';
const SCHEMAS = [
  OBJ({ a: STR }),
  COMPUTER_INPUT_SCHEMA,
  ...UNIONS.slice(1, 4).map((nested) => flattenActionInputUnion(nested)),
  { $schema: DRAFT07, definitions: { n: { type: 'integer' } }, type: 'object', properties: { x: { $ref: '#/definitions/n', description: 'ignored' } } },
  { $schema: 'https://json-schema.org/draft-07/schema', type: 'object', properties: { pair: { type: 'array', items: [STR, { type: 'number' }], additionalItems: false } } },
  { $schema: 'http://json-schema.org/draft/2020-12/schema#', ...OBJ({ a: STR }) },
  { $schema: 'https://json-schema.org/draft/2020-12/schema', ...OBJ({ a: STR }) },
  { $schema: 'http://json-schema.org/draft-04/schema#', ...OBJ({ a: STR }) },
  { $schema: 'http://json-schema.org/draft-06/schema#', ...OBJ({ a: STR }) },
  { $schema: 5, ...OBJ({ a: STR }) },
  { $schema: '', ...OBJ({ a: STR }) },
  { $schema: DRAFT07, type: 'object', properties: { a: { $ref: '#/definitions/missing' } } },
  { $schema: DRAFT07, type: 'object', definitions: { a: { type: 'nope' } } },
  OBJ({ pair: { type: 'array', items: [STR] } }),
  OBJ({ n: { type: 'number', minimum: 1, exclusiveMinimum: true } }),
  { type: 'object', dependencies: { a: ['b'] }, properties: { a: STR, b: STR } },
  { description: 'no type' },
  { type: 'string' },
  { type: 'array' },
  { type: ['object', 'null'], properties: { a: STR } },
  { type: 'object', anyOf: [{ required: ['a'] }, { required: ['b'] }], properties: { a: STR, b: STR } },
  { anyOf: [OBJ({ a: STR }), OBJ({ b: STR })] },
  { type: 'object', not: { required: ['a'] } },
  OBJ({ a: { $ref: '#/$defs/missing' } }),
  { $id: 'http://example.com/s', ...OBJ({ a: { $ref: '#/$defs/missing' } }) },
  OBJ({ a: { type: 'any' } }),
  OBJ({ a: { type: 'string', pattern: '(' } }),
  { type: 'object', required: 'a' },
  { type: 'object', properties: [STR] },
  [OBJ({ a: STR })],
  'oops',
  5,
  null,
];
const bridge = SCHEMAS.map((schema) => {
  const result = claudeBridgeInputSchema(actionInputUnionFor(schema));
  return { schema: clean(schema), result: result.schema ? { schema: clean(result.schema) } : { pointer: result.pointer, reason: result.reason } };
});

const tool = (name, inputSchema) => ({ name, description: `The ${name} tool`, inputSchema });
const TOOLSETS = [
  ['plain', [tool('lookup', OBJ({ key: STR }, { required: ['key'] }))]],
  ['mixed', [tool('first', OBJ({ a: STR })), tool('dangling', OBJ({ x: { $ref: '#/$defs/missing' } })), tool('tuple', OBJ({ pair: { type: 'array', items: [STR] } })), tool('computer', COMPUTER_INPUT_SCHEMA), tool('rooted', { type: 'string' }), tool('bare', undefined)]],
  ['dialects', [tool('d07', { $schema: DRAFT07, definitions: { n: STR }, ...OBJ({ x: { $ref: '#/definitions/n' } }) }), tool('d04', { $schema: 'http://json-schema.org/draft-04/schema#', ...OBJ({ a: STR }) })]],
];
const declarations = TOOLSETS.map(([id, tools]) => {
  const excluded = [];
  const built = toGeminiTools(tools, { claudeBridge: true, onToolExcluded: (found) => excluded.push(clean(found)) });
  return { id, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: clean(t.inputSchema) })), declarations: clean(built.functionDeclarations), excluded };
});

// First-party Anthropic sends the registered nested union (requestAnthropicTools).
const { requestAnthropicTools } = await mod(`${P}/lib/anthropic-request-utils.mjs`);
const anthropic = ['anthropic', 'anthropic-oauth'].map((provider) => {
  const tools = [tool('computer', COMPUTER_INPUT_SCHEMA), tool('plain', OBJ({ a: STR })), tool('union', flattenActionInputUnion(UNIONS[1]))];
  const excluded = [];
  const sent = requestAnthropicTools(tools, [], { onToolExcluded: (found) => excluded.push(clean(found)) }, provider, {});
  return { provider, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: clean(t.inputSchema) })), sent: clean(sent), excluded };
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ recorder: 'benchmarks/rust-core/recorders/record-action-input-union.mjs', flatten, registry, bridge, declarations, anthropic }, null, 1)}\n`);
const unionOut = flag('union');
if (unionOut) {
  mkdirSync(dirname(resolve(unionOut)), { recursive: true });
  writeFileSync(resolve(unionOut), `${JSON.stringify(computerNested, null, 2)}\n`);
}
if (listing(userMixdog) !== before) throw new Error(`${userMixdog} changed during the run`);
console.log(`recorded ${flatten.length} flatten, ${registry.length} registry, ${bridge.length} bridge, ${declarations.length} declaration sets to ${out}`);
