#!/usr/bin/env node
// Records what a tool with an `outputSchema` answers the model in Node: the MCP SDK client validates each `tools/call`
// result against the listed schema (`client.mjs` `connectMcpServers` / `executeMcpTool`, with the lazy validator of
// `lazy-output-validator.mjs`). Each case is a stdio server answering its `tools` and, for `tools/call {i}`,
// `results[tool][i]`; recorded are the connect failure (`null` when it connected) and, per call, the whole of what
// `executeMcpTool` returned (a text, or the parts in order) or `Error: <message>` when it threw (`execute-call.mjs`).
// A case naming a remote `$ref` also records how many requests the server at that address got. The Rust replay serves
// the same case from its mock server.
//
//   node benchmarks/rust-core/recorders/record-mcp-output-schema.mjs --tree <git archive export of b6f10295a> [--only <case name>]
//
// Output: native/core/fixtures/mcp-output-schema/golden.json (+ MANIFEST.json). With --only, that case is printed and
// nothing is written.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
// `format: "regex"` (ajv-formats: `new RegExp(str)`, no flags, and no `\Z`).
const REGEX_FORMAT = [
  '(?i)a', 'a\\Z', 'a\\\\Z', '(?<=a)b', '(?<n>a)\\k<n>', '\\1(a)', 'a{', 'a{1', ']', '\\c', '[\\d-z]', '\\p{L}', '(?i:a)',
  '\\u{61}', 'a**', '\\k', '(?<a>x)(?<a>y)', '[z-a]', '\\-',
];
// `pattern` (Ajv: `new RegExp(pattern, "u")`): each construct with values on both sides; the last ones do not compile
// with the u flag.
const PATTERNS = [
  ['^\\d+$', ['12', '١٢']],
  ['^\\w+$', ['ab_1', 'é']],
  ['é\\b', ['éa', 'é ']],
  ['(?<=a)b', ['ab', 'cb']],
  ['^(?<y>\\d{4})-\\k<y>$', ['2024-2024', '2024-2025']],
  ['^(a)\\1$', ['aa', 'ab']],
  ['^.$', ['\u2028', 'x', '\u{1F600}']],
  ['^\\s$', ['\uFEFF', '\u00A0']],
  ['^\\p{Lu}$', ['É', 'é']],
  ['^[^]$', ['x']],
  ['^a$', ['a\n']],
  ['^\\u{1F600}$', ['\u{1F600}']],
  ['^[😀]$', ['😀', '😁']],
  ['(?i)a', ['a']],
  ['\\-', ['-']],
];
// Schemas Ajv cannot compile (or can), by kind.
const NOT_COMPILING = [
  ['an invalid pattern', { type: 'object', properties: { v: { type: 'string', pattern: '(' } } }],
  ['a pattern valid only without the u flag', { type: 'object', properties: { v: { type: 'string', pattern: '\\-' } } }],
  ['an invalid patternProperties key', { type: 'object', patternProperties: { '(': { type: 'string' } } }],
  ['an unresolvable local $ref', { type: 'object', properties: { v: { $ref: '#/definitions/missing' } } }],
  ['an invalid type in an array', { type: 'object', properties: { v: { type: ['string', 'bogus'] } } }],
  ['a boolean schema', true],
  ['a string schema', 'x'],
  ['an array schema', [1]],
];
const k = (kind) => kind.replace(/\W+/g, '-');
const ALL_ERRORS = {
  type: 'object',
  required: ['r1', 'r2'],
  properties: {
    a: { type: 'array', items: { type: 'number' }, maxItems: 2 },
    m: { type: 'object', properties: { p: { type: 'number' }, q: { type: 'string' } }, required: ['s'] },
    z: { type: 'number', minimum: 5 },
  },
  additionalProperties: false,
};
const STRICT_FORMATS = {
  'date-time': ['2024-01-01T00:00:00.123+05:30', '2024-01-01T24:00:00Z', '2016-12-31T23:59:60Z', '2024-01-01T00:00:00+0530', '2024-01-01T00:00Z'],
  date: ['2024-13-01', '0000-01-01', '2024-02-30', '20240101'],
  time: ['12:34:56.789+01:00', '12:34:56+0100', '23:59:60+01:00', '12:34'],
  uri: ['http://[::1]/', 'HTTP://A.test', 'a:b', 'http://a b', 'mailto:a@b.test'],
  'uri-reference': ['', '\\x', '//a.test/p', '%zz'],
  email: ['"a b"@c.test', 'a@[1.2.3.4]', 'é@a.test', 'a..b@c.test', 'a@b.c'],
  hostname: ['xn--d1a.test', 'a_b.test', 'é.test', 'a.-b.test', 'a'.repeat(63)],
  ipv4: ['1.2.3', '255.255.255.255', '1.2.3.4 '],
  ipv6: ['::ffff:1.2.3.4', 'fe80::1%eth0', '1:2:3:4:5:6:7:8:9', ':::'],
  uuid: ['123E4567-E89B-12D3-A456-426614174000', '{123e4567-e89b-12d3-a456-426614174000}', '123e4567e89b12d3a456426614174000'],
  'json-pointer': ['/a~1b', '#/a', '/a~'],
};
// `n` arrays nested around `leaf`.
const nested = (n, leaf) => (n === 0 ? leaf : [nested(n - 1, leaf)]);
// A server a remote `$ref` names; every request it gets is counted, and the count recorded.
let remoteHits = 0;
const remoteServer = createServer((_, response) => {
  remoteHits += 1;
  response.end('{"type":"string"}');
});
await new Promise((done) => remoteServer.listen(0, '127.0.0.1', done));
const REMOTE = `http://127.0.0.1:${remoteServer.address().port}`;
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
  {
    name: 'whole results: every part in order, the error flag, structured content not shown',
    tools: [{ name: 'whole', inputSchema: input, outputSchema: { type: 'object', properties: { n: { type: 'number' } } } }],
    results: {
      whole: [
        { content: [...text('one'), { type: 'image', data: 'aGk=', mimeType: 'image/png' }, ...text('two')], structuredContent: { n: 1 } },
        { content: [...text('a'), ...text('b')], structuredContent: { n: 2 } },
        { content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }, ...text('failed')], structuredContent: { n: 'x' }, isError: true },
        { content: text('failed plainly'), structuredContent: { n: 'x' }, isError: true },
        { content: text('fine'), structuredContent: { n: 3 }, isError: false },
        { content: [...text('bad'), { type: 'image', data: 'aGk=', mimeType: 'image/png' }], structuredContent: { n: 'x' } },
      ],
    },
    calls: [0, 1, 2, 3, 4, 5].map((i) => ['whole', i]),
  },
  {
    name: 'format regex is a JavaScript regular expression without the u flag',
    tools: [{ name: 'rx', inputSchema: input, outputSchema: { type: 'object', properties: { v: { format: 'regex' } } } }],
    results: { rx: REGEX_FORMAT.map((v) => ({ content: text(v), structuredContent: { v } })) },
    calls: REGEX_FORMAT.map((_, i) => ['rx', i]),
  },
  {
    name: 'pattern matches as a JavaScript regular expression with the u flag',
    tools: PATTERNS.map(([pattern], k) => ({
      name: `p${k}`,
      inputSchema: input,
      outputSchema: { type: 'object', properties: { v: { type: 'string', pattern } } },
    })),
    results: Object.fromEntries(
      PATTERNS.map(([, values], k) => [`p${k}`, values.map((v) => ({ content: text(JSON.stringify(v)), structuredContent: { v } }))])
    ),
    calls: PATTERNS.flatMap(([, values], k) => values.map((_, i) => [`p${k}`, i])),
  },
  {
    name: 'patternProperties keys match as JavaScript regular expressions',
    tools: [
      {
        name: 'pp',
        inputSchema: input,
        outputSchema: { type: 'object', patternProperties: { '^\\d+$': { type: 'number' }, 'é\\b': { type: 'number' } }, additionalProperties: { type: 'string' } },
      },
    ],
    results: {
      pp: [
        { content: text('ascii digits'), structuredContent: { 12: 1 } },
        { content: text('arabic digits'), structuredContent: { '١٢': 'x' } },
        { content: text('boundary'), structuredContent: { éa: 1 } },
        { content: text('no boundary'), structuredContent: { éa: 'x', é: 'y' } },
      ],
    },
    calls: [0, 1, 2, 3].map((i) => ['pp', i]),
  },
  ...NOT_COMPILING.flatMap(([kind, schema]) => [
    {
      name: `a schema that does not compile (${kind}), without an $id: the other tool stays`,
      tools: [
        { name: 'fine', inputSchema: input, outputSchema: { type: 'object' } },
        { name: 'broken', inputSchema: input, outputSchema: schema },
      ],
      results: {
        fine: [{ content: text('fine'), structuredContent: {} }],
        broken: [{ content: text('plain') }, { content: text('x'), structuredContent: { v: 'a' } }],
      },
      calls: [['fine', 0], ['broken', 0], ['broken', 1]],
    },
    ...(schema && typeof schema === 'object' && !Array.isArray(schema)
      ? [
          {
            name: `a schema that does not compile (${kind}), with an $id: the listing`,
            tools: [
              { name: 'fine', inputSchema: input, outputSchema: { type: 'object' } },
              { name: 'broken', inputSchema: input, outputSchema: { $id: `https://example.test/${k(kind)}.json`, ...schema } },
            ],
            results: { fine: [{ content: text('fine'), structuredContent: {} }] },
            calls: [['fine', 0]],
          },
        ]
      : []),
  ]),
  {
    name: 'all errors, in the order Ajv reports them',
    tools: [{ name: 'many', inputSchema: input, outputSchema: ALL_ERRORS }],
    results: {
      many: [
        { content: text('bad'), structuredContent: { z: 'x', a: [1, 'b', 3, 'd'], m: { q: 1, p: 'x' }, extra: 1 } },
        { content: text('nothing'), structuredContent: {} },
      ],
    },
    calls: [['many', 0], ['many', 1]],
  },
  {
    name: 'format strictness',
    tools: Object.keys(STRICT_FORMATS).map((format) => ({
      name: `s_${format.replaceAll('-', '_')}`,
      inputSchema: input,
      outputSchema: { type: 'object', properties: { v: { format } } },
    })),
    results: Object.fromEntries(
      Object.entries(STRICT_FORMATS).map(([format, values]) => [
        `s_${format.replaceAll('-', '_')}`,
        values.map((v) => ({ content: text(JSON.stringify(v)), structuredContent: { v } })),
      ])
    ),
    calls: Object.entries(STRICT_FORMATS).flatMap(([format, values]) => values.map((_, i) => [`s_${format.replaceAll('-', '_')}`, i])),
  },
  {
    name: 'numbers: integers, large values',
    tools: [
      { name: 'int', inputSchema: input, outputSchema: { type: 'object', properties: { v: { type: 'integer' } } } },
      { name: 'mul', inputSchema: input, outputSchema: { type: 'object', properties: { v: { multipleOf: 3 } } } },
      { name: 'max', inputSchema: input, outputSchema: { type: 'object', properties: { v: { maximum: 9007199254740992 } } } },
    ],
    results: {
      int: [1, 1.5, 9007199254740994, 1e21, -0, 1e308].map((v) => ({ content: text(String(v)), structuredContent: { v } })),
      mul: [9007199254740994, 9007199254740995, 1e21, 0.30000000000000004].map((v) => ({ content: text(String(v)), structuredContent: { v } })),
      max: [9007199254740992, 9007199254740994].map((v) => ({ content: text(String(v)), structuredContent: { v } })),
    },
    calls: [...[0, 1, 2, 3, 4, 5].map((i) => ['int', i]), ...[0, 1, 2, 3].map((i) => ['mul', i]), ['max', 0], ['max', 1]],
  },
  {
    name: '$schema naming a later draft, and an unknown keyword',
    tools: [
      { name: 'd2019', inputSchema: input, outputSchema: { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object', properties: { v: { type: 'number' } } } },
      { name: 'd2020', inputSchema: input, outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', prefixItems: [{ type: 'number' }], properties: { v: { type: 'number' }, t: { prefixItems: [{ type: 'number' }] } } } },
      { name: 'unknown', inputSchema: input, outputSchema: { type: 'object', frobnicate: { type: 'string' }, properties: { v: { type: 'number', alsoUnknown: true } } } },
    ],
    results: {
      d2019: [{ content: text('x'), structuredContent: { v: 'x' } }],
      d2020: [{ content: text('t'), structuredContent: { v: 1, t: ['x'] } }],
      unknown: [{ content: text('ok'), structuredContent: { v: 1 } }, { content: text('bad'), structuredContent: { v: 'x' } }],
    },
    calls: [['d2019', 0], ['d2020', 0], ['unknown', 0], ['unknown', 1]],
  },
  {
    name: 'a reference to a remote address is never fetched',
    tools: [
      { name: 'fine', inputSchema: input, outputSchema: { type: 'object' } },
      { name: 'remote', inputSchema: input, outputSchema: { type: 'object', properties: { v: { $ref: `${REMOTE}/schema.json` } } } },
    ],
    results: { fine: [{ content: text('fine'), structuredContent: {} }] },
    calls: [['fine', 0]],
  },
  {
    name: 'recursive references and deep results',
    tools: [
      { name: 'tree', inputSchema: input, outputSchema: { type: 'object', properties: { v: { $ref: '#/definitions/node' } }, definitions: { node: { type: 'array', items: { $ref: '#/definitions/node' } } } } },
      { name: 'loop', inputSchema: input, outputSchema: { type: 'object', properties: { v: { $ref: '#/definitions/a' } }, definitions: { a: { $ref: '#/definitions/b' }, b: { $ref: '#/definitions/a' } } } },
      { name: 'self', inputSchema: input, outputSchema: { type: 'object', properties: { v: { $ref: '#' } } } },
      { name: 'endless', inputSchema: input, outputSchema: { type: 'object', allOf: [{ $ref: '#' }] } },
    ],
    results: {
      tree: [
        { content: text('100 deep'), structuredContent: { v: nested(100, []) } },
        { content: text('100 deep, bad leaf'), structuredContent: { v: nested(100, [1]) } },
      ],
      loop: [{ content: text('loop'), structuredContent: { v: 1 } }],
      self: [
        { content: text('self'), structuredContent: { v: { v: {} } } },
        { content: text('self, bad'), structuredContent: { v: { v: 1 } } },
      ],
      endless: [{ content: text('endless'), structuredContent: {} }],
    },
    calls: [['tree', 0], ['tree', 1], ['loop', 0], ['self', 0], ['self', 1], ['endless', 0]],
  },
];
const cases = CASES.filter((scenario) => !only || scenario.name === only);
if (!cases.length) throw new Error(`--only ${CASES.map((c) => c.name).join(' | ')}, got ${only}`);

async function record(scenario, index) {
  const scopeId = `case${index}`;
  const entry = { name: scenario.name, tools: scenario.tools, results: scenario.results, connect: null, outputs: [] };
  const hitsBefore = remoteHits;
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
  if (JSON.stringify(scenario.tools).includes(REMOTE)) Object.assign(entry, { remote: REMOTE, remoteHits: remoteHits - hitsBefore });
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
