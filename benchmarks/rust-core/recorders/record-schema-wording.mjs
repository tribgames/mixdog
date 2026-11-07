#!/usr/bin/env node
// Tool-schema wording and the Anthropic Messages schema rule (WP-AI-CORE): the REAL Node
// `sanitizeAnthropicInputSchema`, `wireInputSchema`, `geminiJsonSchemaProblem`,
// `requestAnthropicTools` and `anthropicToolExclusion` over scripted and seeded schemas. No
// server, no credential.
//
//   node benchmarks/rust-core/recorders/record-schema-wording.mjs --tree <dir with node_modules> [--out <cases.json>]
//
// Output (default native/core/fixtures/providers/schema-wording/cases.json):
//   sanitize[]    { schema, out }                    sanitizeAnthropicInputSchema
//   wire[]        { schema, anthropic, openai, gemini }   wireInputSchema(schema, rule) as { schema } | { pointer, reason }
//   anthropic[]   { id, provider, tools, sent, excluded, exclusions }   requestAnthropicTools + anthropicToolExclusion
// The wording of a failure (Ajv's, V8's) reaches the user and the model, so the Rust tests compare
// it whole. Seeded cases whose failure is neither a meta-schema error, an unresolvable $ref nor a
// regular-expression SyntaxError are left out (their text is not ported); `skipped` counts them.
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

const sandbox = mkdtempSync(join(tmpdir(), 'schema-wording-'));
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
const out = resolve(flag('out') ?? join(here, '..', '..', '..', 'native', 'core', 'fixtures', 'providers', 'schema-wording', 'cases.json'));

const P = 'src/runtime/agent/orchestrator/providers';
const mod = (path) => import(pathToFileURL(join(tree, path)).href);
const { sanitizeAnthropicInputSchema, requestAnthropicTools, anthropicToolExclusion } = await mod(`${P}/lib/anthropic-request-utils.mjs`);
const { wireInputSchema, geminiJsonSchemaProblem } = await mod(`${P}/lib/claude-bridge-schema.mjs`);

const clean = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const OBJ = (properties, extra = {}) => ({ type: 'object', properties, ...extra });
const STR = { type: 'string' };

// ---- sanitizeAnthropicInputSchema ---------------------------------------------------------------
const ACTION = (action, input) => ({ type: 'object', properties: { action: { enum: [action] }, input } });
const SANITIZE = [
  OBJ({ a: STR }),
  { oneOf: [OBJ({ a: STR }, { description: 'first' }), OBJ({ b: { type: 'integer' } })] },
  { anyOf: [{ type: 'object', properties: { a: STR }, required: ['a'] }, { type: 'object', properties: { a: { type: 'integer' }, b: STR } }], description: 'root' },
  { allOf: [OBJ({ a: STR }, { required: ['a'] }), OBJ({ a: { minLength: 1 }, b: STR }, { required: ['b', 'a'] })] },
  { allOf: [{ allOf: [OBJ({ x: STR })] }, OBJ({ y: STR })], required: ['y', 'y'] },
  { type: 'object', required: ['a', 'a', 'b'], properties: { a: STR }, oneOf: [OBJ({ b: STR })] },
  { oneOf: [{ type: ['object', 'null'], properties: { a: STR } }, { type: 'string' }, null, true, []] },
  { oneOf: [{ description: 5, properties: { a: STR } }, { description: 0, type: 'object' }, { properties: ['p0', 'p1'] }] },
  { oneOf: Array.from({ length: 40 }, (_, i) => OBJ({ [`f${i}`]: STR }, { description: `variant number ${i} with some words` })) },
  { oneOf: [OBJ({ '10': STR, b: STR, '2': STR })], properties: { z: STR } },
  { oneOf: [OBJ({ a: STR })], additionalProperties: false },
  { oneOf: [OBJ({ a: STR })], additionalProperties: true },
  { oneOf: [], properties: { a: STR } },
  { anyOf: 'nope', properties: { a: STR } },
  { oneOf: 0, anyOf: [OBJ({ k: STR })] },
  { description: 12, oneOf: [OBJ({ a: STR })] },
  {
    oneOf: [
      ACTION('read', OBJ({ path: STR, limit: { type: 'integer', minimum: 1, maximum: 10 } }, { required: ['path'] })),
      ACTION('write', OBJ({ path: STR, limit: { type: 'integer', minimum: 5, maximum: 20 }, mode: { enum: ['a', 'b'] } }, { required: ['path'] })),
      ACTION('list', OBJ({ path: STR, mode: { enum: ['c'] } })),
    ],
  },
  {
    type: 'object',
    properties: { action: { enum: ['x', 'y'] }, input: { type: 'object', description: 'old' } },
    anyOf: [ACTION('x', OBJ({ n: { type: 'number', minimum: 0 } })), ACTION('y', OBJ({ n: { type: 'number', minimum: 2 } }))],
  },
  { oneOf: [ACTION('a', OBJ({ q: STR })), { type: 'object', properties: { action: { enum: ['b'] } } }] },
  { oneOf: [ACTION('a', OBJ({ q: { enum: [1, null, 'z', true] } })), ACTION('b', OBJ({ q: { enum: [2] } }))] },
  null,
  'oops',
  [OBJ({ a: STR })],
  {},
];

