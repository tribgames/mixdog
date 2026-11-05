// Records, from today's Node product, what the plugin registry edits (services/plugin-admin.mjs)
// answer and leave on disk, for local plugin sources (no network). The plugin folders sit at
// <base>/src/<name> and the data directory at <base>/data, both recreated here and by the Rust
// replay; <base> is masked in the output, timestamps become <TS>.
// Usage: node plugins.mjs <repo-root> <base-dir> <out.json>
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, base, out] = process.argv.slice(2);
const admin = await import(pathToFileURL(join(root, 'src', 'session-runtime', 'services', 'plugin-admin.mjs')).href);

const fixtures = {
  alpha: {
    '.codex-plugin/plugin.json': JSON.stringify({
      name: 'alpha-plugin',
      title: 'Alpha',
      version: '1.2.3',
      description: ' The alpha ',
      author: { name: 'Ann', email: 'ann@example.com', url: 'https://ann.example' },
      homepage: 'https://alpha.example',
      repository: { url: 'https://github.com/x/alpha' },
      license: { type: 'MIT' },
      keywords: ['one', ' two ', '', 5],
    }),
  },
  beta: {},
  gamma: {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'gamma', displayName: 'Gamma Display', author: ' Bob ', keywords: 'solo', repository: 'git://g', license: 'ISC' }),
  },
  delta: { 'plugin.json': '{ not json' },
  eps: { 'plugin.json': JSON.stringify({ id: 'eps-id', version: 3, description: {}, author: 7, keywords: null }) },
};
const dataDir = join(base, 'data');
rmSync(base, { recursive: true, force: true });
for (const [name, files] of Object.entries(fixtures)) {
  mkdirSync(join(base, 'src', name), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, 'src', name, rel)), { recursive: true });
    writeFileSync(join(base, 'src', name, rel), text);
  }
}
const src = (name) => join(base, 'src', name);

// Masks JSON text: the base directory as it is written in JSON, timestamps, random suffixes.
const maskText = (text) =>
  text
    .split(JSON.stringify(base).slice(1, -1)).join('<BASE>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<TS>')
    .replace(/\.corrupt-\d+/g, '.corrupt-<N>')
    .replace(/mixdog-tmp-[0-9a-f]+/g, 'mixdog-tmp-<H>');
const mask = (value) => JSON.parse(maskText(JSON.stringify(value ?? null)));
const files = () => {
  const dir = join(dataDir, 'plugins');
  return existsSync(dir) ? readdirSync(dir).map((n) => n.replace(/\.corrupt-\d+/, '.corrupt-<N>')).sort() : [];
};
const registry = () => {
  const path = join(dataDir, 'plugins', 'registry.json');
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

const steps = [];
const step = async (name, op, args, fn) => {
  let result = null;
  let error = null;
  try {
    result = await fn();
  } catch (e) {
    error = e.message;
  }
  steps.push({ name, op, args, result: mask(result), error: error === null ? null : mask(error), registry: registry() === null ? null : maskText(registry()), files: files() });
};
const opts = { dataDir };
const A = (name, input, extra) => step(name, 'add', [input, extra ?? null], () => admin.addPlugin(input, { dataDir, ...(extra ? { name: extra } : {}) }));

await step('status of an empty store', 'status', [], () => admin.pluginAdminStatus(opts));
await A('add: empty', '');
await A('add: blank', '   ');
await A('add: http url', 'http://example.com/x/y.git');
await A('add: url with password', 'https://user:pw@example.com/x/y.git');
await A('add: https url with a user', 'https://user@example.com/x/y.git');
await A('add: missing path', join(base, 'src', 'nope'));
await A('add: alpha', src('alpha'));
await A('add: beta with a name', src('beta'), ' Beta Name ');
await A('add: gamma', src('gamma'));
await A('add: delta (broken manifest)', src('delta'));
await A('add: eps', src('eps'));
await A('add: alpha again', src('alpha'));
await A('add: alpha with a trailing slash', src('alpha') + '/');
await step('status after adds', 'status', [], () => admin.pluginAdminStatus(opts));
const sets = [
  ['alpha', false], ['alpha', true], ['Gamma Display', false], ['gamma', undefined], ['Beta Name', false],
  ['ghost', true], ['', true], ['  alpha-plugin ', true], ['alpha-plugin', 'no'], ['alpha-plugin', null], ['alpha-plugin', 0],
];
for (const [key, enabled] of sets) {
  await step(`enable ${JSON.stringify(key)} ${JSON.stringify(enabled)}`, 'enable', [key, enabled ?? null, enabled === undefined], () => admin.setPluginEnabled(key, enabled, opts));
}
await step('update unknown', 'update', ['ghost'], () => admin.updatePlugin('ghost', opts));
await step('update empty', 'update', [''], () => admin.updatePlugin('', opts));
await step('update alpha by name', 'update', ['alpha-plugin'], () => admin.updatePlugin('alpha-plugin', opts));
writeFileSync(join(src('alpha'), '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha-renamed', version: '2.0.0' }));
await step('update alpha after its manifest changed', 'update', ['Alpha'], () => admin.updatePlugin('Alpha', opts));
await step('status after updates', 'status', [], () => admin.pluginAdminStatus(opts));
rmSync(src('eps'), { recursive: true, force: true });
await step('status with a missing folder', 'status', [], () => admin.pluginAdminStatus(opts));
await step('remove beta', 'remove', ['Beta Name'], () => admin.removePlugin('Beta Name', opts));
await step('remove beta again', 'remove', ['Beta Name'], () => admin.removePlugin('Beta Name', opts));
await step('remove empty', 'remove', [''], () => admin.removePlugin('', opts));
await step('remove ghost', 'remove', ['ghost'], () => admin.removePlugin('ghost', opts));
const reg = join(dataDir, 'plugins', 'registry.json');
writeFileSync(reg, '\0\0\0\0');
await step('status with a NUL-filled registry (restored from the backup)', 'status', [], () => admin.pluginAdminStatus(opts));
writeFileSync(reg, '{"version":1}');
rmSync(`${reg}.bak`, { force: true });
await step('status with a registry that has no list and no backup', 'status', [], () => admin.pluginAdminStatus(opts));
await A('add: gamma into the emptied store', src('gamma'));
writeFileSync(reg, '\ufeff' + registry());
await step('status with a byte order mark', 'status', [], () => admin.pluginAdminStatus(opts));

writeFileSync(out, `${JSON.stringify({ base, fixtures, steps })}\n`);
console.log(`recorded ${steps.length} steps`);
process.exit(0);
