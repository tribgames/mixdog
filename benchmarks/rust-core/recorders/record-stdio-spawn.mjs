#!/usr/bin/env node
// Records how Node starts a stdio MCP server and what it says when the server cannot start or ends:
//  - `parse`: cross-spawn 7.0.6's `_parse` (what the SDK's `StdioClientTransport` spawns through) for commands over a fixture
//    tree: which file a command resolves to, when it runs through `%COMSPEC% /d /s /c "<line>"`, and how the line is escaped.
//    PATHEXT, COMSPEC and the process's directory are set to the values written in the recording.
//  - `connect`: the real `connectMcpServers` / `getMcpServerStatus` (client.mjs, the SDK's stdio transport) over servers that
//    cannot start, exit before they answer, never answer, or answer and then die: the failure text each ends with.
// Windows only: the unresolved-command case is cmd.exe's own message, in the language of the machine that recorded it.
//
//   node benchmarks/rust-core/recorders/record-stdio-spawn.mjs --tree <git clone at b6f10295a with node_modules>
//
// Output: native/core/fixtures/stdio-spawn/golden.json (+ MANIFEST.json).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
if (process.platform !== 'win32') throw new Error('the recording is of the Windows branch of cross-spawn: run it on Windows');
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'stdio-spawn-')));
for (const key of ['APPDATA', 'LOCALAPPDATA', 'HOME', 'USERPROFILE', 'MIXDOG_DESKTOP_USER_DATA', 'MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a2f698afc85332467192de28500bd146^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const finalDir = join(FIXTURES_ROOT, 'stdio-spawn');
const stage = stageSet(finalDir);
const crossSpawn = createRequire(join(tree, 'package.json'))('cross-spawn');

// ---- parse: the fixture tree and the commands run over it -----------------------------------------------------------
const ROOT = join(sandbox, 'root');
const PATHEXT = '.COM;.EXE;.BAT;.CMD';
const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
const FILES = [
  { path: 'bin/tool.exe', text: '' },
  { path: 'bin/tool.cmd', text: '' },
  { path: 'bin/both.cmd', text: '' },
  { path: 'bin/both.com', text: '' },
  { path: 'bin/shimmed.cmd', text: '' },
  { path: 'bin/plain', text: 'not a program' },
  { path: 'bin/node.exe', text: '' },
  { path: 'bin/script.js', text: '#!/usr/bin/env node\nconsole.log(1)\n' },
  { path: 'bin/shellscript', text: '#!/bin/sh -e\necho 1\n' },
  { path: 'bin/lost', text: '#!/usr/bin/python3\nprint(1)\n' },
  { path: 'bin/envonly', text: '#!/usr/bin/env\n' },
  { path: 'other/local.exe', text: '' },
  { path: 'work/here.exe', text: '' },
  { path: 'work/node_modules/.bin/shim.cmd', text: '' },
];
const ARGS = ['--flag', 'a b', 'say "hi"', 'C:\\dir\\', 'back\\"slash', '%PATH%', '^&|<>', '', 'trail\\\\', 'x"', '\\"', '(paren)!', 'tick`', 'wild*?', 'semi;comma,'];
const BIN = `${ROOT}\\bin`;
const CASES = [
  { name: 'exe-by-name', command: 'tool', args: ['a'], path: BIN },
  { name: 'exe-with-extension', command: 'tool.exe', args: ['a b'], path: BIN },
  { name: 'pathext-order-picks-com', command: 'both', args: [], path: BIN },
  { name: 'cmd-script', command: 'shimmed', args: ['x'], path: BIN },
  { name: 'unresolved', command: 'harness-no-such-command', args: [], path: BIN },
  { name: 'unresolved-with-arguments', command: 'harness-no-such-command', args: ARGS, path: BIN },
  { name: 'extensionless-file', command: 'plain', args: ['x'], path: BIN },
  { name: 'shebang-env-node', command: 'script.js', args: ['--port', '1'], path: BIN, viaShebang: true },
  { name: 'shebang-with-argument', command: 'shellscript', args: [], path: BIN, viaShebang: true },
  { name: 'shebang-interpreter-missing', command: 'lost', args: ['x'], path: BIN, viaShebang: true },
  { name: 'shebang-env-without-program', command: 'envonly', args: [], path: BIN, viaShebang: true },
  { name: 'forward-slash-path', command: '{root}/bin/tool.exe', args: ['x'], path: BIN },
  { name: 'relative-path-in-cwd', command: './bin/tool.exe', args: [], path: BIN, cwd: '{root}' },
  { name: 'process-directory-first', command: 'here', args: [], path: BIN },
  { name: 'custom-cwd-first', command: 'local', args: [], path: BIN, cwd: '{root}/other' },
  { name: 'custom-cwd-missing', command: 'tool', args: [], path: BIN, cwd: '{root}/missing' },
  { name: 'quoted-path-entry', command: 'tool', args: [], path: `"${BIN}"` },
  { name: 'path-empty-falls-back-to-process', command: 'tool', args: [], path: '', processPath: BIN },
  { name: 'cmd-shim-double-escape', command: '{root}\\work\\node_modules\\.bin\\shim.cmd', args: ['a&b', 'say "hi"', 'plain'], path: BIN },
  { name: 'command-with-spaces', command: '{root}\\program files\\x y', args: ['z'], path: BIN },
];
const expand = (text) => text.split('{root}').join(ROOT);
for (const file of FILES) {
  const full = join(ROOT, ...file.path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, file.text);
}
const realPathext = process.env.PATHEXT;
const realComspec = process.env.COMSPEC;
process.env.PATHEXT = PATHEXT;
process.env.COMSPEC = COMSPEC;
const realPath = process.env.PATH;
const processCwd = join(ROOT, 'work');
process.chdir(processCwd);
const mask = (text) => text.split(ROOT).join('<ROOT>');
const parse = CASES.map((c) => {
  process.env.PATH = c.processPath ?? realPath;
  const options = { env: { PATH: c.path } };
  if (c.cwd) options.cwd = expand(c.cwd);
  const parsed = crossSpawn._parse(expand(c.command), c.args, options);
  const shell = parsed.options.windowsVerbatimArguments === true;
  return {
    name: c.name,
    command: c.command.split('{root}').join('<ROOT>'),
    args: c.args,
    cwd: c.cwd ? c.cwd.split('{root}').join('<ROOT>') : null,
    path: mask(c.path),
    processPath: c.processPath ? mask(c.processPath) : null,
    launch: shell
      ? { kind: 'shell', file: parsed.command, args: parsed.args.map(mask) }
      : { kind: 'direct', shown: mask(parsed.command), args: parsed.args.map(mask), ...(c.viaShebang ? {} : { program: mask(parsed.file) }) },
  };
});
process.env.PATH = realPath;
process.chdir(sandbox);
process.env.PATHEXT = realPathext;
process.env.COMSPEC = realComspec;

// ---- connect: the real client over servers that do not simply work -----------------------------------------------------
const orch = 'src/runtime/agent/orchestrator/';
const { connectMcpServers, disconnectAll, getMcpServerStatus } = await importFrom(tree, `${orch}mcp/client.mjs`);
const EXIT_WITH_STDERR = "process.stderr.write('fatal: out of cheese\\n'); process.exit(1);";
const NEVER_ANSWERS = "process.stderr.write('still installing deps...\\n'); setInterval(() => {}, 1000);";
const ANSWERS_THEN_DIES = `
let buffered = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  for (let end = buffered.indexOf('\\n'); end >= 0; end = buffered.indexOf('\\n')) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'crashy', version: '1' } } });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
      setTimeout(() => { process.stderr.write('crashing on purpose\\n'); process.exit(1); }, 200);
    }
  }
});`;
const SERVERS = [
  { name: 'exits-with-stderr', entry: { type: 'stdio', command: 'node', args: ['-e', EXIT_WITH_STDERR] } },
  { name: 'unresolved-command', entry: { type: 'stdio', command: 'harness-no-such-command' }, localeBound: true },
  { name: 'missing-cwd', entry: { type: 'stdio', command: 'node', args: ['-e', '0'], cwd: '{root}/missing' } },
  { name: 'never-answers', entry: { type: 'stdio', command: 'node', args: ['-e', NEVER_ANSWERS], startupTimeoutMs: 2500 } },
  { name: 'answers-then-dies', entry: { type: 'stdio', command: 'node', args: ['-e', ANSWERS_THEN_DIES] }, afterReady: true },
];
let scope = 0;
const connect = [];
for (const server of SERVERS) {
  scope += 1;
  const scopeId = `stdio-spawn-${scope}`;
  const entry = { ...server.entry, ...(server.entry.cwd ? { cwd: expand(server.entry.cwd) } : {}) };
  let failure = null;
  try {
    await connectMcpServers({ [server.name]: entry }, { scopeId });
  } catch (error) {
    if (error.failures?.length !== 1) throw error;
    failure = error.failures[0].msg;
  }
  const outcome = { name: server.name, entry: JSON.parse(JSON.stringify(server.entry).split('{root}').join('<ROOT>')), localeBound: server.localeBound === true, failure };
  if (server.afterReady) {
    if (failure !== null) throw new Error(`${server.name} must connect: ${failure}`);
    for (let waited = 0; getMcpServerStatus(scopeId)[0].connected; waited += 25) {
      if (waited > 10_000) throw new Error('the server did not die');
      await sleep(25);
    }
    const [row] = getMcpServerStatus(scopeId);
    outcome.status = { connected: row.connected, error: row.error };
  } else if (failure === null) throw new Error(`${server.name} must fail to connect`);
  await disconnectAll({ scopeId });
  connect.push(outcome);
}

writeJson(join(stage, 'golden.json'), {
  domain: 'stdio-spawn',
  recorder: 'benchmarks/rust-core/recorders/record-stdio-spawn.mjs',
  host: { pathext: PATHEXT, comspec: COMSPEC, processCwd: '<ROOT>/work' },
  files: FILES,
  parse,
  connect,
});
writeSetManifest(stage, {
  set: 'stdio-spawn',
  recorder: 'benchmarks/rust-core/recorders/record-stdio-spawn.mjs',
  command: 'node benchmarks/rust-core/recorders/record-stdio-spawn.mjs --tree <tree>',
  identityTree: tree,
  identityRef: NODE_COMMIT,
});
commitStage(stage, finalDir);
console.log(`recorded ${parse.length} cross-spawn parses and ${connect.length} stdio servers`);
process.exit(0);
