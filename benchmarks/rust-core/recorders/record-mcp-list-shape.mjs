#!/usr/bin/env node
// Records what Node's MCP client does with a `tools/list` result that has no `tools` array (missing, an object, a string,
// null): at connect (the first page, or a later page of a paginated listing) and in the refresh after
// `notifications/tools/list_changed` (`client.mjs` `connectMcpServers`, `runToolRefresh`; `client-handshake.mjs`
// `listAllMcpTools`). Each case is a stdio server answering `tools/list` from `phases[n][cursor]` (n is the number of times
// the tool `poke` was called: that call answers, then announces `list_changed`).
// Recorded per case: the connect failure (`null` when it connected), what the session has after the connect (the server
// rows of `getMcpServerStatus` and the tools of `getMcpTools`), the lines Node wrote to stderr during the connect (`log`),
// and for a refresh case the same after the refresh settled (`refresh`). The refresh is awaited through the notification
// handler `client.mjs` registers (its promise is the refresh itself).
//
//   node benchmarks/rust-core/recorders/record-mcp-list-shape.mjs --tree <git archive export of b6f10295a> [--only <case name>]
//
// Output: native/core/fixtures/mcp-list-shape/golden.json (+ MANIFEST.json). With --only, that case is printed and nothing
// is written.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'mcp-list-shape-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
// The terminal UI sets this (`local-session-runtime.mjs`) to keep the log off its screen; the log is what is recorded, so
// it is off here whatever the caller's environment holds.
delete process.env.MIXDOG_QUIET_MCP_LOG;
const { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, orderedStringify, parseArgs, resolveTree, stageSet, within, writeJson, writeSetManifest } =
  await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-mcp-list-shape.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only') ?? null;
const identity = exactProductIdentity(tree, NODE_COMMIT);
const client = await importFrom(tree, 'src/runtime/agent/orchestrator/mcp/client.mjs');
const { Client } = await importFrom(tree, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');

// `client.mjs` registers one notification handler per connection (`tools/list_changed`) and its promise is the refresh:
// every handler is wrapped to say when its promise settled.
let handlerSettled = null;
const setNotificationHandler = Client.prototype.setNotificationHandler;
Client.prototype.setNotificationHandler = function wrapped(schema, handler) {
  return setNotificationHandler.call(this, schema, async (...handlerArgs) => {
    try {
      return await handler(...handlerArgs);
    } finally {
      handlerSettled?.();
    }
  });
};

// What Node writes to stderr (`mcpLog`), taken instead of written.
let log = [];
process.stderr.write = (chunk) => {
  log.push(String(chunk));
  return true;
};

// The server ends when its stdin closes (the client's disconnect, or this process ending).
const server = join(sandbox, 'server.mjs');
writeFileSync(
  server,
  `import { createInterface } from 'node:readline';
const scenario = JSON.parse(process.env.SCENARIO);
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let phase = 0;
const lines = createInterface({ input: process.stdin });
lines.on('close', () => process.exit(0));
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize')
    return send({ id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'case', version: '0' } } });
  if (message.method === 'tools/list') {
    const page = scenario.phases[Math.min(phase, scenario.phases.length - 1)];
    const cursor = message.params?.cursor ?? '';
    if (!(cursor in page)) return send({ id: message.id, error: { code: -32602, message: 'no such cursor ' + cursor } });
    return send({ id: message.id, result: page[cursor] });
  }
  if (message.method === 'tools/call' && message.params.name === 'poke') {
    send({ id: message.id, result: { content: [{ type: 'text', text: 'poked' }] } });
    phase += 1;
    return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\\n');
  }
  send({ id: message.id, error: { code: -32601, message: 'method not found' } });
});
`
);

const tool = (name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } });
const poke = tool('poke');
const BAD = { 'tools missing': {}, 'tools an object': { tools: {} }, 'tools a string': { tools: 'x' }, 'tools null': { tools: null }, 'tools a number': { tools: 5 }, 'tools a boolean': { tools: true } };
const CASES = [
  { name: 'good shape, one page', phases: [{ '': { tools: [poke, tool('a')] } }] },
  { name: 'good shape, two pages', phases: [{ '': { tools: [poke, tool('a')], nextCursor: 'c1' }, c1: { tools: [tool('b')] } }] },
  {
    name: 'good shape, refresh',
    phases: [{ '': { tools: [poke, tool('a')] } }, { '': { tools: [poke, tool('a'), tool('b')] } }],
    refresh: true,
  },
  {
    name: 'good shape, refresh over two pages',
    phases: [{ '': { tools: [poke, tool('a')] } }, { '': { tools: [poke, tool('b')], nextCursor: 'c1' }, c1: { tools: [tool('c')] } }],
    refresh: true,
  },
  ...Object.entries(BAD).flatMap(([kind, bad]) => [
    { name: `first page, ${kind}`, phases: [{ '': bad }] },
    { name: `second page, ${kind}`, phases: [{ '': { tools: [poke, tool('a')], nextCursor: 'c1' }, c1: bad }] },
    { name: `refresh first page, ${kind}`, phases: [{ '': { tools: [poke, tool('a')] } }, { '': bad }], refresh: true },
    {
      name: `refresh second page, ${kind}`,
      phases: [{ '': { tools: [poke, tool('a')] } }, { '': { tools: [poke, tool('b')], nextCursor: 'c1' }, c1: bad }],
      refresh: true,
    },
  ]),
];
const cases = CASES.filter((scenario) => !only || scenario.name === only);
if (!cases.length) throw new Error(`--only ${CASES.map((c) => c.name).join(' | ')}, got ${only}`);

