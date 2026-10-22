import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-connectors-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = join(root, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

const { agentMcpToolPermission, migrateLegacyConnectorPolicy, parseConnectorPolicy, storedConnectorPolicy } =
  await import('./agent-connectors.mjs');
const { _registerMcpServerForTest, disconnectAll } = await import('./client.mjs');
const { resolveSessionTools } = await import('../session/manager/tool-resolution.mjs');
const { preDispatchDenyForSession } = await import('../session/loop/pre-dispatch-deny.mjs');
const { executeTool } = await import('../session/loop/tool-exec.mjs');
const { createHumanGateStore, setHumanGateStore } = await import('../session/human-gate/store.mjs');

const saveConnectors = (agentId, connectors) => {
  const dir = join(process.env.MIXDOG_DATA_DIR, 'agents', agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ name: agentId, ...(connectors ? { connectors } : {}) }));
};

function fixture(t) {
  const scopeId = `agent-connectors-${Math.random().toString(36).slice(2)}`;
  const calls = [];
  const callTool = async (request) => {
    calls.push(request.name);
    return { content: [{ type: 'text', text: 'ok' }] };
  };
  _registerMcpServerForTest(scopeId, 'alpha', [{ name: 'read_it' }, { name: 'write_it' }, { name: 'drop_it' }], {
    callTool,
  });
  _registerMcpServerForTest(scopeId, 'beta', [{ name: 'ping' }], { callTool });
  t.after(() => disconnectAll({ scopeId }));
  return { scopeId, calls };
}
const mcpNames = (tools) => tools.map((tool) => tool.name).filter((name) => name.startsWith('mcp__'));
// The schema surface never depends on the acting agent (one shared BP2/schema).
const surface = (scopeId) => mcpNames(resolveSessionTools('mcp', [], { mcpScopeId: scopeId }));
const ALL = ['mcp__alpha__drop_it', 'mcp__alpha__read_it', 'mcp__alpha__write_it', 'mcp__beta__ping'];
const refused = (agent, scopeId, name) =>
  /not available to this agent/.test(
    String(preDispatchDenyForSession({ agent, mcpScopeId: scopeId }, { name, arguments: {} }) || '')
  );

test('a policy is a deny list; a legacy list parses as an allow list and migrates to its equivalent', () => {
  assert.equal(parseConnectorPolicy(undefined), null);
  assert.deepEqual(parseConnectorPolicy({ off: [' b ', 'a', 'b'], tools: { a: { t: 'disabled', u: 'bogus' } } }), {
    off: ['a', 'b'],
    tools: { a: { t: 'disabled' } },
  });
  assert.throws(() => parseConnectorPolicy({ id: 'alpha', enabled: true }), /connectors must be/);
  assert.throws(() => parseConnectorPolicy({ off: 'alpha' }), /off must be a list/);
  assert.throws(() => parseConnectorPolicy('alpha'), /connectors must be/);
  const legacy = parseConnectorPolicy([
    { id: ' a ', enabled: true, tools: { t: 'disabled', u: 'bogus' } },
    { id: 'b', enabled: false },
    { enabled: true },
    null,
  ]);
  assert.deepEqual(legacy, { allow: ['a'], off: [], tools: { a: { t: 'disabled' } } });
  // Every installed connector the list did not enable is switched off.
  assert.deepEqual(migrateLegacyConnectorPolicy(legacy, ['a', 'b', 'c']), {
    off: ['b', 'c'],
    tools: { a: { t: 'disabled' } },
  });
  assert.equal(storedConnectorPolicy({ off: [], tools: {} }), null, 'nothing off is no policy');
  assert.throws(() => storedConnectorPolicy(legacy), /migrated/);
});

test('every session lists every connected tool, whatever the agent', (t) => {
  const { scopeId } = fixture(t);
  saveConnectors('plain', null);
  saveConnectors('scoped', { off: ['beta'], tools: { alpha: { drop_it: 'disabled' } } });
  saveConnectors('nothing', { off: ['alpha', 'beta'] });
  assert.deepEqual(surface(scopeId), ALL);
  for (const agent of ['plain', 'scoped', 'nothing', 'lead', 'unknown-agent']) {
    for (const name of ['mcp__alpha__read_it', 'mcp__beta__ping']) {
      assert.equal(refused(agent, scopeId, name), agent === 'nothing' || (agent === 'scoped' && name.includes('beta')));
    }
  }
});

