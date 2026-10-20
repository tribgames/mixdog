import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { waitUntil } from '../../../shared/wait-until.test-support.mjs';

process.env.MIXDOG_QUIET_MCP_LOG = '1';
const { connectMcpServers, disconnectAll, disconnectMcpServer, executeMcpTool, getMcpTools } = await import(
  './client.mjs'
);

// A real stdio server shaped like a wrapper chain: it keeps a grandchild alive
// and appends "<server pid> <grandchild pid>" to the file named by argv[2].
const dir = mkdtempSync(join(tmpdir(), 'mixdog-mcp-lifetime-'));
const serverScript = join(dir, 'server.mjs');
writeFileSync(
  serverScript,
  `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
appendFileSync(process.argv[2], process.pid + ' ' + grandchild.pid + '\\n');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } });
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'pid', inputSchema: { type: 'object', properties: {} } }] } });
  } else {
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: String(process.pid) }] } });
  }
});
`
);
after(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function serverConfig(extra = {}) {
  seq += 1;
  const pidFile = join(dir, `pids-${seq}.txt`);
  writeFileSync(pidFile, '');
  return { cfg: { command: process.execPath, args: [serverScript, pidFile], ...extra }, pidFile };
}
const spawned = (pidFile) =>
  readFileSync(pidFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => line.split(' ').map(Number));
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
const allGone = (pids) => waitUntil(() => pids.every((pid) => !alive(pid)), { timeoutMs: 20_000, intervalMs: 50 });
const callPid = (scopeId) => executeMcpTool('mcp__probe__pid', {}, { scopeId });

test('sessions connecting the same stdio server share one process tree', { timeout: 60_000 }, async () => {
  const { cfg, pidFile } = serverConfig();
  await connectMcpServers({ probe: cfg }, { scopeId: 'life-a' });
  await connectMcpServers({ probe: cfg }, { scopeId: 'life-b' });
  try {
    const pids = spawned(pidFile);
    assert.equal(pids.length, 2, 'one server process and its grandchild for both sessions');
    assert.equal(await callPid('life-a'), String(pids[0]));
    assert.equal(await callPid('life-b'), String(pids[0]));
  } finally {
    await disconnectAll({ scopeId: 'life-a' });
    await disconnectAll({ scopeId: 'life-b' });
  }
});

test('ending one session keeps the tree a live session uses; ending the last kills it', {
  timeout: 60_000,
}, async () => {
  const { cfg, pidFile } = serverConfig();
  await connectMcpServers({ probe: cfg }, { scopeId: 'end-a' });
  await connectMcpServers({ probe: cfg }, { scopeId: 'end-b' });
  const pids = spawned(pidFile);
  await disconnectAll({ scopeId: 'end-a' });
  assert.deepEqual(getMcpTools('end-a'), []);
  assert.ok(pids.every(alive), 'the other live session keeps its server');
  assert.equal(await callPid('end-b'), String(pids[0]));
  await disconnectAll({ scopeId: 'end-b' });
  await allGone(pids);
});

test('sessions with different resolved configs keep their own processes', { timeout: 60_000 }, async () => {
  const one = serverConfig();
  const two = serverConfig({ cwd: dir });
  await connectMcpServers({ probe: one.cfg }, { scopeId: 'own-a' });
  await connectMcpServers({ probe: two.cfg }, { scopeId: 'own-b' });
  const pidsA = spawned(one.pidFile);
  const pidsB = spawned(two.pidFile);
  await disconnectAll({ scopeId: 'own-a' });
  await allGone(pidsA);
  assert.ok(pidsB.every(alive));
  await disconnectAll({ scopeId: 'own-b' });
  await allGone(pidsB);
});

test('turning the server off in every session kills the shared tree', { timeout: 60_000 }, async () => {
  const { cfg, pidFile } = serverConfig();
  for (const scopeId of ['off-a', 'off-b', 'off-c']) await connectMcpServers({ probe: cfg }, { scopeId });
  const pids = spawned(pidFile);
  assert.equal(pids.length, 2);
  for (const scopeId of ['off-a', 'off-b', 'off-c'])
    assert.equal(await disconnectMcpServer('probe', { scopeId }), true);
  await allGone(pids);
});

test('a session reconnecting after its server died does not resurrect the dead one for others', {
  timeout: 60_000,
}, async () => {
  const { cfg, pidFile } = serverConfig();
  await connectMcpServers({ probe: cfg }, { scopeId: 'dead-a' });
  await connectMcpServers({ probe: cfg }, { scopeId: 'dead-b' });
  const [serverPid, grandchildPid] = spawned(pidFile);
  process.kill(serverPid);
  process.kill(grandchildPid);
  await allGone([serverPid, grandchildPid]);
  try {
    // The failed call reconnects; the replacement is shared with the next session.
    await callPid('dead-a').catch(() => {});
    await waitUntil(() => spawned(pidFile).length === 4, { timeoutMs: 20_000, intervalMs: 50 });
    const replacement = spawned(pidFile)[2];
    assert.equal(await callPid('dead-a'), String(replacement));
    await callPid('dead-b').catch(() => {});
    assert.equal(await callPid('dead-b'), String(replacement));
    assert.equal(spawned(pidFile).length, 4, 'the second session adopts the replacement');
  } finally {
    await disconnectAll({ scopeId: 'dead-a' });
    await disconnectAll({ scopeId: 'dead-b' });
  }
  await allGone(spawned(pidFile));
});
