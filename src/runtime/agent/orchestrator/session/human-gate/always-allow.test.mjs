import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentConnectorsApi } from '../../../../../session-runtime/workflow-agents-api/agent-connectors.mjs';
import {
  readConnectorsFile,
  setConnectorToolPermissionWriter,
  storedConnectorPolicy,
} from '../../mcp/agent-connectors.mjs';
import { ALLOW_NOT_SAVED_NOTICE, applyConnectorApproval } from '../loop/tool-exec/before-hook.mjs';
import { roomMemberSessionId } from '../agent-room.mjs';
import { setLiveSession } from '../store.mjs';
import { setUnattendedApprovalPort } from './gate.mjs';
import { ACTION_KINDS } from './outbound-policy.mjs';
import { createHumanGateStore, recordAgentApprovalAudit, setHumanGateStore } from './store.mjs';

// Bots are `kind: bot` definitions in a throwaway data dir; `helper` is a workflow agent.
const dataRoot = mkdtempSync(join(tmpdir(), 'always-allow-data-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
const TOOL = 'mcp__alpha__write_it';
const agentFile = (id) => join(dataRoot, 'agents', id, 'agent.json');
for (const [id, kind] of [
  ['mailer', 'bot'],
  ['inspector', 'bot'],
  ['helper', 'agent'],
]) {
  mkdirSync(join(dataRoot, 'agents', id), { recursive: true });
  writeFileSync(join(dataRoot, 'agents', id, 'AGENT.md'), `---\nkind: ${kind}\n---\nYou are ${id}.\n`);
}
const setPolicy = (id, permission) =>
  writeFileSync(
    agentFile(id),
    JSON.stringify({ name: id, connectors: { off: [], tools: { alpha: { write_it: permission } } } })
  );
const toolPermission = (id) => readConnectorsFile(agentFile(id))?.tools?.alpha?.write_it;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

// The agent editor, reduced to the file it writes (it keeps the other agent.json keys).
const editor = {
  getAgentConnectorPolicy: (id) => readConnectorsFile(agentFile(id)),
  async setAgentConnectorPolicy(id, connectors) {
    const manifest = JSON.parse(readFileSync(agentFile(id), 'utf8'));
    manifest.connectors = storedConnectorPolicy(connectors) ?? undefined;
    writeFileSync(agentFile(id), JSON.stringify(manifest));
    return readConnectorsFile(agentFile(id));
  },
};
const api = createAgentConnectorsApi({ mcpStatus: () => ({ servers: [] }), getMcpTools: () => [] }, editor);

/** One tool call by `agentId`'s session; `answer` plays the card. */
function run(agentId, sessionId, answer) {
  const asked = [];
  const result = applyConnectorApproval(
    { name: TOOL, args: {}, cwd: '/tmp' },
    {
      agentId,
      callerSessionId: sessionId,
      executeOpts: {},
      toolApprovalHook: async (request) => {
        asked.push(request);
        return answer(request);
      },
    }
  );
  return Promise.resolve(result).then((outcome) => ({ outcome, asked }));
}
const always = () => ({ approved: true, response: 'approve', remember: 'agent' });
const once = () => ({ approved: true, response: 'approve', remember: 'once' });

test('always allow on a connector tool is kept for that bot and skips its next prompt', async () => {
  setPolicy('mailer', 'needs_approval');
  const first = await run('mailer', 'sess_home_mailer', always);
  assert.equal(first.outcome, null);
  assert.equal(first.asked.length, 1);
  assert.deepEqual(first.asked[0].remember, ['once', 'agent']);
  assert.equal(first.asked[0].agentId, 'mailer');
  assert.equal(toolPermission('mailer'), 'auto', 'saved in the bot own connector policy');
  const next = await run('mailer', 'sess_home_mailer', () => assert.fail('no prompt'));
  assert.equal(next.outcome, null);
  assert.deepEqual(next.asked, []);
  assert.deepEqual(api.getAgentAlwaysAllowedTools('mailer'), [{ connector: 'alpha', tool: 'write_it' }]);
});

test('another bot is still asked, and a one-time allow stores nothing', async () => {
  setPolicy('inspector', 'needs_approval');
  const other = await run('inspector', 'sess_home_inspector', once);
  assert.equal(other.asked.length, 1);
  assert.equal(toolPermission('inspector'), 'needs_approval');
  assert.deepEqual(api.getAgentAlwaysAllowedTools('inspector'), []);
  const again = await run('inspector', 'sess_home_inspector', once);
  assert.equal(again.asked.length, 1, 'once allows only that call');
});

test('turning an allowed tool back to ask restores the prompt', async () => {
  assert.equal(toolPermission('mailer'), 'auto');
  await api.setAgentConnectorToolPermission('mailer', 'alpha', 'write_it', 'needs_approval');
  assert.deepEqual(api.getAgentAlwaysAllowedTools('mailer'), []);
  const asked = await run('mailer', 'sess_home_mailer', once);
  assert.equal(asked.asked.length, 1);
});

test('only a contact bot in its own chat can be given an always allow', async () => {
  mkdirSync(join(dataRoot, 'agents', 'lead'), { recursive: true });
  setPolicy('helper', 'needs_approval');
  setPolicy('lead', 'needs_approval');
  // Mixy in her own home asks, but is offered no remember scope.
  const mixy = await run('lead', 'sess_home_lead', always);
  assert.equal(mixy.asked.length, 1, 'Mixy in her home asks');
  assert.equal(mixy.asked[0].remember, undefined, 'and is offered no remember scope');
  assert.equal(toolPermission('lead'), 'needs_approval', 'nothing was saved');
  // Only a bot's own sessions ask: a workflow agent (even in a session named for
  // it) and a coding Lead's session run the connector tool unasked.
  for (const [agent, session] of [
    ['helper', 'sess_home_helper'],
    ['helper', 'sess_desktop_coding'],
    ['lead', 'sess_desktop_coding'],
  ]) {
    const { outcome, asked } = await run(agent, session, () => assert.fail('no card'));
    assert.deepEqual(asked, [], `${agent} in ${session} is not asked`);
    assert.equal(outcome, null, `${agent} in ${session} runs the tool`);
  }
  assert.equal(toolPermission('helper'), 'needs_approval', 'nothing was saved');
  // A bot asking from another bot's session cannot write its own entry either.
  setPolicy('mailer', 'needs_approval');
  await run('mailer', 'sess_home_inspector', always);
  assert.equal(toolPermission('mailer'), 'needs_approval');
  assert.equal(toolPermission('inspector'), 'needs_approval');
});

test('a room member is offered always allow like the home chat; a schedule run never asks and stores none', async () => {
  const member = roomMemberSessionId('room123abc', 'mailer');
  assert.ok(member, 'a room member session id');
  setPolicy('mailer', 'needs_approval');
  setUnattendedApprovalPort({
    runOf: (sessionId) =>
      sessionId === 'sess_schedule_run' ? { kind: 'schedule', agentId: 'mailer', name: 'Daily' } : null,
    hold: async (request) => {
      held.push(request);
      return always();
    },
  });
  const held = [];
  try {
    const room = await run('mailer', member, always);
    assert.equal(room.asked.length, 1);
    assert.deepEqual(room.asked[0].remember, ['once', 'agent']);
    assert.equal(toolPermission('mailer'), 'auto', "saved in the bot's own policy, as from the home chat");
    setPolicy('mailer', 'needs_approval');
    // Saving the schedule was the grant: the run is neither asked nor held.
    const schedule = await run('mailer', 'sess_schedule_run', () => assert.fail('a run has no card'));
    assert.deepEqual(held, []);
    assert.equal(schedule.outcome, null, 'the call runs');
    assert.equal(toolPermission('mailer'), 'needs_approval', 'the run saved nothing');
  } finally {
    setUnattendedApprovalPort(null);
  }
});

test('connector approval is for a bot own session only: sub-agents and task sessions run unasked, run work follows run policy', async () => {
  const member = roomMemberSessionId('room123abc', 'mailer');
  setPolicy('helper', 'needs_approval');
  setPolicy('mailer', 'needs_approval');
  const child = (id, parent, extra = {}) =>
    setLiveSession({
      id,
      owner: 'agent',
      agent: 'helper',
      visibility: 'agent-only',
      parentSessionId: parent,
      ownerSessionId: parent,
      createdAt: Date.now(),
      ...extra,
    });
  setLiveSession({ id: 'sess_conn_lead', owner: 'cli', agent: 'lead', createdAt: Date.now() });
  child('sess_conn_leadsub', 'sess_conn_lead');
  child('sess_conn_homesub', 'sess_home_mailer');
  child('sess_conn_roomsub', member);
  child('sess_conn_runsub', 'sess_home_mailer', { run: { kind: 'schedule', agentId: 'mailer', name: 'Daily' } });
  for (const [agent, session] of [
    ['helper', 'sess_conn_lead'],
    ['helper', 'sess_conn_leadsub'],
    ['helper', 'sess_conn_homesub'],
    ['mailer', 'sess_conn_homesub'],
    ['helper', 'sess_conn_roomsub'],
  ]) {
    const { outcome, asked } = await run(agent, session, () => assert.fail('no card'));
    assert.deepEqual(asked, [], `${agent} in ${session} is not asked`);
    assert.equal(outcome, null, `${agent} in ${session} runs the tool`);
  }
  // A bot's own seats still ask.
  for (const session of ['sess_home_mailer', member]) {
    assert.equal((await run('mailer', session, once)).asked.length, 1, session);
  }
  // Work a run started is answered by run policy: allowed, no card, nothing stored.
  setUnattendedApprovalPort({
    runOf: (id) => (id === 'sess_conn_runsub' ? { kind: 'schedule', agentId: 'mailer', name: 'Daily' } : null),
    hold: async () => assert.fail('a run is never held'),
  });
  try {
    const out = await run('helper', 'sess_conn_runsub', () => assert.fail('a run has no card'));
    assert.equal(out.outcome, null);
    assert.deepEqual(out.asked, []);
    assert.equal(toolPermission('helper'), 'needs_approval');
  } finally {
    setUnattendedApprovalPort(null);
  }
});

test('a failed save runs the call once, tells the person, and asks again next time', async () => {
  setPolicy('inspector', 'needs_approval');
  setConnectorToolPermissionWriter(async () => {
    throw new Error('disk full');
  });
  const notices = [];
  try {
    const hook = Object.assign(async () => always(), { notice: (text, tone) => notices.push([text, tone]) });
    const outcome = await applyConnectorApproval(
      { name: TOOL, args: {}, cwd: '/tmp' },
      { agentId: 'inspector', callerSessionId: 'sess_home_inspector', executeOpts: {}, toolApprovalHook: hook }
    );
    assert.equal(outcome, null, 'this call still runs');
    assert.deepEqual(notices, [[ALLOW_NOT_SAVED_NOTICE, 'warn']]);
    assert.equal(toolPermission('inspector'), 'needs_approval');
  } finally {
    createAgentConnectorsApi({ mcpStatus: () => ({ servers: [] }), getMcpTools: () => [] }, editor);
  }
  assert.equal((await run('inspector', 'sess_home_inspector', once)).asked.length, 1);
});

test('browser approvals are audited by bot and kind, without any page detail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'always-allow-audit-'));
  setHumanGateStore(createHumanGateStore(dir));
  try {
    await recordAgentApprovalAudit('mailer', 'browser_submit', 'granted');
    await recordAgentApprovalAudit('mailer', 'browser_submit', 'remembered');
    await assert.rejects(recordAgentApprovalAudit('mailer', 'browser_submit', 'whatever'), /decision/);
    await assert.rejects(recordAgentApprovalAudit('mailer', 'nope', 'approve'), /action/);
    const rows = await createHumanGateStore(dir).readAudit({ agentId: 'mailer' });
    assert.deepEqual(
      rows.map((row) => [row.kind, row.action, row.decision, row.target, row.device]),
      [
        ['browser', 'browser_submit', 'remembered', '', ''],
        ['browser', 'browser_submit', 'granted', '', ''],
      ]
    );
  } finally {
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('browser action kinds are separate per-bot grants in the permission store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'always-allow-store-'));
  try {
    const store = createHumanGateStore(dir);
    assert.ok(ACTION_KINDS.includes('browser_submit') && ACTION_KINDS.includes('browser_post'));
    await store.setMode({ agentId: 'mailer', action: 'browser_submit', mode: 'allow' });
    assert.equal(await store.modeFor({ agentId: 'mailer', action: 'browser_submit' }), 'allow');
    assert.equal(await store.modeFor({ agentId: 'mailer', action: 'browser_post' }), 'ask', 'a different kind');
    assert.equal(await store.modeFor({ agentId: 'inspector', action: 'browser_submit' }), 'ask', 'a different bot');
    // It survives a restart (a new store over the same file) and is listed for the profile.
    const reopened = createHumanGateStore(dir);
    assert.equal(await reopened.modeFor({ agentId: 'mailer', action: 'browser_submit' }), 'allow');
    const row = (await reopened.permissions('mailer')).find((entry) => entry.action === 'browser_submit');
    assert.deepEqual({ mode: row.mode, rememberable: row.rememberable }, { mode: 'allow', rememberable: true });
    await reopened.setMode({ agentId: 'mailer', action: 'browser_submit', mode: 'ask' });
    assert.equal(await reopened.modeFor({ agentId: 'mailer', action: 'browser_submit' }), 'ask');
    // Payments and permanent deletes still cannot be allowed in advance.
    assert.equal(await reopened.setMode({ agentId: 'mailer', action: 'payment', mode: 'allow' }), null);
    // File uploads are a third rememberable kind, separate from submit and post.
    assert.ok(ACTION_KINDS.includes('browser_upload'));
    await reopened.setMode({ agentId: 'mailer', action: 'browser_upload', mode: 'allow' });
    assert.equal(await reopened.modeFor({ agentId: 'mailer', action: 'browser_upload' }), 'allow');
    assert.equal(await reopened.modeFor({ agentId: 'mailer', action: 'browser_submit' }), 'ask');
    assert.equal(await reopened.modeFor({ agentId: 'inspector', action: 'browser_upload' }), 'ask');
    const upload = (await createHumanGateStore(dir).permissions('mailer')).find((e) => e.action === 'browser_upload');
    assert.deepEqual({ mode: upload.mode, rememberable: upload.rememberable }, { mode: 'allow', rememberable: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