test('an agent may run every connector it has not switched off, minus disabled tools', async (t) => {
  const { scopeId, calls } = fixture(t);
  saveConnectors('scoped', { off: ['beta'], tools: { alpha: { drop_it: 'disabled', write_it: 'needs_approval' } } });
  // Listed (shared schema) but refused at dispatch.
  assert.deepEqual(surface(scopeId), ALL);
  assert.ok(refused('scoped', scopeId, 'mcp__alpha__drop_it'));
  assert.ok(refused('scoped', scopeId, 'mcp__beta__ping'));
  assert.ok(!refused('scoped', scopeId, 'mcp__alpha__write_it'));
  // A connector installed later is on: only `off` names refuse.
  assert.equal(agentMcpToolPermission('scoped', 'mcp__gamma__anything'), 'auto');
  // A disabled connector's tool never reaches its server, approval hook or not.
  const session = { id: 's0', agent: 'scoped', mcpScopeId: scopeId };
  const approveAll = { toolApprovalHook: async () => true };
  for (const name of ['mcp__alpha__drop_it', 'mcp__beta__ping']) {
    assert.match(
      String(await executeTool(name, {}, process.cwd(), 's0', session, approveAll)),
      /not available to this agent/
    );
  }
  assert.deepEqual(calls, []);
});

test('a legacy allow list not yet migrated is enforced as written', (t) => {
  const { scopeId } = fixture(t);
  saveConnectors('legacy', [{ id: 'alpha', enabled: true }]);
  assert.ok(!refused('legacy', scopeId, 'mcp__alpha__read_it'));
  assert.ok(refused('legacy', scopeId, 'mcp__beta__ping'));
  saveConnectors('legacy-empty', []);
  for (const name of ALL) assert.ok(refused('legacy-empty', scopeId, name), name);
});

test('a project switches a connector off for every session in it, workers and worktrees included', async (t) => {
  const { scopeId, calls } = fixture(t);
  const projectRoot = join(root, 'proj');
  writeFileSync(
    join(process.env.MIXDOG_DATA_DIR, 'project-connectors.json'),
    JSON.stringify({ projects: { [projectRoot]: { off: ['beta'] } } })
  );
  t.after(() => rmSync(join(process.env.MIXDOG_DATA_DIR, 'project-connectors.json'), { force: true }));
  const deny = (session, name) =>
    String(preDispatchDenyForSession({ mcpScopeId: scopeId, ...session }, { name }) || '');
  assert.match(deny({ cwd: join(projectRoot, 'src') }, 'mcp__beta__ping'), /switched off in this project/);
  assert.match(
    deny({ cwd: join(root, 'wt'), workspace: { projectPath: projectRoot } }, 'mcp__beta__ping'),
    /switched off in this project/
  );
  assert.match(
    deny(
      { cwd: join(root, 'wt'), desktopSession: { classification: 'project', projectPath: projectRoot } },
      'mcp__beta__ping'
    ),
    /switched off in this project/
  );
  assert.equal(deny({ cwd: join(projectRoot, 'src') }, 'mcp__alpha__read_it'), '');
  assert.equal(deny({ cwd: join(root, 'elsewhere') }, 'mcp__beta__ping'), '');
  const session = { id: 'sp', agent: 'plain', mcpScopeId: scopeId, cwd: projectRoot };
  assert.match(String(await executeTool('mcp__beta__ping', {}, projectRoot, 'sp', session, {})), /switched off/);
  assert.deepEqual(calls, []);
  // A project file that cannot be read switches every connector off.
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'project-connectors.json'), '{ not json');
  assert.match(deny({ cwd: join(root, 'elsewhere') }, 'mcp__alpha__read_it'), /switched off in this project/);
});

