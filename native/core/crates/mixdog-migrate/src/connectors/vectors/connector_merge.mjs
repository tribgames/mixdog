// Goldens of the one-time connector transition (`connector_merge.json`), from Node's own
// code: `migrateConnectorAccounts()` (session-runtime/resource-mcp-api.mjs: the config
// merge of connector-catalog.mjs mergeConnectorAccountServers, the stores of
// connector-merge-migration.mjs, the dropped MCP scopes), then
// `ensureConnectorAccountIds()` (runtime/connectors/connector-accounts-mcp.mjs), as
// session-runtime/boot/apis.mjs:115-128 runs them at a start.
//
//   node connector_merge.mjs [<mixdog src>] > connector_merge.json
//
// Each case is a data dir. The output holds every file of it afterwards except the
// config, of which `agent.mcpServers` and `agent.extensionScopes` are kept (the rest of
// the file is Node's config writer's). An account id given here is random: each one not
// in the input is written `<new-id-N>`, N counting from 1 in output order.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const src = process.argv[2] && process.argv[2] !== '--case' ? process.argv[2] : 'C:/Project/mixdog/src';
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const gmail = (address) => ({
  url: 'https://gmail-imap.mixdog.invalid/mcp',
  headers: { 'X-Mixdog-Gmail-Account': address },
  connector: 'gmail',
});
const accountsUrl = (id) => `https://connectors.mixdog.invalid/${id}/mcp`;

