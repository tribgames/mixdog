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
const { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, orderedStringify, parseArgs, recordingProvenance, resolveTree, stageSet, within, writeJson, writeSetManifest } =
  await import('./lib/common.mjs');

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
      extra: recordingProvenance(recorder, ['benchmarks/rust-core/recorders/lib/common.mjs']),
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
