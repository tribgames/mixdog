// Records the Node twin of the `terminal` tool into terminal-bridge.json, the golden file
// tests/terminal.rs replays against the Rust bridge. Run from the repository root:
//   apps/desktop/node_modules/.bin/tsx native/mixdog-spawn/tests/fixtures/record-terminal-bridge.mjs
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeTerminalTool, validateTerminalArgs } from '../../../../src/runtime/terminal-bridge/client.mjs';
import { createTerminalCommandExecutor } from '../../../../apps/desktop/src/main/terminal/commands.ts';

const here = dirname(fileURLToPath(import.meta.url));
delete process.env.MIXDOG_TOOL_OUTPUT_MAX_BYTES;

async function withBridge(reply, run) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-terminal-fixture-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  delete process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await writeFile(
    join(directory, 'terminal-bridge.json'),
    JSON.stringify({ version: 1, port: server.address().port, token: 'secret', pid: process.pid })
  );
  try {
    return await run();
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const tabValue = (extra = {}) => ({
  id: 'session-terminal:sess',
  tab: 1,
  shell: 'pwsh',
  running: true,
  cwd: 'C:\\work',
  cursor: 4200,
  reset: false,
  ...extra,
});

const longLine = 'x'.repeat(620);
const many = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\r\n');
const repeated = `${Array.from({ length: 25 }, () => 'same').join('\r\n')}\r\ntail\r\n`;
const big = Array.from({ length: 400 }, (_, i) => `row ${String(i).padStart(3, '0')} ${'y'.repeat(300)}`).join('\r\n');

// [args, reply value]
const clientCases = [
  [{ action: 'list' }, { tabs: [] }],
  [{ action: 'list' }, { tabs: [{ tab: 1, shell: 'pwsh', running: true, cwd: 'C:\\work' }, { tab: 2, shell: 'bash', running: false, cwd: null }] }],
  [{ action: 'read' }, tabValue({ raw: 'hello\r\nworld\r\n' })],
  [{ action: 'read' }, tabValue({ raw: '' })],
  [{ action: 'read', since: 4000 }, tabValue({ raw: '' })],
  [{ action: 'read', since: '4000' }, tabValue({ raw: 'new output\r\n' })],
  [{ action: 'read', lines: 5 }, tabValue({ raw: many })],
  [{ action: 'read', lines: 5000 }, tabValue({ raw: many })],
  [{ action: 'read', lines: 3, offset_lines: 4 }, tabValue({ raw: many })],
  [{ action: 'read', grep: 'LINE 1', lines: 2 }, tabValue({ raw: many })],
  [{ action: 'read', grep: 'nothing here' }, tabValue({ raw: many })],
  [{ action: 'read', grep: 'line 2', offset_lines: 3 }, tabValue({ raw: many })],
  [{ action: 'read' }, tabValue({ raw: '\u001b[31mred\u001b[0m \u001b]0;title\u0007plain \u001bP1;2|x\u001b\\end\r\n', reset: true })],
  [{ action: 'read' }, tabValue({ raw: 'progress 10%\rprogress 50%\rprogress 100%\r\ndone\r\n' })],
  [{ action: 'read' }, tabValue({ raw: 'abc\b\bd\r\nline\u0000with\u0007ctl   \r\n\r\n\r\n\r\nafter\r\n' })],
  [{ action: 'read', lines: 400 }, tabValue({ raw: repeated })],
  [{ action: 'read' }, tabValue({ raw: `${longLine}\r\nshort\r\n` })],
  [{ action: 'read', lines: 400 }, tabValue({ raw: big })],
  [{ action: 'read', tab: 2 }, tabValue({ tab: 2, id: 'session-terminal:sess:2', raw: 'two\r\n', running: false, cwd: null })],
  [{ action: 'run', command: 'echo hi' }, tabValue({ shown: true })],
  [{ action: 'run', tab: '2', command: 'echo hi' }, tabValue({ tab: 2, shown: false })],
  [{ action: 'run', command: 'echo hi' }, tabValue({})],
];

const invalidArgs = [
  null,
  [],
  'list',
  {},
  { action: 'jump' },
  { action: 'list', tab: 1 },
  { action: 'list', since: 1 },
  { action: 'list', bogus: 1 },
  { action: 'list', zeta: 1, alpha: 2, mid: 3 },
  { zulu: 1, action: 'read', beta: 2 },
  { action: 'read', tab: 0 },
  { action: 'read', tab: 1000 },
  { action: 'read', tab: 'x' },
  { action: 'read', lines: 0 },
  { action: 'read', lines: 1.5 },
  { action: 'read', since: -1 },
  { action: 'read', since: 'abc' },
  { action: 'read', offset_lines: -1 },
  { action: 'read', grep: '' },
  { action: 'read', grep: 'a\nb' },
  { action: 'read', grep: 5 },
  { action: 'read', since: 1, grep: 'x' },
  { action: 'read', since: 1, offset_lines: 1 },
  { action: 'read', command: 'ls' },
  { action: 'run' },
  { action: 'run', command: '  ' },
  { action: 'run', command: 'ls', lines: 3 },
  { action: 'run', command: 'x'.repeat(8001) },
  { action: 'run', command: 'ls', tab: 1.5 },
];

const validCases = [
  { action: 'list' },
  { action: 'read' },
  { action: 'read', tab: '3', lines: '7', since: '9', },
  { action: 'read', lines: 99999 },
  { action: 'read', grep: '  needle  ', offset_lines: 10000000 },
  { action: 'run', command: 'x'.repeat(8000) },
  { action: 'run', tab: 2, command: 'ls' },
];

const recorded = { client: [], validate: [], commands: [] };

for (const [args, value] of clientCases) {
  const result = await withBridge({ ok: true, body: undefined, value }, () =>
    executeTerminalTool(args, { sessionId: 'sess' })
  );
  recorded.client.push({ args, value, text: result.content[0].text, isError: result.isError === true });
}

for (const args of [...invalidArgs, ...validCases]) {
  recorded.validate.push({ args, result: validateTerminalArgs(args) });
}

// commands.ts over a scripted backend.
const tabs = [
  { tab: 1, id: 'session-terminal:sess', shell: 'pwsh', running: true, cwd: 'C:\\work' },
  { tab: 2, id: 'session-terminal:sess:2', shell: 'bash', running: false, cwd: null },
];
const snapshots = {
  'session-terminal:sess': { text: 'one\r\ntwo\r\n', cursor: 100, reset: false },
  'session-terminal:sess:2': { text: 'other', cursor: 7, reset: true },
};
const commandCases = [
  { command: { action: 'list', session_id: 'sess' }, tabs },
  { command: { action: 'list', session_id: 'sess' }, tabs: [] },
  { command: { action: 'list', session_id: 'bad id' }, tabs },
  { command: { action: 'read', session_id: 'sess' }, tabs },
  { command: { action: 'read', session_id: 'sess', tab: 2 }, tabs },
  { command: { action: 'read', session_id: 'sess', tab: 5 }, tabs },
  { command: { action: 'read', session_id: 'sess', since: 3 }, tabs },
  { command: { action: 'read', session_id: 'sess' }, tabs: [] },
  { command: { action: 'read', session_id: 'sess' }, tabs, snapshots: {} },
  { command: { action: 'run', session_id: 'sess', command: 'echo a' }, tabs, shown: true },
  { command: { action: 'run', session_id: 'sess', tab: 2, command: 'echo a\r\nb\n\n' }, tabs, shown: false },
  { command: { action: 'run', session_id: 'sess', tab: 9, command: 'echo a' }, tabs },
  { command: { action: 'run', session_id: 'sess', tab: 3, command: 'echo a' }, tabs: [] },
  { command: { action: 'run', session_id: 'sess', command: 'echo a' }, tabs: [], start: tabs[0], shown: true },
  { command: { action: 'run', session_id: 'sess', command: 'echo a' }, tabs, snapshots: {} },
];
for (const spec of commandCases) {
  const writes = [];
  const backend = {
    sessionTabs: () => spec.tabs,
    write: (id, data) => {
      writes.push([id, data]);
    },
    startTerminal: () => spec.start,
    revealTerminal: () => spec.shown === true,
    snapshot: (id) => (spec.snapshots ?? snapshots)[id] ?? null,
  };
  let value = null;
  let error = null;
  try {
    value = await createTerminalCommandExecutor(backend)(spec.command);
  } catch (caught) {
    error = caught.message;
  }
  recorded.commands.push({
    command: spec.command,
    tabs: spec.tabs,
    snapshots: spec.snapshots ?? snapshots,
    start: spec.start ?? null,
    shown: spec.shown === true,
    value,
    error,
    writes,
  });
}

writeFileSync(join(here, 'terminal-bridge.json'), `${JSON.stringify(recorded, null, 1)}\n`);
console.log(
  `recorded ${recorded.client.length} client, ${recorded.validate.length} validate, ${recorded.commands.length} command cases`
);
