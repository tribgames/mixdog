// Records, from today's Node product, what the connector account choice answers for a set of
// scenarios (connector-accounts-mcp.mjs `choose`, client.mjs MCP_TOOL_NAME_RE), as the golden
// the Rust port replays. Usage: node accounts-golden.mjs <repo-root> <out.json>
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);
const load = (p) => import(pathToFileURL(join(root, 'src', 'runtime', p)).href);
const { withConnectorAccountsMcp, CONVERSATION_META, forgetConnectorAccountHealth } = await load(
  'connectors/connector-accounts-mcp.mjs'
);

const A = 'a@example.com';
const B = 'b@example.com';
const tool = (name, props = {}) => ({ name, description: name, inputSchema: { type: 'object', properties: props } });
const SEARCH = tool('search', { query: { type: 'string' } });
const CREATE = tool('create', { title: { type: 'string' } });

const acct = (name, email, extra = {}) => ({ name, id: `${name}|${email}`, email, ...extra });

const scenarios = [
  {
    name: 'defaults and naming',
    connector: 'linear',
    accounts: [acct('linear', A), acct('linear-2', B)],
    steps: [
      { op: 'init' },
      { op: 'choose', tool: 'search', conversation: '' },
      { op: 'choose', tool: 'search', wanted: 'linear-2' },
      { op: 'choose', tool: 'search', wanted: 'LINEAR-2' },
      { op: 'choose', tool: 'search', wanted: '  B@Example.com  ' },
      { op: 'choose', tool: 'search', wanted: '\u00a0b@example.com\u2003' },
      { op: 'choose', tool: 'search', wanted: 'nobody' },
      { op: 'choose', tool: 'search', wanted: 5 },
      { op: 'choose', tool: 'search', wanted: '' },
      { op: 'choose', tool: 'search', wanted: '   ' },
      { op: 'choose', tool: 'search', wanted: null },
    ],
  },
  {
    name: 'shared address makes labels and ambiguity',
    connector: 'notion',
    accounts: [acct('notion', A), acct('notion-2', A), acct('notion-3', B)],
    steps: [
      { op: 'init' },
      { op: 'choose', tool: 'search' },
      { op: 'choose', tool: 'search', wanted: A },
      { op: 'choose', tool: 'search', wanted: `${A} (notion-2)` },
      { op: 'choose', tool: 'search', wanted: 'notion-3' },
      { op: 'choose', tool: 'search', wanted: B },
    ],
  },
  {
    name: 'account without an address is called by its name',
    connector: 'postgres',
    accounts: [acct('postgres', ''), acct('postgres-2', B)],
    steps: [
      { op: 'init' },
      { op: 'choose', tool: 'search' },
      { op: 'choose', tool: 'search', wanted: 'postgres' },
      { op: 'choose', tool: 'search', wanted: 'x' },
    ],
  },
  {
    name: 'last used in the conversation and by the connector',
    connector: 'linear',
    accounts: [acct('linear', A), acct('linear-2', B)],
    steps: [
      { op: 'init' },
      { op: 'call', tool: 'search', args: { account: B }, conversation: 'conv-1' },
      { op: 'choose', tool: 'search', conversation: 'conv-1' },
      { op: 'choose', tool: 'search', conversation: 'conv-2' },
      { op: 'choose', tool: 'search', conversation: '' },
      { op: 'call', tool: 'search', args: { account: A }, conversation: 'conv-2' },
      { op: 'choose', tool: 'search', conversation: 'conv-1' },
      { op: 'choose', tool: 'search', conversation: 'conv-2' },
      { op: 'choose', tool: 'search', conversation: 'conv-3' },
    ],
  },
  {
    name: 'a remembered account is its identity',
    connector: 'linear',
    accounts: [acct('linear', A), acct('linear-2', 'new@example.com', { id: 'added-later' })],
    steps: [
      { op: 'init' },
      { op: 'state', file: 'in-use', value: {} },
      { op: 'choose', tool: 'search', conversation: 'conv-l1' },
      { op: 'state', file: 'in-use', value: { linear: 'linear-2' } },
      { op: 'choose', tool: 'search', conversation: 'conv-l3' },
      { op: 'state', file: 'in-use', value: { linear: { name: 'linear-2', id: 'linear-2|b@example.com' } } },
      { op: 'choose', tool: 'search', conversation: 'conv-l2' },
      { op: 'state', file: 'in-use', value: { linear: { name: 'linear-2', id: 'added-later' } } },
      { op: 'choose', tool: 'search', conversation: 'conv-l2' },
      { op: 'state', file: 'in-use', value: { linear: { name: 'gone', id: 'x' } } },
      { op: 'choose', tool: 'search', conversation: 'conv-l2' },
      { op: 'state', file: 'in-use', value: { linear: { name: 'linear', id: '' } } },
      { op: 'choose', tool: 'search', conversation: 'conv-l2' },
      { op: 'state', file: 'in-use', value: { linear: { name: '', id: 'x' }, '#ids': true } },
      { op: 'choose', tool: 'search', conversation: 'conv-l2' },
      { op: 'state', file: 'in-use', value: { linear: 7 } },
      { op: 'choose', tool: 'search', conversation: 'conv-l2' },
      { op: 'state', file: 'conv', value: { 'conv-l9': { accounts: { linear: { name: 'linear-2', id: 'linear-2|b@example.com' } } } } },
      { op: 'choose', tool: 'search', conversation: 'conv-l9' },
      { op: 'state', file: 'conv', value: { 'conv-l9': { accounts: 'x' } } },
      { op: 'choose', tool: 'search', conversation: 'conv-l9' },
      { op: 'state', file: 'conv', value: { 'conv-l9': 'x' } },
      { op: 'choose', tool: 'search', conversation: 'conv-l9' },
    ],
  },
  {
    name: 'an account that needs a sign-in',
    connector: 'stripe',
    accounts: [acct('stripe', A, { failAuth: true }), acct('stripe-2', B), acct('stripe-3', 'c@example.com')],
    steps: [
      { op: 'init' },
      { op: 'choose', tool: 'search' },
      { op: 'choose', tool: 'search', wanted: 'stripe' },
      { op: 'choose', tool: 'search', wanted: 'stripe-2' },
    ],
  },
  {
    name: 'every account needs a sign-in',
    connector: 'stripe',
    accounts: [acct('stripe', A, { failAuth: true })],
    steps: [{ op: 'init' }, { op: 'choose', tool: 'search' }],
  },
  {
    name: 'an account without the tool',
    connector: 'jira',
    accounts: [acct('jira', A, { tools: [SEARCH, CREATE] }), acct('jira-2', B, { tools: [SEARCH] })],
    steps: [
      { op: 'init' },
      { op: 'choose', tool: 'create', wanted: 'jira-2' },
      { op: 'choose', tool: 'search', wanted: 'jira-2' },
      { op: 'choose', tool: 'unlisted_helper', wanted: 'jira-2' },
      { op: 'choose', tool: 'create', wanted: 'jira' },
    ],
  },
  {
    name: 'a tool two accounts list differently is left out and not checked',
    connector: 'jira',
    accounts: [
      acct('jira', A, { tools: [tool('x', { a: { type: 'string' } }), SEARCH] }),
      acct('jira-2', B, { tools: [tool('x', { a: { type: 'number' } })] }),
    ],
    steps: [{ op: 'init' }, { op: 'choose', tool: 'x', wanted: 'jira-2' }, { op: 'choose', tool: 'search', wanted: 'jira-2' }],
  },
  {
    name: 'before any account answered nothing is checked against its tools',
    connector: 'jira',
    accounts: [acct('jira', A, { tools: [SEARCH] })],
    steps: [{ op: 'choose', tool: 'create' }],
  },
  {
    name: 'damaged state files',
    connector: 'linear',
    accounts: [acct('linear', A), acct('linear-2', B)],
    steps: [
      { op: 'init' },
      { op: 'state', file: 'in-use', raw: 'not json' },
      { op: 'choose', tool: 'search' },
      { op: 'state', file: 'in-use', raw: '[]' },
      { op: 'choose', tool: 'search' },
      { op: 'state', file: 'in-use', raw: '\ufeff{"linear":{"name":"linear-2","id":"linear-2|b@example.com"}}' },
      { op: 'choose', tool: 'search' },
      { op: 'state', file: 'in-use', raw: '{"linear":' },
      { op: 'backup', file: 'in-use', value: { linear: { name: 'linear-2', id: 'linear-2|b@example.com' } } },
      { op: 'choose', tool: 'search' },
      { op: 'state', file: 'conv', raw: '\u0000\u0000' },
      { op: 'choose', tool: 'search', conversation: 'c' },
    ],
  },
];

