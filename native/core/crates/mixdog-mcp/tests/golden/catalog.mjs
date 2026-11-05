// Records, from today's Node product, the effective MCP server catalog of configured servers
// plus plugin-declared ones (session-runtime/mcp-glue/plugin-servers.mjs), and the config edits
// that adopt earlier copies. Usage: node catalog.mjs <repo-root> <out.json>.
// Paths in the output are made stable: `<R:id>` is a plugin's root, `<D>` the data dir, `<C>` the cwd.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(root, 'src', rel)).href);
const glue = await load('session-runtime/mcp-glue/plugin-servers.mjs');

const mcp = (servers) => JSON.stringify({ mcpServers: servers });
const node = (extra = {}) => ({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], ...extra });
const claude = (manifest = {}) => ({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'x', ...manifest }) });

const cases = [
  {
    name: 'one declared server',
    plugins: [{ id: 'acme', name: 'Acme', files: { '.mcp.json': mcp({ search: node() }) } }],
  },
  {
    name: 'key repeats the plugin',
    plugins: [{ id: 'acme-1a2b3c4d', name: 'Acme', files: { '.mcp.json': mcp({ acme: node() }) } }],
  },
  {
    name: 'long names get a hash suffix',
    plugins: [
      { id: 'a-very-long-plugin-identifier-here', name: 'Long', files: { '.mcp.json': mcp({ 'another-long-key': node() }) } },
    ],
  },
  {
    name: 'plugins without id or root are skipped',
    plugins: [
      { id: '', name: 'blank', files: { '.mcp.json': mcp({ a: node() }) } },
      { id: 'gone', name: 'Gone', exists: false, files: {} },
      { id: 'noroot', name: 'NoRoot', noRoot: true, files: {} },
      { id: 'fine', name: 'Fine', files: { '.mcp.json': mcp({ a: node() }) } },
    ],
  },
  {
    name: 'disabled plugin keeps its servers off',
    plugins: [{ id: 'off', name: 'Off', enabled: false, files: { '.mcp.json': mcp({ a: node(), b: { url: 'https://x.test/mcp' } }) } }],
  },
  {
    name: 'server declared off, intent turns it on',
    plugins: [{ id: 'acme', name: 'Acme', files: { '.mcp.json': mcp({ a: node({ enabled: false }), b: node({ enabled: false }) }) } }],
    config: { pluginMcp: { acme: { a: { enabled: true }, b: { enabled: false } } } },
  },
  {
    name: 'intent overrides layer over the declaration',
    plugins: [
      {
        id: 'acme',
        name: 'Acme',
        files: { '.mcp.json': mcp({ a: node({ env: { A: '1', B: '2' }, headers: { H: 'x' } }) }) },
      },
    ],
    config: {
      pluginMcp: {
        acme: {
          a: { env: { B: '9', C: '3', D: null }, command: 'deno', args: ['run'], timeoutMs: 5, junk: 1 },
          '': { enabled: false },
          b: {},
        },
        '  ': { a: { enabled: false } },
        other: 'x',
      },
    },
  },
  {
    name: 'kept alias wins, collisions get a suffix',
    plugins: [
      { id: 'one', name: 'One', files: { '.mcp.json': mcp({ a: node() }) } },
      { id: 'two', name: 'Two', files: { '.mcp.json': mcp({ a: node() }) } },
    ],
    config: { pluginMcp: { two: { a: { alias: 'mine' } } }, mcpServers: { 'plugin-one-a': { command: 'x' }, mine2: { command: 'y' } } },
  },
  {
    name: 'a later plugin takes a taken generated name',
    plugins: [
      { id: 'dup', name: 'Dup1', files: { '.mcp.json': mcp({ a: node() }) } },
      { id: 'dup-aaaaaaaa', name: 'Dup2', files: { '.mcp.json': mcp({ a: node() }) } },
    ],
  },
  {
    name: 'alias taken by a configured server',
    plugins: [{ id: 'one', name: 'One', files: { '.mcp.json': mcp({ a: node() }) } }],
    config: { pluginMcp: { one: { a: { alias: 'cfg' } } }, mcpServers: { cfg: { command: 'z' } } },
  },
  {
    name: 'transports and cwd rules',
    plugins: [
      { id: 'mix', name: 'Mixdog', files: { 'plugin.json': JSON.stringify({ name: 'mix', mcpServers: { s: { command: 'a' }, w: { cwd: 'sub/dir', command: 'b' }, r: { cwd: '${PLUGIN_ROOT}/x', command: 'c' } } }) } },
      { id: 'cla', name: 'Claude', files: { ...claude({ mcpServers: { s: { command: 'a' }, d: { command: 'b', cwd: 'rel' }, h: { url: 'https://h.test/${PLUGIN_DATA}/${MIXDOG_PLUGIN_ROOT}', headers: { A: '${CLAUDE_PLUGIN_DATA}' } } } }) } },
    ],
    cwd: '@C@',
  },
  {
    name: 'no session cwd',
    plugins: [{ id: 'cla', name: 'Claude', files: { ...claude({ mcpServers: { s: { command: 'a' } } }) } }],
    cwd: '',
  },
  {
    name: 'declaration errors surface per plugin',
    plugins: [
      { id: 'bad', name: 'Bad', files: { '.mcp.json': '{ not json', '.claude-plugin/plugin.json': JSON.stringify({ mcpServers: ['missing.json', 5, { x: { type: 'nope' } }, { y: {} }] }) } },
      { id: 'empty', name: 'Empty', files: { 'README.md': 'x' } },
    ],
  },
  {
    name: 'array and path declarations merge in order',
    plugins: [
      {
        id: 'many',
        name: 'Many',
        files: {
          '.mcp.json': mcp({ z: node(), a: node() }),
          '.claude-plugin/plugin.json': JSON.stringify({ mcpServers: ['./extra.json', { b: node(), z: { command: 'over' } }] }),
          'extra.json': mcp({ e: node(), a: { command: 'again' } }),
        },
      },
    ],
  },
  {
    name: 'earlier copy is adopted as intent',
    plugins: [{ id: 'acme', name: 'Acme', files: { '.mcp.json': mcp({ search: node() }) } }],
    config: {
      mcpServers: {
        'plugin-acme': { command: 'node', args: ['@R:acme@/server.js'], env: { MIXDOG_PLUGIN_ROOT: '@R:acme@', TOKEN: 't' }, enabled: false },
        keep: { command: 'x' },
      },
    },
  },
  {
    name: 'copies of several servers',
    plugins: [{ id: 'acme', name: 'Acme', files: { '.mcp.json': mcp({ one: node(), two: { url: 'https://two.test/mcp' } }) } }],
    config: {
      mcpServers: {
        'plugin-acme--one': { command: 'node', args: ['@R:acme@/server.js'], env: { MIXDOG_PLUGIN_ROOT: '@R:acme@' }, _mixdogPluginDisabled: true },
        'plugin-acme--two': { url: 'https://two.test/mcp', env: { MIXDOG_PLUGIN_ROOT: '@R:acme@/' }, headers: { A: 'b' } },
        'plugin-acme--gone': { command: 'x', env: { MIXDOG_PLUGIN_ROOT: '@R:acme@' } },
        'plugin-acme': { command: 'x', env: { MIXDOG_PLUGIN_ROOT: '@R:acme@' } },
        'other-name': { command: 'x', env: { MIXDOG_PLUGIN_ROOT: '@R:acme@' } },
        stranger: { command: 'x', env: { MIXDOG_PLUGIN_ROOT: 'C:\\nowhere' } },
      },
    },
  },
  {
    name: 'copy whose transport changed is left alone',
    plugins: [{ id: 'acme', name: 'Acme', files: { '.mcp.json': mcp({ search: node() }) } }],
    config: {
      mcpServers: {
        'plugin-acme': { type: 'http', url: 'https://x.test', env: { MIXDOG_PLUGIN_ROOT: '@R:acme@' } },
      },
      pluginMcp: { acme: { search: { alias: 'taken-by-other' } } },
    },
  },
  {
    name: 'copy of a plugin whose directory is gone',
    plugins: [{ id: 'acme', name: 'Acme', exists: false, files: {} }],
    config: { mcpServers: { 'plugin-acme': { command: 'x', env: { MIXDOG_PLUGIN_ROOT: '@R:acme@' }, _mixdogPluginDisabled: true } } },
  },
  {
    name: 'copy overrides map fields and cwd',
    plugins: [{ id: 'acme', name: 'Acme', files: { '.mcp.json': mcp({ search: node({ env: { A: '1' }, cwd: 'work' }) }) } }],
    config: {
      mcpServers: {
        'plugin-acme': {
          command: 'node',
          args: ['@R:acme@/server.js'],
          cwd: '@R:acme@/work',
          env: { MIXDOG_PLUGIN_ROOT: '@R:acme@', A: '1', B: '2' },
          startupTimeoutMs: 9,
        },
      },
    },
  },
  {
    name: 'copy dropping a declared entry is left alone',
    plugins: [{ id: 'acme', name: 'Acme', files: { '.mcp.json': mcp({ search: node({ env: { A: '1' } }) }) } }],
    config: { mcpServers: { 'plugin-acme': { command: 'node', args: ['@R:acme@/server.js'], env: { MIXDOG_PLUGIN_ROOT: '@R:acme@' } } } },
  },
  {
    name: 'a generated collision name is pinned',
    plugins: [{ id: 'one', name: 'One', files: { '.mcp.json': mcp({ a: node() }) } }],
    config: { mcpServers: { 'plugin-one-a': { command: 'x' } } },
  },
  {
    name: 'configured servers pass through',
    plugins: [],
    config: { mcpServers: { a: { command: 'x', _mixdogPluginDisabled: true }, b: 5, c: null } },
  },
];

