import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentConnectorsApi } from '../workflow-agents-api/agent-connectors.mjs';
import {
  CONNECTOR_POLICY_WIDENS,
  NO_WIDEN_MESSAGE,
  assertConnectorPolicyNotWidened,
  connectorToolPermission,
  readConnectorsFile,
  withApprovedConnectorToolChange,
  storedConnectorPolicy,
} from '../../runtime/agent/orchestrator/mcp/agent-connectors.mjs';
import { createHumanGateStore, setHumanGateStore } from '../../runtime/agent/orchestrator/session/human-gate/store.mjs';
import { createToolApproval } from '../../tui/session/tool-approval.mjs';
import { AGENT_SETTINGS_HANDLERS } from './agent-settings-actions.mjs';

// A bot (`kind: bot`) in a throwaway data dir; the editor is reduced to the file it writes.
const dataRoot = mkdtempSync(join(tmpdir(), 'connector-widen-data-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
const BOT = 'trader';
const agentFile = join(dataRoot, 'agents', BOT, 'agent.json');
mkdirSync(join(dataRoot, 'agents', BOT), { recursive: true });
writeFileSync(join(dataRoot, 'agents', BOT, 'AGENT.md'), '---\nkind: bot\n---\nYou trade.\n');
const auditDir = mkdtempSync(join(tmpdir(), 'connector-widen-gate-'));
setHumanGateStore(createHumanGateStore(auditDir));
test.after(() => {
  setHumanGateStore(null);
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

const setTools = (tools) =>
  writeFileSync(agentFile, JSON.stringify({ name: BOT, connectors: { off: [], tools: { mt5: tools } } }));
const level = (tool) => readConnectorsFile(agentFile)?.tools?.mt5?.[tool];
const editor = {
  getAgentConnectorPolicy: () => readConnectorsFile(agentFile),
  async setAgentConnectorPolicy(_id, connectors) {
    const manifest = JSON.parse(readFileSync(agentFile, 'utf8'));
    manifest.connectors = storedConnectorPolicy(connectors) ?? undefined;
    writeFileSync(agentFile, JSON.stringify(manifest));
    return readConnectorsFile(agentFile);
  },
};
const api = createAgentConnectorsApi({ mcpStatus: () => ({ servers: [] }), getMcpTools: () => [] }, editor);
const NO_WIDEN = { noWiden: true };

/** The bot's setup call; `answer(request)` plays the person on the card. */
async function ask(tool, permission, answer) {
  const asked = [];
  const result = await AGENT_SETTINGS_HANDLERS.set_agent_connector_tool(
    api,
    { agent: BOT, name: 'mt5', tool, permission },
    {
      requestApproval: async (request) => {
        asked.push(request);
        return answer(request);
      },
    }
  );
  return { result, asked };
}
const pick = (scope) => () => ({ approved: true, response: 'approve', scope, device: 'phone' });
const deny = () => ({ approved: false, response: 'deny', device: 'desktop' });

test('a widening request shows a card and changes nothing until it is answered', async () => {
  setTools({ trade_send_market_order: 'disabled' });
  let during = '';
  const { result, asked } = await ask('trade_send_market_order', 'needs_approval', (request) => {
    during = level('trade_send_market_order');
    return deny();
  });
  assert.equal(asked.length, 1);
  assert.equal(during, 'disabled', 'unchanged while the card waits');
  assert.equal(asked[0].kind, 'connector');
  assert.equal(asked[0].agentId, BOT);
  assert.deepEqual(asked[0].remember, ['once'], 'never remembered');
  assert.deepEqual(asked[0].connector, {
    server: 'mt5',
    tool: 'trade_send_market_order',
    from: 'disabled',
    requested: 'needs_approval',
    choices: ['needs_approval', 'auto'],
  });
  assert.equal(result.approved, false);
  assert.equal(result.saved, false);
  assert.equal(level('trade_send_market_order'), 'disabled', 'deny changes nothing');
});

test('Enable with approval sets exactly needs_approval, Enable automatically exactly auto, whatever was asked', async () => {
  setTools({ a: 'disabled', b: 'disabled', other: 'disabled' });
  const first = await ask('a', 'auto', pick('needs_approval'));
  assert.equal(first.result.permission, 'needs_approval');
  assert.equal(level('a'), 'needs_approval');
  const second = await ask('b', 'needs_approval', pick('auto'));
  assert.equal(second.result.permission, 'auto');
  assert.equal(level('b'), 'auto');
  assert.equal(level('other'), 'disabled', 'only that one tool changed');
  // A tool that already asks is offered only auto: no shown choice narrows.
  const third = await ask('a', 'auto', pick('auto'));
  assert.deepEqual(third.asked[0].connector.choices, ['auto']);
  assert.equal(level('a'), 'auto');
});

test('every widening asks again: no grant is remembered, whatever the answer carried', async () => {
  setTools({ a: 'disabled' });
  await ask('a', 'needs_approval', () => ({ approved: true, scope: 'needs_approval', remember: 'agent' }));
  assert.equal(level('a'), 'needs_approval');
  const again = await ask('a', 'auto', pick('auto'));
  assert.equal(again.asked.length, 1, 'a second widening still shows a card');
  assert.equal(level('a'), 'auto');
  setTools({ a: 'disabled' });
  const afterAuto = await ask('a', 'needs_approval', deny);
  assert.equal(afterAuto.asked.length, 1, 'and so after Enable automatically');
  const store = createHumanGateStore(auditDir);
  assert.deepEqual(await store.listGrants(), [], 'no standing grant of any kind');
  const audit = await store.readAudit({ agentId: BOT });
  assert.ok(audit.some((row) => row.kind === 'connector' && row.device === 'phone'), 'the answering device is audited');
});

test('only a level the person picked on the card applies: a bare or text approval, or a model, changes nothing', async () => {
  setTools({ a: 'disabled' });
  // An approval that picks no offered level (a bare allow, a reply) applies nothing.
  for (const answer of [{ approved: true }, { approved: true, reply: 'yes', scope: 'always' }]) {
    const { result } = await ask('a', 'auto', () => answer);
    assert.equal(result.approved, false);
    assert.equal(level('a'), 'disabled');
  }
  // With no card to show (no approval hook), the call is refused as before.
  await assert.rejects(
    AGENT_SETTINGS_HANDLERS.set_agent_connector_tool(api, { agent: BOT, name: 'mt5', tool: 'a', permission: 'auto' }, {}),
    { message: NO_WIDEN_MESSAGE }
  );
  assert.equal(level('a'), 'disabled');
});

test('the card on the approval queue: answered once, remember forced to once, timeout changes nothing', async () => {
  setTools({ a: 'disabled' });
  const state = {};
  const queue = createToolApproval({
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: (() => {
      let n = 0;
      return () => `appr_${++n}`;
    })(),
    getDisposed: () => false,
  });
  const pending = AGENT_SETTINGS_HANDLERS.set_agent_connector_tool(
    api,
    { agent: BOT, name: 'mt5', tool: 'a', permission: 'needs_approval' },
    { requestApproval: queue.requestToolApproval }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.toolApproval.kind, 'connector');
  assert.deepEqual(state.toolApproval.remember, ['once']);
  // "Always allow" is not offered: the answer is taken as once.
  queue.finishToolApproval(state.toolApproval.id, true, '', 'desktop', undefined, undefined, {
    response: 'approve',
    scope: 'auto',
    remember: 'always',
  });
  const result = await pending;
  assert.equal(result.permission, 'auto');
  assert.equal(level('a'), 'auto');
  assert.deepEqual(await createHumanGateStore(auditDir).listGrants(), []);

  setTools({ a: 'disabled' });
  const timed = createToolApproval({
    getState: () => ({}),
    set: () => {},
    nextId: () => 'appr_t',
    getDisposed: () => false,
    timeoutMs: 20,
  });
  // The queue's timer does not hold the process open; this test does.
  const hold = setInterval(() => {}, 1_000);
  const late = await AGENT_SETTINGS_HANDLERS.set_agent_connector_tool(
    api,
    { agent: BOT, name: 'mt5', tool: 'a', permission: 'auto' },
    { requestApproval: timed.requestToolApproval }
  ).finally(() => clearInterval(hold));
  assert.equal(late.approved, false);
  assert.match(late.note, /timed out/);
  assert.equal(level('a'), 'disabled');
});

test('a narrowing that lands while the card waits is not lifted', async () => {
  setTools({ a: 'needs_approval', b: 'auto' });
  const { result } = await ask('a', 'auto', async () => {
    // Another chat (or the bot itself) narrows this tool and another one meanwhile.
    await api.setAgentConnectorToolPermission(BOT, 'mt5', 'a', 'disabled', NO_WIDEN);
    await api.setAgentConnectorToolPermission(BOT, 'mt5', 'b', 'disabled', NO_WIDEN);
    return pick('auto')();
  });
  assert.equal(result.approved, true);
  assert.equal(result.saved, false);
  assert.match(result.note, /newer restriction/);
  assert.equal(level('a'), 'disabled', 'the newer restriction stands');
  assert.equal(level('b'), 'disabled');

  // A narrowing of another tool does not block the approved one, and stays.
  setTools({ a: 'disabled', b: 'auto' });
  await ask('a', 'auto', async () => {
    await api.setAgentConnectorToolPermission(BOT, 'mt5', 'b', 'disabled', NO_WIDEN);
    return pick('needs_approval')();
  });
  assert.equal(level('a'), 'needs_approval');
  assert.equal(level('b'), 'disabled');
});

test('narrowing still applies at once, with no card', async () => {
  setTools({ a: 'auto' });
  const { result, asked } = await ask('a', 'disabled', () => assert.fail('no card'));
  assert.deepEqual(asked, []);
  assert.equal(result.permission, 'disabled');
  assert.equal(level('a'), 'disabled');
});
// The accounts of one connector (`gmail`, `gmail-2`) share one permission per tool, stored under `gmail`.
const accountsPolicy = (tools) =>
  writeFileSync(agentFile, JSON.stringify({ name: BOT, connectors: { off: [], tools } }));
const stored = () => readConnectorsFile(agentFile)?.tools;
const effective = (server) =>
  connectorToolPermission(readConnectorsFile(agentFile), `mcp__${server}__send_email`);
const askOn = (server, permission, answer) =>
  AGENT_SETTINGS_HANDLERS.set_agent_connector_tool(
    api,
    { agent: BOT, name: server, tool: 'send_email', permission },
    { requestApproval: async (request) => answer(request) }
  );

test('a narrowing on gmail-2 is stored under gmail and governs both accounts', async () => {
  accountsPolicy({});
  await askOn('gmail-2', 'disabled', () => assert.fail('no card'));
  assert.deepEqual(stored(), { gmail: { send_email: 'disabled' } });
  assert.equal(effective('gmail'), 'disabled');
  assert.equal(effective('gmail-2'), 'disabled');
});

test('an approved widening on gmail-2 is stored under gmail, and the card names the connector', async () => {
  accountsPolicy({ gmail: { send_email: 'disabled' } });
  let card;
  await askOn('gmail-2', 'auto', (request) => {
    card = request.connector;
    return pick('needs_approval')();
  });
  assert.equal(card.server, 'gmail');
  assert.deepEqual(stored(), { gmail: { send_email: 'needs_approval' } });
  assert.equal(effective('gmail'), 'needs_approval');
  assert.equal(effective('gmail-2'), 'needs_approval');
});

test('legacy per-account entries follow the topmost: the connector\'s own, else the lowest-numbered account', () => {
  accountsPolicy({ gmail: { send_email: 'auto' }, 'gmail-2': { send_email: 'disabled' } });
  assert.equal(effective('gmail'), 'auto');
  assert.equal(effective('gmail-2'), 'auto');
  accountsPolicy({ gmail: { send_email: 'disabled' }, 'gmail-2': { send_email: 'auto' } });
  assert.equal(effective('gmail'), 'disabled');
  assert.equal(effective('gmail-2'), 'disabled');
  accountsPolicy({ 'gmail-3': { send_email: 'auto' }, 'gmail-2': { send_email: 'disabled' } });
  assert.equal(effective('gmail'), 'disabled');
});

test('legacy per-account entries converge to one entry on a write, and a bot cannot widen past the topmost', async () => {
  accountsPolicy({ gmail: { send_email: 'disabled', keep: 'auto' }, 'gmail-2': { send_email: 'auto' } });
  await assert.rejects(api.setAgentConnectorToolPermission(BOT, 'gmail', 'send_email', 'auto', NO_WIDEN), {
    message: NO_WIDEN_MESSAGE,
  });
  await api.setAgentConnectorToolPermission(BOT, 'gmail-2', 'send_email', 'needs_approval');
  assert.deepEqual(stored(), { gmail: { send_email: 'needs_approval', keep: 'auto' } });
});

test('an account that is off does not hold back its siblings: a bot cannot widen the tool on the one still on', async () => {
  writeFileSync(
    agentFile,
    JSON.stringify({ name: BOT, connectors: { off: ['gmail-2'], tools: { gmail: { send_email: 'disabled' } } } })
  );
  await assert.rejects(api.setAgentConnectorToolPermission(BOT, 'gmail', 'send_email', 'auto', NO_WIDEN), {
    message: NO_WIDEN_MESSAGE,
  });
  assert.deepEqual(stored(), { gmail: { send_email: 'disabled' } });
});

test('an approved change lets only the approved tool rise, never a second tool of the connector', () => {
  const before = { off: ['gmail-2'], tools: { gmail: { send_email: 'disabled', other: 'disabled' } } };
  const approved = { server: 'gmail', tool: 'send_email', from: 'disabled', to: 'needs_approval' };
  const judge = (tools) =>
    withApprovedConnectorToolChange(approved, () => assertConnectorPolicyNotWidened(before, { off: before.off, tools }));
  assert.doesNotThrow(() => judge({ gmail: { send_email: 'needs_approval', other: 'disabled' } }));
  assert.throws(() => judge({ gmail: { send_email: 'needs_approval', other: 'auto' } }), {
    code: CONNECTOR_POLICY_WIDENS,
  });
});

for (const off of [['gmail'], ['gmail-2'], ['gmail-3']]) {
  test(`with ${off[0]} off, a bot cannot widen a gmail tool, and an approved change carries no second tool`, async () => {
    const tools = { gmail: { send_email: 'disabled', other: 'disabled' } };
    writeFileSync(agentFile, JSON.stringify({ name: BOT, connectors: { off, tools } }));
    await assert.rejects(api.setAgentConnectorToolPermission(BOT, 'gmail-2', 'send_email', 'auto', NO_WIDEN), {
      message: NO_WIDEN_MESSAGE,
    });
    assert.deepEqual(stored(), tools);
    const approved = { server: 'gmail', tool: 'send_email', from: 'disabled', to: 'needs_approval' };
    const judge = (next) =>
      withApprovedConnectorToolChange(approved, () =>
        assertConnectorPolicyNotWidened({ off, tools }, { off, tools: { gmail: next } })
      );
    assert.doesNotThrow(() => judge({ send_email: 'needs_approval', other: 'disabled' }));
    assert.throws(() => judge({ send_email: 'needs_approval', other: 'auto' }), { code: CONNECTOR_POLICY_WIDENS });
  });
}
