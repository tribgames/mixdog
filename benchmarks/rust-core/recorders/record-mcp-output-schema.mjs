#!/usr/bin/env node
// Records what a tool with an `outputSchema` answers the model in Node: the MCP SDK client validates each `tools/call`
// result against the listed schema (`client.mjs` `connectMcpServers` / `executeMcpTool`, with the lazy validator of
// `lazy-output-validator.mjs`). Each case is a stdio server answering its `tools` and, for `tools/call {i}`,
// `results[tool][i]`; recorded are the connect failure (`null` when it connected) and, per call, what `executeMcpTool`
// returned or `Error: <message>` when it threw (`execute-call.mjs`). The Rust replay serves the same case from its mock
// server.
//
//   node benchmarks/rust-core/recorders/record-mcp-output-schema.mjs --tree <git archive export of b6f10295a> [--only <case name>]
//
// Output: native/core/fixtures/mcp-output-schema/golden.json (+ MANIFEST.json). With --only, that case is printed and
// nothing is written.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'mcp-output-schema-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, orderedStringify, parseArgs, resolveTree, stageSet, within, writeJson, writeSetManifest } =
  await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-mcp-output-schema.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const only = args.get('only') ?? null;
const client = await importFrom(tree, 'src/runtime/agent/orchestrator/mcp/client.mjs');

// The server ends when its stdin closes (the client's disconnect, or this process ending).
const server = join(sandbox, 'server.mjs');
writeFileSync(
  server,
  `import { createInterface } from 'node:readline';
const scenario = JSON.parse(process.env.SCENARIO);
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('close', () => process.exit(0));
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize')
    return send({ id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'case', version: '0' } } });
  if (message.method === 'tools/list') return send({ id: message.id, result: { tools: scenario.tools } });
  if (message.method === 'tools/call')
    return send({ id: message.id, result: scenario.results[message.params.name][message.params.arguments.i] });
  send({ id: message.id, error: { code: -32601, message: 'method not found' } });
});
`
);