function fill(value, roots, cwd) {
  if (typeof value === 'string') {
    return value.replace(/@R:([^@]+)@/g, (_, id) => roots[id]).replace(/@C@/g, cwd);
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, roots, cwd));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, roots, cwd)]));
  return value;
}

const base = mkdtempSync(join(tmpdir(), 'catalog-golden-'));
const cwdPath = join(base, 'session-cwd');
const dataDir = join(base, 'data');
const recorded = [];
for (const [index, spec] of cases.entries()) {
  const dir = join(base, `case${index}`);
  const roots = {};
  const rows = [];
  for (const plugin of spec.plugins) {
    const rootPath = join(dir, plugin.id || 'blank');
    roots[plugin.id] = rootPath;
    if (plugin.exists !== false) {
      mkdirSync(rootPath, { recursive: true });
      for (const [rel, text] of Object.entries(plugin.files)) {
        mkdirSync(dirname(join(rootPath, rel)), { recursive: true });
        writeFileSync(join(rootPath, rel), text);
      }
    }
    const row = { id: plugin.id, name: plugin.name, root: plugin.noRoot ? '' : rootPath };
    if (plugin.enabled !== undefined) row.enabled = plugin.enabled;
    if (plugin.exists !== undefined) row.exists = plugin.exists;
    rows.push(row);
  }
  const cwd = spec.cwd === undefined ? '@C@' : spec.cwd;
  const config = fill(spec.config || {}, roots, cwdPath);
  const catalog = glue.resolveMcpServerCatalog({ config, plugins: rows, cwd: fill(cwd, roots, cwdPath), dataDir });
  const adopted = glue.withAdoptedCopies(config, catalog.adoption);
  const pinned = glue.withPinnedCollisionNames(adopted, catalog);
  const ids = spec.plugins.map((p) => p.id).filter(Boolean);
  const stable = (value) => {
    let text = JSON.stringify(value === undefined ? null : value);
    for (const [id, path] of Object.entries(roots)) {
      const escaped = JSON.stringify(path).slice(1, -1);
      const slashed = JSON.stringify(path.replace(/\\/g, '/')).slice(1, -1);
      text = text.split(escaped).join(`<R:${id}>`).split(slashed).join(`<Rs:${id}>`);
    }
    for (const [token, path] of [['<D>', dataDir], ['<C>', cwdPath]]) {
      text = text.split(JSON.stringify(path).slice(1, -1)).join(token).split(JSON.stringify(path.replace(/\\/g, '/')).slice(1, -1)).join(token.replace('>', 's>'));
    }
    return JSON.parse(text);
  };
  recorded.push({
    name: spec.name,
    plugins: spec.plugins.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, exists: p.exists, noRoot: p.noRoot, files: p.files })),
    config: spec.config || {},
    cwd: spec.cwd === undefined ? '@C@' : spec.cwd,
    catalog: stable(catalog),
    adopted: stable(adopted),
    pinned: stable(pinned),
    withoutFirst: ids.length ? stable(glue.withoutPluginIntents(config, ids[0])) : null,
    withIntent: ids.length ? stable(glue.withPluginServerIntent(config, ids[0], 'k', (intent) => ({ ...intent, enabled: false, alias: 'al' }))) : null,
    withIntentCleared: ids.length ? stable(glue.withPluginServerIntent(config, ids[0], 'search', () => ({}))) : null,
  });
}
writeFileSync(out, JSON.stringify({ cases: recorded }, null, 1));