// The server rows as the session shows them; `warnings`, `capabilities` and `transport` are the same in every case (no
// warning, tools only, stdio) and are left out (manifest `excluded`).
const snapshot = (scopeId) => ({
  status: client.getMcpServerStatus(scopeId).map(({ name, connected, toolCount, tools }) => ({ name, connected, toolCount, tools })),
  tools: client.getMcpTools(scopeId),
});

async function record(scenario, index) {
  const scopeId = `case${index}`;
  const entry = { name: scenario.name, phases: scenario.phases, connect: null };
  log = [];
  try {
    await within(
      `connecting ${scenario.name}`,
      client.connectMcpServers({ srv: { command: process.execPath, args: [server], env: { SCENARIO: JSON.stringify(scenario) } } }, { scopeId })
    );
  } catch (error) {
    if (!error.failures) throw error;
    entry.connect = error.failures[0].msg;
  }
  Object.assign(entry, snapshot(scopeId), { log });
  if (scenario.refresh) {
    log = [];
    const settled = new Promise((done) => {
      handlerSettled = done;
    });
    try {
      await within(`poking ${scenario.name}`, client.executeMcpTool('mcp__srv__poke', {}, { scopeId }));
      await within(`the refresh of ${scenario.name}`, settled);
      entry.refresh = { ...snapshot(scopeId), log };
    } finally {
      handlerSettled = null;
      await within(`disconnecting ${scenario.name}`, client.disconnectAll({ scopeId }));
    }
  } else {
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
    const finalDir = join(FIXTURES_ROOT, 'mcp-list-shape');
    const stage = stageSet(finalDir);
    writeJson(join(stage, 'golden.json'), { domain: 'mcp-list-shape', recorder, cases: recorded });
    writeSetManifest(stage, {
      set: 'mcp-list-shape',
      recorder,
      command: `node ${recorder} --tree <tree>`,
      identity,
      extra: {
        ...recorderProvenance(import.meta.url),
        excluded: [
          'cases[].status[] and cases[].refresh.status[]: warnings, capabilities and transport are left out of the rows; they are ' +
            'the same in every case (no warning, a tools-only server, stdio)',
          'the MIXDOG_QUIET_MCP_LOG variable is removed for the recording: the terminal UI sets it, which keeps every line of `log` ' +
            'off the screen there; the other front ends write them',
        ],
        mappings: {
          'cases[].log[] and cases[].refresh.log[]':
            'each string is one write to stderr and ends in one line feed; the core writes the same line as one log event whose ' +
            'writer ends the line, so the replay compares the event\'s message with the string less that one final line feed ' +
            '(a string that does not end in exactly one fails the replay)',
        },
      },
    });
    commitStage(stage, finalDir);
    process.stdout.write(`recorded ${recorded.length} cases\n`);
  }
} catch (error) {
  process.stdout.write(`${error?.stack ?? error}\n`);
  code = 1;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
// The SDK's stdio children read this process's pipes: ending it closes their stdin, which ends them.
process.exit(code);