// ---- wireInputSchema / geminiJsonSchemaProblem --------------------------------------------------
const HANDMADE = [
  OBJ({ a: STR }),
  { type: 'string' },
  { description: 'no type' },
  { type: 'array' },
  { type: ['object', 'null'], properties: { a: STR } },
  { type: 'object', anyOf: [{ required: ['a'] }, { required: ['b'] }] },
  { type: 'object', allOf: [{ properties: { a: STR } }] },
  { type: 'object', not: { required: ['a'] } },
  OBJ({ pair: { type: 'array', items: [STR, { type: 'number' }] } }),
  OBJ({ n: { type: 'number', minimum: 1, exclusiveMinimum: true } }),
  { $schema: 'http://json-schema.org/draft-07/schema#', definitions: { n: { type: 'integer' } }, type: 'object', properties: { x: { $ref: '#/definitions/n', description: 'ignored' } } },
  OBJ({ a: { $ref: '#/$defs/missing' } }),
  { $id: 'http://example.com/s', ...OBJ({ a: { $ref: '#/$defs/missing' } }) },
  { $defs: { x: { $anchor: 'foo', type: 'string' } }, ...OBJ({ a: { $ref: '#foo' } }) },
  OBJ({ a: { $ref: '#nofoo' } }),
  { $defs: { 'a b': STR, 'c/d': STR }, ...OBJ({ a: { $ref: '#/$defs/a%20b' }, b: { $ref: '#/$defs/c~1d' } }) },
  OBJ({ a: { $ref: 'other.json#/x' } }),
  OBJ({ a: { $ref: '#/properties/b' }, b: STR }),
  OBJ({ a: { type: 'string', pattern: '(' } }),
  OBJ({ a: { type: 'string', pattern: '[' } }),
  { type: 'object', patternProperties: { '(': STR } },
  OBJ({ a: { $ref: '#/$defs/missing' }, b: { type: 'string', pattern: '(' } }),
  OBJ({ a: { type: 'any' } }),
  OBJ({ a: { type: ['string', 'string'] } }),
  OBJ({ a: { enum: 'x' } }),
  { type: 'object', required: 'a', properties: { a: STR } },
  { type: 'object', required: ['a', 'a'], properties: { a: STR } },
  { type: 'object', required: [1, 1], properties: { a: STR } },
  { type: 'object', properties: [STR] },
  { type: 'object', properties: { a: { type: 'integer', minimum: 'zero' } } },
  { type: 'object', properties: { a: { type: 'array', minItems: -1 } } },
  { type: 'object', properties: { a: { type: 'array', items: [] , minItems: 1.5 } } },
  { type: 'object', allOf: [] },
  { type: 'object', properties: { a: { multipleOf: 0 } } },
  { type: 'object', properties: { a: { exclusiveMinimum: 'x' } } },
  { type: 'object', properties: { '1': 5, '0': 6, x: 7 } },
  { type: 'object', $comment: 3 },
  { type: 'object', title: 3, description: [] },
  { type: 'object', properties: { a: { $ref: 5 } } },
  { type: 'object', dependencies: { a: ['b'] } },
  { type: 'object', dependencies: { a: 5 } },
  { type: 'object', definitions: { a: 5 } },
  { type: 'object', $defs: { 'x/y': { type: 'nope' }, '~': { type: 'nope' } } },
];