const CASES = {
  // 1.4.4-style one-account servers next to the v145 shape: every merge rule.
  unmerged: {
    'mixdog-config.json': json({
      agent: {
        mcpServers: {
          UnityMCP: { enabled: true, type: 'http', url: 'http://127.0.0.1:8080/mcp', startupTimeoutSec: 30 },
          'gmail-2': { type: 'http', ...gmail('b@gmail.com'), enabled: false },
          gmail: { type: 'http', ...gmail('a@gmail.com'), startupTimeoutSec: 20 },
          'gmail-10': { type: 'http', ...gmail('A@gmail.com') },
          notion: { type: 'http', url: 'https://mcp.notion.com/mcp', connector: 'notion' },
          'notion-2': { type: 'http', url: 'https://mcp.notion.com/mcp', oauthKey: 'k2', connector: 'notion' },
          'notion-3': { type: 'http', url: 'https://mcp.notion.com/mcp', connector: 'notion' },
          'linear-2': { type: 'http', url: 'https://mcp.linear.app/mcp', connector: 'linear', enabled: false },
          'linear-3': { type: 'http', url: 'https://mcp.linear.app/mcp', oauthKey: 'l3', connector: 'linear', enabled: false },
          jira: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp/authv2', connector: 'jira' },
          'jira-2': {
            type: 'http',
            url: accountsUrl('jira'),
            connector: 'jira',
            accounts: [{ name: 'jira-2', url: 'https://mcp.atlassian.com/v1/mcp/authv2', oauthKey: 'j2', id: 'kept-id' }],
          },
          postgres: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@microsoft/postgres-mcp@0.2.0', 'run'],
            env: { POSTGRES_MCP_CONNECTION_STRING: 'postgresql://x' },
            connector: 'postgres',
          },
          custom: { type: 'http', url: 'https://example.com/mcp', connector: 'not-in-catalog' },
        },
        extensionScopes: {
          skills: { s: ['C:\\Project\\B', 'C:\\Project\\A\\'] },
          mcp: { 'notion-2': ['C:\\Project\\mixdog'], UnityMCP: ['C:\\Project\\mixdog'] },
          plugins: {},
        },
        other: 1,
      },
      ui: { theme: 'dark' },
    }),
    'agents/a1/agent.json': json({
      name: 'a1',
      connectors: { off: ['gmail-2', 'UnityMCP'], tools: { 'gmail-2': { send_email: 'auto' }, gmail: { read: 'disabled' } } },
    }),
    'agents/a2/agent.json': json({ name: 'a2', connectors: { off: ['UnityMCP'] } }),
    'agents/a3/agent.json': json({ name: 'a3', connectors: { off: ['notion-3'], tools: { 'notion-3': { search: 'disabled' } } } }),
    'agents/a4/agent.json': json({ name: 'a4' }),
    'bots/b1/agent.json': json({
      name: 'b1',
      connectors: [
        { id: 'notion-2', enabled: true, tools: { search: 'needs_approval' } },
        { id: 'notion', enabled: false },
        { id: 'UnityMCP', enabled: true },
      ],
    }),
    'bots/b2/agent.json': json({ name: 'b2', connectors: { off: ['jira'] } }),
    'project-connectors.json': json({
      projects: {
        'C:\\Project\\A': { off: ['notion-2'] },
        'C:\\Project\\B': { off: ['UnityMCP'] },
        'C:\\Project\\C': { off: ['notion', 'notion-3', 'UnityMCP'], note: 'kept' },
      },
    }),
    'hooks.json': json({
      hooks: {
        PreToolUse: [
          {
            matcher: 'mcp__notion-2__search|Bash|^mcp__gmail-10__.*$',
            hooks: [
              { type: 'mcp_tool', server: ' gmail-2 ', tool: 'mcp__gmail-2__send_email' },
              { type: 'command', command: 'echo mcp__notion-2__x', if: 'mcp__notion-3__x(mcp__notion-2__y)' },
            ],
          },
        ],
      },
    }),
    'hooks/hooks.json': json([{ tool: '^mcp__linear-3__.*$', name: 'mcp__linear-2', action: 'deny' }, 'not a rule']),
    'connector-accounts-in-use.json': json({ gmail: 'gmail-2', notion: 'notion', jira: 'nobody', linear: '' }),
  },
  // The v145 shape: merged, every account with its id, the in-use records bound.
  merged: {
    'mixdog-config.json': json({
      agent: {
        mcpServers: {
          UnityMCP: { enabled: true, type: 'http', url: 'http://127.0.0.1:8080/mcp' },
          gmail: {
            type: 'http',
            url: accountsUrl('gmail'),
            connector: 'gmail',
            accounts: [
              { name: 'gmail', ...gmail('a@gmail.com'), connector: undefined, id: 'id-1' },
              { name: 'gmail-2', ...gmail('b@gmail.com'), connector: undefined, id: 'id-2' },
            ],
          },
        },
        extensionScopes: { skills: {}, mcp: {}, plugins: {} },
      },
    }),
    'agents/a1/agent.json': json({ name: 'a1', connectors: { off: ['gmail'], tools: { gmail: { send_email: 'auto' } } } }),
    'project-connectors.json': json({ projects: { 'C:\\Project\\A': { off: ['UnityMCP'] } } }),
    'connector-accounts-in-use.json': json({ notion: 'notion', gmail: { name: 'gmail-2', id: 'id-2' }, '#ids': true }),
  },
  // Merged before, but a store failed then: the pending record still maps it.
  pending: {
    'mixdog-config.json': json({
      agent: {
        mcpServers: {
          notion: {
            type: 'http',
            url: accountsUrl('notion'),
            connector: 'notion',
            accounts: [
              { name: 'notion', url: 'https://mcp.notion.com/mcp', id: 'n1' },
              { name: 'notion-2', url: 'https://mcp.notion.com/mcp', oauthKey: 'k2', id: 'n2' },
            ],
          },
        },
      },
    }),
    'connector-merge-pending.json': json({
      merged: [{ name: 'notion', from: ['notion', 'notion-2'] }, { name: 'bad' }],
    }),
    'agents/a1/agent.json': json({ name: 'a1', connectors: { off: ['notion-2'] } }),
    'connector-accounts-in-use.json': json({ notion: { name: 'notion-2', id: 'n2' }, '#ids': true }),
  },
  // Merged, an account written by hand without its id, records from before identities.
  ids: {
    'mixdog-config.json': json({
      agent: {
        mcpServers: {
          gmail: {
            type: 'http',
            url: accountsUrl('gmail'),
            connector: 'gmail',
            accounts: [
              { name: 'gmail', ...gmail('a@gmail.com'), connector: undefined, id: 'id-1' },
              { name: 'gmail-2', ...gmail('b@gmail.com'), connector: undefined },
              { name: 'no-transport' },
            ],
          },
        },
      },
    }),
    'connector-accounts-in-use.json': json({ gmail: 'gmail-2', notion: 'notion' }),
  },
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const relWalk = (dir) => walk(dir).map((path) => relative(dir, path).split('\\').join('/'));