const NAMES = [
  'mcp__a__b',
  'mcp__a__b__c',
  'mcp____x__y',
  'mcp__a__',
  'mcp__a',
  'mcp__a\n__b',
  'mcp__a__b\nc',
  'mcp__\u2028__x',
  'mcp__x__\u2029',
  'mcp_a__b',
  'read',
  '',
  'mcp__linear-2__create_issue',
  'mcp__a____b',
  'mcp____',
  'mcp_____',
];
const MCP_TOOL_NAME_RE = /^mcp__(.+?)__(.+)$/;

const files = { 'in-use': 'connector-accounts-in-use.json', conv: 'connector-accounts-by-conversation.json' };
const result = { scenarios: [], names: NAMES.map((name) => ({ name, parts: (MCP_TOOL_NAME_RE.exec(name) || []).slice(1, 3) })) };

for (const scenario of scenarios) {
  const dir = mkdtempSync(join(tmpdir(), 'acct-golden-'));
  process.env.MIXDOG_DATA_DIR = dir;
  const live = scenario.accounts.map((a) => {
    const tools = a.tools || [SEARCH, CREATE];
    return {
      name: a.name,
      id: a.id,
      email: a.email,
      async connect() {
        if (a.failAuth) throw Object.assign(new Error('needs sign-in'), { authRequired: true });
        return { instructions: '', tools };
      },
      async callTool(params) {
        return { content: [{ type: 'text', text: `${a.name} did ${params.name}` }] };
      },
      close() {},
    };
  });
  const fetchImpl = withConnectorAccountsMcp({ connector: scenario.connector, accounts: live });
  const rpc = async (method, params = {}) => {
    const response = await fetchImpl('https://x.invalid/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
    });
    return response.json();
  };
  const snapshot = () =>
    Object.fromEntries(
      Object.entries(files).map(([key, file]) => [key, existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : null])
    );
  const steps = [];
  let init = null;
  for (const step of scenario.steps) {
    if (step.op === 'init') {
      await rpc('initialize');
      const listed = (await rpc('tools/list')).result.tools.map((t) => t.name);
      init = { listed };
      steps.push({ op: 'init', listed });
    } else if (step.op === 'state' || step.op === 'backup') {
      const raw = step.raw ?? JSON.stringify(step.value);
      const file = join(dir, files[step.file]) + (step.op === 'backup' ? '.bak' : '');
      writeFileSync(file, raw);
      steps.push({ op: step.op, file: step.file, raw });
    } else if (step.op === 'call') {
      const { account: _a, ...rest } = step.args;
      await rpc('tools/call', {
        name: step.tool,
        arguments: step.args,
        ...(step.conversation ? { _meta: { [CONVERSATION_META]: step.conversation } } : {}),
      });
      const now = snapshot();
      for (const [key, raw] of Object.entries(now)) if (raw !== null) steps.push({ op: 'state', file: key, raw });
    } else if (step.op === 'choose') {
      const entry = { op: 'choose', tool: step.tool, conversation: step.conversation ?? '' };
      if ('wanted' in step) entry.wanted = step.wanted;
      try {
        const chosen = fetchImpl.connectorAccounts.choose({
          tool: step.tool,
          wanted: step.wanted,
          conversation: String(step.conversation || '').trim(),
        });
        entry.expect = { ok: chosen };
      } catch (error) {
        entry.expect = { error: error.message };
      }
      steps.push(entry);
    }
  }
  result.scenarios.push({
    name: scenario.name,
    connector: scenario.connector,
    accounts: scenario.accounts.map((a) => ({ name: a.name, id: a.id, email: a.email, authRequired: Boolean(a.failAuth), tools: (a.tools || [SEARCH, CREATE]).map((t) => t.name) })),
    steps,
    leftover: readdirSync(dir).filter((f) => f.includes('.corrupt-')).length,
  });
  for (const a of scenario.accounts) forgetConnectorAccountHealth(a.name);
}
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
console.log(`recorded ${result.scenarios.length} scenarios`);