test('an unreadable or invalid policy denies every connector instead of opening them', (t) => {
  const { scopeId } = fixture(t);
  const write = (id, text) => {
    const dir = join(process.env.MIXDOG_DATA_DIR, 'agents', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.json'), text);
  };
  write('corrupt', '{ not json');
  write('badshape', JSON.stringify({ connectors: 'alpha' }));
  write('badobject', JSON.stringify({ connectors: { id: 'alpha', enabled: true } }));
  write('nullfield', JSON.stringify({ name: 'x', connectors: null }));
  for (const id of ['corrupt', 'badshape', 'badobject']) {
    assert.ok(refused(id, scopeId, 'mcp__alpha__read_it'), id);
    assert.equal(agentMcpToolPermission(id, 'mcp__alpha__read_it'), 'disabled', id);
  }
  // An absent field (or file) is the legacy state: every server.
  assert.ok(!refused('nullfield', scopeId, 'mcp__alpha__read_it'));
  assert.ok(!refused('no-such-agent', scopeId, 'mcp__beta__ping'));
});

test('an agent.json a crash left empty or NUL-filled, with no backup, never fails open', (t) => {
  const { scopeId } = fixture(t);
  const write = (id, text) => {
    const dir = join(process.env.MIXDOG_DATA_DIR, 'agents', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.json'), text);
    return dir;
  };
  const dirs = { 'nul-filled': write('nul-filled', '\0'.repeat(64)), empty: write('empty', '') };
  write('bom', `\ufeff${JSON.stringify({ name: 'bom', connectors: { off: ['alpha'] } })}`);
  for (const [id, dir] of Object.entries(dirs)) {
    assert.ok(refused(id, scopeId, 'mcp__alpha__read_it'), id);
    assert.ok(refused(id, scopeId, 'mcp__beta__ping'), id);
    // Left in place: moving it aside would make the next read "no policy".
    assert.ok(readdirSync(dir).includes('agent.json'), id);
    assert.ok(!readdirSync(dir).some((name) => name.includes('.corrupt-')), id);
    assert.ok(refused(id, scopeId, 'mcp__alpha__read_it'), `${id}, read again`);
  }
  // A hand-edited file saved with a byte order mark still applies its policy.
  assert.ok(refused('bom', scopeId, 'mcp__alpha__read_it'));
  assert.ok(!refused('bom', scopeId, 'mcp__beta__ping'));
});

test('a torn agent.json with a valid backup restores the backup deny list', (t) => {
  const { scopeId } = fixture(t);
  const dir = join(process.env.MIXDOG_DATA_DIR, 'agents', 'torn-bak');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.json'), '{"name":"torn-bak","connectors":{"off":[');
  writeFileSync(join(dir, 'agent.json.bak'), JSON.stringify({ name: 'torn-bak', connectors: { off: ['alpha'] } }));
  assert.ok(refused('torn-bak', scopeId, 'mcp__alpha__read_it'));
  assert.ok(!refused('torn-bak', scopeId, 'mcp__beta__ping'));
  assert.ok(readdirSync(dir).some((name) => name.startsWith('agent.json.corrupt-')));
});

test('a NUL agent.json restores its .bak deny list; an invalid .bak keeps every connector off', (t) => {
  const { scopeId } = fixture(t);
  const write = (id, text, bak) => {
    const dir = join(process.env.MIXDOG_DATA_DIR, 'agents', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.json'), text);
    if (bak !== undefined) writeFileSync(join(dir, 'agent.json.bak'), bak);
    return dir;
  };
  const dir = write('nul-bak', '\0'.repeat(64), JSON.stringify({ name: 'nul-bak', connectors: { off: ['alpha'] } }));
  assert.ok(refused('nul-bak', scopeId, 'mcp__alpha__read_it'), 'the deny list applies');
  assert.ok(!refused('nul-bak', scopeId, 'mcp__beta__ping'));
  assert.ok(
    readdirSync(dir).some((name) => name.startsWith('agent.json.corrupt-')),
    'damaged bytes kept aside'
  );
  assert.match(readFileSync(join(dir, 'agent.json'), 'utf8'), /"alpha"/, 'the backup was restored');
  // A backup that is not a usable policy opens nothing up.
  write('nul-badbak', '\0'.repeat(64), JSON.stringify({ connectors: 'alpha' }));
  assert.ok(refused('nul-badbak', scopeId, 'mcp__alpha__read_it'));
  assert.ok(refused('nul-badbak', scopeId, 'mcp__beta__ping'));
});

test("Mixy's policy is read where her profile saves it, and a coding Lead never inherits it", async (t) => {
  const { scopeId, calls } = fixture(t);
  const dataDir = process.env.MIXDOG_DATA_DIR;
  const botsDir = join(dataDir, 'bots');
  const mixyFile = join(botsDir, 'mixy', 'agent.json');
  // The bot store is active: Mixy's identity (and her policy) lives in bots/mixy.
  mkdirSync(join(botsDir, 'mixy'), { recursive: true });
  writeFileSync(join(botsDir, 'migration.json'), JSON.stringify({ version: 1, bots: [] }));
  // What the pre-split Mixy left in agents/lead: stale, and nothing writes it any more.
  saveConnectors('lead', { off: ['beta'] });
  t.after(() => {
    rmSync(botsDir, { recursive: true, force: true });
    rmSync(join(dataDir, 'agents', 'lead'), { recursive: true, force: true });
  });
  const mixy = { id: 'sess_home_lead', agent: 'lead', sessionMode: 'agent', mcpScopeId: scopeId };
  const coding = { id: 'sess_task_1', agent: 'lead', sessionMode: 'coding', mcpScopeId: scopeId };
  const denies = (session, name) =>
    /not available to this agent/.test(String(preDispatchDenyForSession(session, { name, arguments: {} }) || ''));

  // A connector Mixy's profile switched off.
  writeFileSync(mixyFile, JSON.stringify({ name: 'Mixy', connectors: { off: ['alpha'] } }));
  assert.ok(denies(mixy, 'mcp__alpha__read_it'), 'Mixy: the connector she switched off is refused');
  assert.ok(!denies(mixy, 'mcp__beta__ping'), 'Mixy: the stale agents/lead copy is not her policy');
  assert.ok(!denies(coding, 'mcp__alpha__read_it'), 'a coding Lead does not run under her policy');
  assert.ok(!denies(coding, 'mcp__beta__ping'), 'nor under the stale agents/lead copy');
  const approveAll = { toolApprovalHook: async () => true };
  assert.match(
    String(await executeTool('mcp__alpha__read_it', {}, process.cwd(), mixy.id, mixy, approveAll)),
    /not available to this agent/
  );
  assert.deepEqual(calls, [], 'a refused connector never reaches its server');

  // A tool set to disabled, and one set to ask.
  writeFileSync(
    mixyFile,
    JSON.stringify({
      name: 'Mixy',
      connectors: { tools: { alpha: { drop_it: 'disabled', write_it: 'needs_approval' } } },
    })
  );
  assert.equal(agentMcpToolPermission('lead', 'mcp__alpha__drop_it'), 'disabled');
  assert.ok(denies(mixy, 'mcp__alpha__drop_it'));
  assert.ok(!denies(coding, 'mcp__alpha__drop_it'));
  const asked = [];
  const run = (session, name) =>
    executeTool(name, {}, process.cwd(), session.id, session, {
      toolApprovalHook: async (request) => {
        asked.push([session.id, request.name]);
        return { approved: true, response: 'approve' };
      },
    });
  await run(mixy, 'mcp__alpha__write_it');
  await run(coding, 'mcp__alpha__write_it');
  assert.deepEqual(asked, [['sess_home_lead', 'mcp__alpha__write_it']], 'only Mixy is asked');
  assert.deepEqual(calls, ['write_it', 'write_it']);

  // Before the bot store exists Mixy's identity folder is agents/lead.
  rmSync(join(botsDir, 'migration.json'));
  assert.ok(denies(mixy, 'mcp__beta__ping'), 'no store: agents/lead is her policy');
  assert.ok(!denies(coding, 'mcp__beta__ping'));
});

test('a tool without its own entry runs without asking, a newly added one too', (t) => {
  const { scopeId } = fixture(t);
  saveConnectors('lister', { tools: { alpha: { read_it: 'auto' } } });
  assert.equal(agentMcpToolPermission('lister', 'mcp__alpha__read_it'), 'auto');
  assert.equal(agentMcpToolPermission('lister', 'mcp__alpha__brand_new'), 'auto');
  assert.ok(surface(scopeId).includes('mcp__alpha__write_it'));
  assert.ok(!refused('lister', scopeId, 'mcp__alpha__write_it'));
});

test('needs_approval asks through the approval hook; disabled never reaches the server', async (t) => {
  const { scopeId, calls } = fixture(t);
  saveConnectors('asker', { tools: { alpha: { write_it: 'needs_approval', read_it: 'auto' } } });
  assert.equal(agentMcpToolPermission('asker', 'mcp__alpha__write_it'), 'needs_approval');
  assert.equal(agentMcpToolPermission('asker', 'mcp__alpha__read_it'), 'auto');
  assert.equal(agentMcpToolPermission('asker', 'read'), 'auto');
  // Only a bot's own session asks (its home chat here); another session runs the tool unasked.
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'agents', 'asker', 'AGENT.md'), '---\nkind: bot\n---\nAsker.\n');
  const session = { id: 'sess_home_asker', agent: 'asker', mcpScopeId: scopeId };
  const asked = [];
  const run = (name, approve) =>
    executeTool(name, {}, process.cwd(), 'sess_home_asker', session, {
      toolApprovalHook: async (request) => {
        asked.push(request.name);
        return approve;
      },
    });

  await run('mcp__alpha__read_it', false);
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, ['read_it']);

  assert.match(await run('mcp__alpha__write_it', false), /was not approved/);
  assert.deepEqual(asked, ['mcp__alpha__write_it']);
  assert.deepEqual(calls, ['read_it']);

  await run('mcp__alpha__write_it', true);
  assert.deepEqual(calls, ['read_it', 'write_it']);

  // No approval UI in the bot's own session: the call is refused, not run.
  assert.match(
    await executeTool('mcp__alpha__write_it', {}, process.cwd(), 'sess_home_asker', session, {}),
    /no approval UI/
  );
  assert.deepEqual(calls, ['read_it', 'write_it']);

  // The same agent in any other session (a workflow or coding session, a sub-agent) is never asked.
  asked.length = 0;
  const elsewhere = { ...session, id: 's1' };
  await executeTool('mcp__alpha__write_it', {}, process.cwd(), 's1', elsewhere, {
    toolApprovalHook: async (request) => {
      asked.push(request.name);
      return false;
    },
  });
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, ['read_it', 'write_it', 'write_it']);
});

test('a needs_approval tool the outbound gate already approved asks once; others still ask', async (t) => {
  const { scopeId, calls } = fixture(t);
  _registerMcpServerForTest(scopeId, 'gmail', [{ name: 'send_email' }], {
    callTool: async (request) => {
      calls.push(request.name);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });
  saveConnectors('mailer', {
    tools: { gmail: { send_email: 'needs_approval' }, alpha: { write_it: 'needs_approval' } },
  });
  // The outbound card is a bot's: only a `kind: bot` agent gets it.
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'agents', 'mailer', 'AGENT.md'), '---\nkind: bot\n---\nMailer.\n');
  const session = { id: 'sess_home_mailer', agent: 'mailer', mcpScopeId: scopeId };
  const asked = [];
  const run = (name, args) =>
    executeTool(name, args, process.cwd(), 'sess_home_mailer', session, {
      toolApprovalHook: async (request) => {
        asked.push({ name: request.name, kind: request.kind });
        return { approved: true, response: 'approve' };
      },
    });

  await run('mcp__gmail__send_email', { to: 'a@b.c', subject: 's', body: 'hi' });
  assert.deepEqual(asked, [{ name: 'mcp__gmail__send_email', kind: 'outbound' }], 'one outbound card, no second');
  // A server not marked as the Gmail connector gets no mail-preview call.
  assert.deepEqual(calls, ['send_email']);

  asked.length = 0;
  await run('mcp__alpha__write_it', {});
  // A bot's connector ask is an ordinary approval that may be remembered for that bot.
  assert.deepEqual(asked, [{ name: 'mcp__alpha__write_it', kind: 'approval' }], 'not outbound: connector ask stays');
  assert.deepEqual(calls, ['send_email', 'write_it']);
});

test('an outbound always-allow answers the connector ask for later calls; other tools still ask', async (t) => {
  const { scopeId, calls } = fixture(t);
  _registerMcpServerForTest(scopeId, 'gmail', [{ name: 'send_email' }], {
    callTool: async (request) => {
      calls.push(request.name);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });
  saveConnectors('mailer2', {
    tools: { gmail: { send_email: 'needs_approval' }, alpha: { write_it: 'needs_approval' } },
  });
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'agents', 'mailer2', 'AGENT.md'), '---\nkind: bot\n---\nMailer.\n');
  const storeDir = mkdtempSync(join(root, 'gate-store-'));
  setHumanGateStore(createHumanGateStore(storeDir));
  t.after(() => setHumanGateStore(null));
  const sessionId = 'sess_home_mailer2';
  const session = { id: sessionId, agent: 'mailer2', mcpScopeId: scopeId };
  const asked = [];
  const run = (name, args, answer) =>
    executeTool(name, args, process.cwd(), sessionId, session, {
      toolApprovalHook: async (request) => {
        asked.push({ name: request.name, kind: request.kind });
        return answer;
      },
    });
  const mail = { to: 'a@b.c', subject: 's', body: 'hi' };

  await run('mcp__gmail__send_email', mail, { approved: true, response: 'approve', remember: 'agent' });
  assert.deepEqual(asked, [{ name: 'mcp__gmail__send_email', kind: 'outbound' }], 'first call: one outbound card');

  asked.length = 0;
  await run('mcp__gmail__send_email', mail, { approved: false });
  assert.deepEqual(asked, [], 'remembered outbound grant answers the connector ask too');
  assert.deepEqual(calls, ['send_email', 'send_email']);

  asked.length = 0;
  await run('mcp__alpha__write_it', {}, { approved: true, response: 'approve' });
  assert.deepEqual(asked, [{ name: 'mcp__alpha__write_it', kind: 'approval' }], 'unclassified tool still asks');
});