let seed = 20260107;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const SCALARS = [null, true, false, 0, 1, -1, 1.5, '', 'x', 'string', 'object', 'a b', '^a$', [], {}, [1, 1], ['a', 'a'], ['a', 'b'], ['a', 'b', 'a'], [1, 'a'], ['string', 'string'], ['object', 'null'], [{}, {}], [true], { a: 1 }];
const KEYS = ['type', 'properties', 'items', 'required', 'enum', 'minimum', 'exclusiveMinimum', 'maximum', 'minLength', 'minItems', 'maxItems', 'uniqueItems', 'pattern', 'format', 'anyOf', 'oneOf', 'allOf', 'not', 'additionalProperties', 'patternProperties', '$ref', '$defs', 'definitions', 'dependencies', 'dependentRequired', 'dependentSchemas', 'prefixItems', 'contains', 'if', 'then', 'else', 'propertyNames', 'description', 'title', 'default', 'examples', 'deprecated', 'const', 'multipleOf', 'minProperties', 'minContains', 'contentSchema', 'unevaluatedItems', 'unevaluatedProperties'];
const SUBMAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const SUBNODE = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedItems', 'contentSchema'];
const SUBLIST = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
function valid(depth) {
  const node = { type: pick(['string', 'integer', 'number', 'boolean', 'array', 'object']) };
  if (rnd() < 0.3) node.description = 'd';
  if (node.type === 'string' && rnd() < 0.4) node.enum = ['a', 'b'];
  if (node.type === 'integer' && rnd() < 0.4) node.minimum = 0;
  if (node.type === 'array') node.items = depth > 0 ? valid(depth - 1) : STR;
  if (node.type === 'object') {
    node.properties = {};
    for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) node.properties[pick(['a', 'b', 'c', '2', '1'])] = depth > 0 ? valid(depth - 1) : STR;
    if (rnd() < 0.5) node.required = Object.keys(node.properties).slice(0, 2);
    if (rnd() < 0.3) node.anyOf = [valid(Math.max(depth - 1, 0))];
    if (rnd() < 0.3) node.additionalProperties = depth > 0 ? valid(depth - 1) : false;
  }
  return node;
}
function junk(depth) {
  const node = {};
  for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) {
    const key = pick(KEYS);
    if (depth > 0 && rnd() < 0.5) {
      if (SUBMAP.includes(key)) node[key] = Object.fromEntries(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => [pick(['a', 'b', '1', '0', 'c/d', 'e~f', '10']), junk(depth - 1)]));
      else if (SUBNODE.includes(key)) node[key] = junk(depth - 1);
      else if (SUBLIST.includes(key)) node[key] = Array.from({ length: Math.floor(rnd() * 3) }, () => junk(depth - 1));
      else node[key] = structuredClone(pick(SCALARS));
    } else if (key === 'type' && rnd() < 0.8) node[key] = pick(['string', 'object', 'array', 'number', 'integer', 'boolean', 'null']);
    else if (key === '$ref') node[key] = pick(['#/$defs/a', '#/properties/a', '#', 'x.json#/y']);
    else if (key === 'pattern') node[key] = pick(['^a$', '(', '[a-', 'a{2,1}']);
    else node[key] = structuredClone(pick(SCALARS));
  }
  return node;
}
function nodes(root) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return [];
  const out = [root];
  for (const v of Object.values(root)) {
    if (Array.isArray(v)) v.forEach((c) => out.push(...nodes(c)));
    else if (v && typeof v === 'object') {
      out.push(...nodes(v));
      for (const c of Object.values(v)) out.push(...nodes(c));
    }
  }
  return out;
}
function faulty() {
  const root = valid(3);
  for (let f = 0; f < 1 + Math.floor(rnd() * 2); f++) pick(nodes(root))[pick(KEYS)] = structuredClone(pick(SCALARS));
  return root;
}