const input = { type: 'object', properties: { i: { type: 'number' } } };
const typed = {
  type: 'object',
  properties: {
    count: { type: 'number' },
    email: { type: 'string', format: 'email' },
    kind: { enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  },
  required: ['count'],
  additionalProperties: false,
};
const text = (value) => [{ type: 'text', text: value }];
// Every format `addFormats(ajv)` adds (ajv-formats, full mode), each with values on both sides of its check.
const FORMATS = {
  date: ['2024-02-29', '2023-02-29', '2024-1-01'],
  time: ['12:34:56Z', '12:34:56', '25:00:00Z', '23:59:60Z'],
  'date-time': ['2024-01-01T00:00:00Z', '2024-01-01t00:00:00+01:00', '2024-01-01 00:00:00Z', '2024-01-01T00:00:00'],
  'iso-time': ['12:34:56', '12:34'],
  'iso-date-time': ['2024-01-01T00:00:00', '2024-01-01'],
  duration: ['P1D', 'PT1H30M', 'P1W', '1D', 'P'],
  uri: ['https://a.test/x?y#z', 'urn:isbn:0451450523', 'not a uri', '/relative'],
  'uri-reference': ['../x', '#frag', 'https://a.test', 'a b'],
  'uri-template': ['https://a.test/{id}', 'https://a.test/{id'],
  url: ['https://a.test', 'ftp://a.test/x', 'nope'],
  email: ['a@b.test', 'a.b+c@d-e.test', 'a@', 'a@b'],
  hostname: ['a.test', 'localhost', '-bad-', 'a'.repeat(64) + '.test'],
  ipv4: ['10.0.0.1', '10.0.0.256', '01.2.3.4'],
  ipv6: ['::1', '2001:db8::1', '::g', '1::2::3'],
  regex: ['^a+$', '(', '\\p{L}'],
  uuid: ['123e4567-e89b-12d3-a456-426614174000', 'urn:uuid:123e4567-e89b-12d3-a456-426614174000', '123e4567'],
  'json-pointer': ['/a/b', '', 'a/b', '/a~2'],
  'json-pointer-uri-fragment': ['#/a', '#/a%20b', '/a'],
  'relative-json-pointer': ['1/a', '0#', '/a'],
  byte: ['aGk=', 'a', 'aGk'],
  int32: [1, 2147483647, 2147483648, 1.5],
  int64: [1, 1.5, 9007199254740991],
  float: [1.5, 1, 'x'],
  double: [1.5, 'x'],
  password: ['x', ''],
  binary: ['x', ''],
};
// One schema using each draft-07 keyword, a value meeting all of them and one failing each.
const KEYWORDS = {
  type: 'object',
  properties: {
    max: { maximum: 3 },
    min: { minimum: 3 },
    xmax: { exclusiveMaximum: 3 },
    xmin: { exclusiveMinimum: 3 },
    mult: { multipleOf: 0.5 },
    maxl: { maxLength: 2 },
    minl: { minLength: 2 },
    pat: { pattern: '^a+$' },
    maxi: { maxItems: 1 },
    mini: { minItems: 2 },
    uniq: { uniqueItems: true },
    uniqt: { items: { type: ['number', 'string'] }, uniqueItems: true },
    deps2: { dependencies: { a: ['b', 'c'] } },
    condelse: { if: { type: 'number' }, then: { minimum: 10 }, else: { minLength: 3 } },
    tuple: { items: [{ type: 'string' }], additionalItems: false },
    cont: { contains: { const: 1 } },
    maxp: { maxProperties: 1 },
    minp: { minProperties: 1 },
    names: { propertyNames: { pattern: '^[a-z]+$' } },
    deps: { dependencies: { a: ['b'], c: { required: ['d'] } } },
    pprops: { patternProperties: { '^n': { type: 'number' } } },
    not: { not: { type: 'string' } },
    all: { allOf: [{ type: 'number' }, { minimum: 1 }] },
    one: { oneOf: [{ type: 'number' }, { minimum: 0 }] },
    cond: { if: { type: 'number' }, then: { minimum: 10 }, else: { type: 'string' } },
    fals: { items: false },
  },
};
const KEYWORDS_OK = {
  max: 3, min: 3, xmax: 2, xmin: 4, mult: 1.5, maxl: 'ab', minl: 'ab', pat: 'aa', maxi: [1], mini: [1, 2], uniq: [1, 2],
  tuple: ['a'], cont: [0, 1], maxp: { a: 1 }, minp: { a: 1 }, names: { ab: 1 }, deps: { a: 1, b: 2 }, pprops: { n1: 1 },
  not: 1, all: 2, one: 'x', cond: 11, fals: [], uniqt: [1, '1', 2], deps2: { a: 1, b: 2, c: 3 }, condelse: 'abc',
};
const KEYWORDS_BAD = {
  max: 4, min: 2, xmax: 3, xmin: 3, mult: 1.25, maxl: 'abc', minl: 'a', pat: 'b', maxi: [1, 2], mini: [1], uniq: [1, 1],
  tuple: ['a', 'b'], cont: [0], maxp: { a: 1, b: 2 }, minp: {}, names: { AB: 1 }, deps: { a: 1, c: 2 }, pprops: { n1: 'x' },
  not: 'x', all: 0, one: 1, cond: 5, fals: [1], uniqt: ['a', 1, 2, 'a', 1.0], deps2: { a: 1 }, condelse: 'ab',
};
const CASES = [
  {
    name: 'results checked against the output schema',
    tools: [
      { name: 'typed', inputSchema: input, outputSchema: typed },
      { name: 'plain', inputSchema: input },
      { name: 'either', inputSchema: input, outputSchema: { type: 'object', anyOf: [{ required: ['a'] }, { required: ['b'] }] } },
      {
        name: 'local',
        inputSchema: input,
        outputSchema: { type: 'object', properties: { item: { $ref: '#/$defs/item' } }, $defs: { item: { type: 'string' } } },
      },
    ],
    results: {
      typed: [
        { content: text('{"count":2}'), structuredContent: { count: 2 } },
        { content: text('x'), structuredContent: { count: 'x' } },
        { content: text('plain') },
        { content: text('boom'), isError: true },
        { content: text('{}'), structuredContent: {} },
        { content: text('extra'), structuredContent: { count: 1, extra: true } },
        { content: text('many'), structuredContent: { tags: ['a', 1, 'c'], kind: 'c', email: 'nope', count: 'x' } },
        { content: text('error with structure'), structuredContent: { count: 'y' }, isError: true },
      ],
      plain: [{ content: text('free'), structuredContent: { anything: 1 } }],
      either: [
        { content: text('b'), structuredContent: { b: 1 } },
        { content: text('c'), structuredContent: { c: 1 } },
      ],
      local: [
        { content: text('ok'), structuredContent: { item: 'x' } },
        { content: text('bad'), structuredContent: { item: 3 } },
      ],
    },
    calls: [...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ['typed', i]), ['plain', 0], ['either', 0], ['either', 1], ['local', 0], ['local', 1]],
  },
  {
    name: 'schemas with $id resolve in listing order; a repeated $id keeps the first',
    tools: [
      {
        name: 'base',
        inputSchema: input,
        outputSchema: { $id: 'https://example.test/base.json', type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      },
      {
        name: 'uses',
        inputSchema: input,
        outputSchema: { type: 'object', properties: { inner: { $ref: 'https://example.test/base.json' } }, required: ['inner'] },
      },
      {
        name: 'dup',
        inputSchema: input,
        outputSchema: { $id: 'https://example.test/base.json', type: 'object', properties: { n: { type: 'string' } } },
      },
    ],
    results: {
      base: [{ content: text('3'), structuredContent: { n: 3 } }],
      uses: [
        { content: text('1'), structuredContent: { inner: { n: 1 } } },
        { content: text('x'), structuredContent: { inner: { n: 'x' } } },
      ],
      dup: [
        { content: text('text'), structuredContent: { n: 'text' } },
        { content: text('2'), structuredContent: { n: 2 } },
      ],
    },
    calls: [['uses', 0], ['uses', 1], ['dup', 0], ['dup', 1], ['base', 0]],
  },
  {
    name: 'a reference to an $id listed later fails the listing',
    tools: [
      { name: 'early', inputSchema: input, outputSchema: { type: 'object', properties: { inner: { $ref: 'https://example.test/late.json' } } } },
      { name: 'late', inputSchema: input, outputSchema: { $id: 'https://example.test/late.json', type: 'object' } },
    ],
    results: {},
    calls: [],
  },
  {
    name: 'const, enum, default and examples are data, not schema',
    tools: [
      {
        name: 'literal',
        inputSchema: input,
        outputSchema: {
          type: 'object',
          properties: {
            c: { const: { $ref: 'https://example.test/value' } },
            e: { enum: [{ $ref: 'https://example.test/other' }, { $id: 'https://example.test/not-an-id' }] },
            d: { type: 'string', default: { $ref: 'https://example.test/default' } },
            x: { type: 'string', examples: [{ $ref: 'https://example.test/example' }] },
          },
        },
      },
    ],
    results: {
      literal: [
        { content: text('ok'), structuredContent: { c: { $ref: 'https://example.test/value' }, e: { $id: 'https://example.test/not-an-id' } } },
        { content: text('bad'), structuredContent: { c: 1, e: 2, d: 3, x: 4 } },
      ],
    },
    calls: [['literal', 0], ['literal', 1]],
  },
  {
    name: 'a relative reference resolves against its schema $id, nested ids included',
    tools: [
      {
        name: 'base',
        inputSchema: input,
        outputSchema: {
          $id: 'https://example.test/dir/base.json',
          type: 'object',
          properties: { n: { type: 'number' } },
          $defs: { word: { $id: 'https://example.test/dir/word.json', type: 'string', minLength: 2 } },
        },
      },
      {
        name: 'relative',
        inputSchema: input,
        outputSchema: {
          $id: 'https://example.test/dir/tool.json',
          type: 'object',
          properties: { x: { $ref: 'base.json' }, w: { $ref: 'word.json' }, up: { $ref: '../dir/word.json' } },
        },
      },
      { name: 'nested', inputSchema: input, outputSchema: { type: 'object', properties: { w: { $ref: 'https://example.test/dir/word.json' } } } },
    ],
    results: {
      relative: [
        { content: text('ok'), structuredContent: { x: { n: 1 }, w: 'ab', up: 'cd' } },
        { content: text('bad'), structuredContent: { x: { n: 'one' }, w: 'a', up: 3 } },
      ],
      nested: [
        { content: text('ok'), structuredContent: { w: 'ab' } },
        { content: text('bad'), structuredContent: { w: 'a' } },
      ],
    },
    calls: [['relative', 0], ['relative', 1], ['nested', 0], ['nested', 1]],
  },
  {
    name: 'an invalid schema with an $id fails the listing',
    tools: [
      { name: 'fine', inputSchema: input, outputSchema: { type: 'object' } },
      { name: 'invalid', inputSchema: input, outputSchema: { $id: 'https://example.test/invalid.json', type: 'object', properties: { x: { type: 'bogus' } } } },
    ],
    results: {},
    calls: [],
  },
  {
    name: 'an invalid schema without an $id fails its first structured result',
    tools: [{ name: 'invalid', inputSchema: input, outputSchema: { type: 'object', properties: { x: { type: 'bogus' } } } }],
    results: {
      invalid: [
        { content: text('plain') },
        { content: text('x'), structuredContent: { x: 1 } },
        { content: text('again'), structuredContent: { x: 'a' } },
      ],
    },
    calls: [['invalid', 0], ['invalid', 1], ['invalid', 2]],
  },
  {
    name: 'every format ajv-formats adds, a valid value then an invalid one',
    tools: Object.keys(FORMATS).map((format) => ({
      name: `fmt_${format.replaceAll('-', '_')}`,
      inputSchema: input,
      outputSchema: { type: 'object', properties: { v: { format } } },
    })),
    results: Object.fromEntries(
      Object.entries(FORMATS).map(([format, values]) => [
        `fmt_${format.replaceAll('-', '_')}`,
        values.map((v) => ({ content: text(JSON.stringify(v)), structuredContent: { v } })),
      ])
    ),
    calls: Object.entries(FORMATS).flatMap(([format, values]) => values.map((_, i) => [`fmt_${format.replaceAll('-', '_')}`, i])),
  },
  {
    name: 'each keyword of draft-07 failing once',
    tools: [{ name: 'keywords', inputSchema: input, outputSchema: KEYWORDS }],
    results: {
      keywords: [
        { content: text('ok'), structuredContent: KEYWORDS_OK },
        { content: text('bad'), structuredContent: KEYWORDS_BAD },
      ],
    },
    calls: [['keywords', 0], ['keywords', 1]],
  },
];
const cases = CASES.filter((scenario) => !only || scenario.name === only);
if (!cases.length) throw new Error(`--only ${CASES.map((c) => c.name).join(' | ')}, got ${only}`);

async function record(scenario, index) {
  const scopeId = `case${index}`;
  const entry = { name: scenario.name, tools: scenario.tools, results: scenario.results, connect: null, outputs: [] };
  try {
    await within(
      `connecting ${scenario.name}`,
      client.connectMcpServers({ srv: { command: process.execPath, args: [server], env: { SCENARIO: JSON.stringify(scenario) } } }, { scopeId })
    );
  } catch (error) {
    if (!error.failures) throw error;
    entry.connect = error.failures[0].msg;
  }
  try {
    for (const [tool, i] of scenario.calls) {
      let output;
      try {
        output = await within(`calling ${tool} ${i}`, client.executeMcpTool(`mcp__srv__${tool}`, { i }, { scopeId }));
      } catch (error) {
        if (/no answer within/.test(error.message)) throw error;
        output = `Error: ${error.message}`;
      }
      entry.outputs.push({ tool, i, output });
    }
  } finally {
    await within(`disconnecting ${scenario.name}`, client.disconnectAll({ scopeId }));
  }
  return entry;
}

let code = 0;
try {
  const recorded = [];
  for (const [index, scenario] of cases.entries()) recorded.push(await record(scenario, index));
  if (only) process.stdout.write(orderedStringify(recorded[0]));
  else {
    const finalDir = join(FIXTURES_ROOT, 'mcp-output-schema');
    const stage = stageSet(finalDir);
    writeJson(join(stage, 'golden.json'), { domain: 'mcp-output-schema', recorder, cases: recorded });
    writeSetManifest(stage, {
      set: 'mcp-output-schema',
      recorder,
      command: `node ${recorder} --tree <tree>`,
      identity,
      extra: recorderProvenance(import.meta.url),
    });
    commitStage(stage, finalDir);
    console.log(`recorded ${recorded.length} cases`);
  }
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
// The SDK's stdio children read this process's pipes: ending it closes their stdin, which ends them.
process.exit(code);
