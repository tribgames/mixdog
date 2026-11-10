#!/usr/bin/env node
// Which tools a Gemini wire accepts (WP-AI-CORE): the REAL Node `geminiAcceptedTools`,
// `geminiToolExclusion` and `toGeminiTools` (validated and plain) over scripted tool lists.
// No server, no credential.
//
//   node benchmarks/rust-core/recorders/record-gemini-tool-schema.mjs --tree <dir with node_modules> [--out <cases.json>]
//
// Output (default native/core/fixtures/providers/gemini-tool-schema/cases.json): each case stores
// its tools and, as the Node functions answer, the kept tools (name and input schema), the
// exclusions { name, index, pointer, reason, message }, the single tool's `geminiToolExclusion`,
// and the `functionDeclarations` of `toGeminiTools` with validation on and off.
//
// Every user directory is a fresh temp one BEFORE any product module loads, so nothing under the
// user's home can be read or written; the run ends by checking that os.homedir() still resolves into
// the sandbox (the live ~/.mixdog is never read).
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'gemini-tool-schema-'));
const dirs = Object.fromEntries(
  ['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)])
);
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
const out = resolve(flag('out') ?? join(here, '..', '..', '..', 'native', 'core', 'fixtures', 'providers', 'gemini-tool-schema', 'cases.json'));

const mod = await import(
  pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/providers/gemini-schema.mjs')).href
);
const { geminiAcceptedTools, geminiToolExclusion, toGeminiTools } = mod;

const tool = (name, inputSchema) => ({ name, description: `The ${name} tool`, inputSchema: inputSchema ?? undefined });
const OBJ = (properties, extra = {}) => ({ type: 'object', properties, ...extra });
const DRAFT07 = 'http://json-schema.org/draft-07/schema#';

const CASES = [
  ['plain-object', [tool('lookup', OBJ({ key: { type: 'string' } }, { required: ['key'] }))]],
  ['no-arguments', [tool('ping', OBJ({}))]],
  ['no-schema', [tool('bare', null)]],
  ['json-schema-path', [tool('strict', OBJ({ a: { type: 'string' } }, { additionalProperties: false, 'x-vendor': 1, $comment: 'c' }))]],
  ['array-without-items', [tool('list', OBJ({ list: { type: 'array' } }))]],
  ['tuple-items-draft07', [tool('tuple', OBJ({ pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } }))]],
  ['boolean-exclusive-bound-draft04', [tool('bound', OBJ({ n: { type: 'number', minimum: 1, exclusiveMinimum: true } }))]],
  [
    'definitions-ref-draft07',
    [tool('refs', { $schema: DRAFT07, definitions: { name: { type: 'string' } }, type: 'object', properties: { x: { $ref: '#/definitions/name' } } })],
  ],
  [
    'ref-siblings-draft07',
    [tool('siblings', { $schema: DRAFT07, definitions: { n: { type: 'integer' } }, type: 'object', properties: { x: { $ref: '#/definitions/n', description: 'ignored' } } })],
  ],
  ['dependencies-draft07', [tool('deps', OBJ({ a: { type: 'string' }, b: { type: 'string' } }, { dependencies: { a: ['b'] } }))]],
  ['unresolvable-ref', [tool('dangling', OBJ({ x: { $ref: '#/$defs/missing' } }))]],
  ['root-type-union', [tool('nullable-root', { type: ['object', 'null'], properties: { a: { type: 'string' } } })]],
  ['root-string-enum', [tool('not-object', { type: 'string', enum: ['a', 'b'] })]],
  ['unsupported-type', [tool('typed', OBJ({ x: { type: 'any' } }))]],
  ['required-not-declared', [tool('required', OBJ({ a: { type: 'string' } }, { required: ['b'] }))]],
  ['any-of-property', [tool('union', OBJ({ v: { anyOf: [{ type: 'string' }, { type: 'integer' }] } }))]],
  ['nullable-type-union', [tool('nullable', OBJ({ n: { type: ['string', 'null'] } }))]],
  ['const-and-numeric-enum', [tool('consts', OBJ({ k: { const: 'x' }, e: { type: 'integer', enum: [1, 2] } }))]],
  ['all-of-root', [tool('conj', { allOf: [OBJ({ a: { type: 'string' } }), { required: ['a'] }] })]],
  ['boolean-property-schema', [tool('open', OBJ({ v: true }))]],
  ['integer-exclusive-bound', [tool('count', OBJ({ n: { type: 'integer', exclusiveMinimum: 0 } }))]],
  ['scalar-schema', [tool('oops', 'oops')]],
  ['array-schema', [tool('listed', [{ type: 'object' }])]],
  ['properties-array', [tool('odd', { type: 'object', properties: [{ type: 'string' }] })]],
  [
    'mixed-batch',
    [
      tool('first', OBJ({ a: { type: 'string' } })),
      tool('dangling', OBJ({ x: { $ref: '#/$defs/missing' } })),
      tool('tuple', OBJ({ pair: { type: 'array', items: [{ type: 'string' }] } })),
      tool('last', OBJ({ b: { type: 'integer' } })),
    ],
  ],
];

const clean = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const cases = CASES.map(([id, tools]) => {
  const excluded = [];
  const kept = geminiAcceptedTools(tools, (found) => excluded.push(clean(found)));
  const validatedExcluded = [];
  const validated = toGeminiTools(tools, { onToolExcluded: (found) => validatedExcluded.push(clean(found)) });
  const plain = toGeminiTools(tools, { validate: false });
  return {
    id,
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: clean(t.inputSchema) })),
    accepted: {
      sameList: kept === tools,
      tools: kept.map((t) => ({ name: t.name, inputSchema: clean(t.inputSchema) })),
      excluded,
    },
    exclusion: tools.length === 1 ? clean(geminiToolExclusion(tools[0])) : null,
    validated: { declarations: clean(validated.functionDeclarations), excluded: validatedExcluded },
    plain: clean(plain.functionDeclarations),
  };
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ recorder: 'benchmarks/rust-core/recorders/record-gemini-tool-schema.mjs', cases }, null, 2)}\n`);
// Every home-relative path the product resolves (os.homedir() reads USERPROFILE / HOME) is in the sandbox; the live
// profile is never read.
if (homedir() !== dirs.home) throw new Error(`os.homedir() is ${homedir()}, not the sandbox home ${dirs.home}`);
console.log(`recorded ${cases.length} gemini tool-schema cases to ${out}`);