const MODELED = /^(not a valid JSON Schema 2020-12 schema|unresolvable \$ref|Invalid regular expression)/;
const verdict = (rule, schema) => {
  const result = wireInputSchema(schema, rule);
  return result.schema ? { schema: clean(result.schema) } : { pointer: result.pointer, reason: result.reason };
};
const wire = [];
let skipped = 0;
const candidates = [...HANDMADE, ...Array.from({ length: 160 }, () => (rnd() < 0.5 ? faulty() : junk(3)))];
for (const schema of candidates) {
  const { $schema, ...rest } = schema;
  const input = schema.$schema === undefined || typeof schema.$schema === 'string' ? schema : rest;
  const row = { schema: clean(input), anthropic: verdict('anthropic', input), openai: verdict('openai', input), gemini: verdict('gemini', input) };
  const problem = geminiJsonSchemaProblem(input);
  row.geminiProblem = problem ? { pointer: problem.pointer, reason: problem.reason } : null;
  const failures = [row.anthropic, row.openai, row.gemini, row.geminiProblem].filter((v) => v && v.reason);
  if (failures.some((f) => !MODELED.test(f.reason) && !/^(the input schema|Anthropic input_schema)/.test(f.reason))) {
    skipped += 1;
    continue;
  }
  wire.push(row);
}

const sanitize = SANITIZE.map((schema) => ({ schema: clean(schema), out: clean(sanitizeAnthropicInputSchema(schema, 'tool', 'anthropic')) }));

// ---- requestAnthropicTools ----------------------------------------------------------------------
const tool = (name, inputSchema, extra = {}) => ({ name, description: `The ${name} tool`, inputSchema, ...extra });
const TOOLSETS = [
  ['plain', [tool('lookup', OBJ({ key: STR }, { required: ['key'] }))]],
  ['mixed', [tool('first', OBJ({ a: STR })), tool('dangling', OBJ({ x: { $ref: '#/$defs/missing' } })), tool('tuple', OBJ({ pair: { type: 'array', items: [STR] } })), tool('union', { oneOf: [OBJ({ a: STR }, { description: 'one' }), OBJ({ b: STR })] }), tool('last', OBJ({ b: { type: 'integer' } }), { deferLoading: true })]],
  ['broken-types', [tool('typed', OBJ({ x: { type: 'any' } })), tool('rooted', { type: 'string' }), tool('pattern', OBJ({ x: { type: 'string', pattern: '(' } }))]],
  ['no-schema', [tool('bare', undefined)]],
  ['actions', [tool('act', { oneOf: [ACTION('read', OBJ({ path: STR, limit: { type: 'integer', minimum: 1 } })), ACTION('write', OBJ({ path: STR, limit: { type: 'integer', minimum: 3 } }))] })]],
];
const anthropic = [];
for (const [id, tools] of TOOLSETS) {
  for (const provider of ['anthropic', 'anthropic-oauth']) {
    const excluded = [];
    const sent = requestAnthropicTools(tools, [], { onToolExcluded: (e) => excluded.push(clean(e)) }, provider, {});
    anthropic.push({
      id,
      provider,
      tools: tools.map((t) => clean(t)),
      sent: clean(sent),
      excluded,
      exclusions: tools.map((t) => clean(anthropicToolExclusion(t, provider))),
    });
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ recorder: 'benchmarks/rust-core/recorders/record-schema-wording.mjs', skipped, sanitize, wire, anthropic }, null, 1)}\n`);
if (listing(userMixdog) !== before) throw new Error(`${userMixdog} changed during the run`);
console.log(`recorded ${sanitize.length} sanitize, ${wire.length} wire (${skipped} skipped), ${anthropic.length} anthropic cases to ${out}`);