// One case in this process, its data dir already the env's: prints the result.
async function runCase(dir) {
  const file = (rel) => join(dir, rel);
  const before = new Set(relWalk(dir));
  const inputText = before.size ? [...before].map((rel) => readFileSync(file(rel), 'utf8')).join('\n') : '';
  const { mergeConnectorAccountServers } = await import(pathToFileURL(join(src, 'runtime/shared/connector-catalog.mjs')));
  const { migrateMergedConnectorServers } = await import(pathToFileURL(join(src, 'session-runtime/connector-merge-migration.mjs')));
  const { extensionScopesFromConfig, withExtensionScope } = await import(pathToFileURL(join(src, 'runtime/shared/extension-scopes.mjs')));
  const { ensureConnectorAccountIds } = await import(pathToFileURL(join(src, 'runtime/connectors/connector-accounts-mcp.mjs')));
  const configFile = file('mixdog-config.json');
  const doc = JSON.parse(readFileSync(configFile, 'utf8'));
  // resource-mcp-api.mjs migrateConnectorAccounts over the `agent` section.
  const config = doc.agent ?? {};
  const { servers, merged } = mergeConnectorAccountServers(config.mcpServers);
  const settings = migrateMergedConnectorServers(dir, merged);
  if (merged.length && !(settings.unrecorded && settings.failed.length)) {
    let next = { ...config, mcpServers: servers };
    const scoped = extensionScopesFromConfig(config).mcp;
    for (const { name, from } of merged) {
      for (const gone of from) if (gone !== name && Object.hasOwn(scoped, gone)) next = withExtensionScope(next, 'mcp', gone, null);
    }
    writeFileSync(configFile, json({ ...doc, agent: next }));
  }
  ensureConnectorAccountIds();
  const after = JSON.parse(readFileSync(configFile, 'utf8'));
  const files = {};
  for (const rel of relWalk(dir).sort()) {
    if (rel === 'mixdog-config.json' || !(before.has(rel) || /^(agents|bots|hooks|project-connectors|connector-)/.test(rel))) continue;
    if (rel.endsWith('.lock')) continue;
    files[rel] = readFileSync(file(rel), 'utf8');
  }
  let output = JSON.stringify({
    merged: merged.map(({ name, from }) => ({ name, from })),
    failed: settings.failed.map((path) => relative(dir, path).split('\\').join('/')),
    mcpServers: after.agent?.mcpServers ?? null,
    extensionScopes: after.agent?.extensionScopes ?? null,
    files,
  });
  const ids = [];
  output = output.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, (id) => {
    if (inputText.includes(id)) return id;
    if (!ids.includes(id)) ids.push(id);
    return `<new-id-${ids.indexOf(id) + 1}>`;
  });
  process.stdout.write(output);
}

if (process.argv.includes('--case')) {
  await runCase(process.env.MIXDOG_DATA_DIR);
} else {
  const cases = [];
  for (const [name, tree] of Object.entries(CASES)) {
    const dir = mkdtempSync(join(tmpdir(), 'connector-merge-'));
    for (const [rel, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    const run = spawnSync(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), src, '--case'], {
      env: { ...process.env, MIXDOG_DATA_DIR: dir, MIXDOG_HOME: join(dir, '.home') },
      encoding: 'utf8',
    });
    if (run.status !== 0) throw new Error(`${name}: ${run.stderr}`);
    cases.push({ name, input: tree, ...JSON.parse(run.stdout) });
    rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(json({ cases }));
}
