// Records, from today's Node product, which desktop bridges `builtinFeatureActive` finds up
// (`bridgePresent`, over `readBridgeDiscovery`): browser, computer, terminal and visualize.
// Each case lays out discovery files in a fresh folder, with an age per file, sets the
// environment, and asks all four ids. `{alive}` is a pid of a running process (the recorder's own;
// the replay uses its own), `{dir}` the case's discovery folder.
// Usage: node bridge.mjs <repo-root> <out.json>
// Every user location is pointed at temp folders BEFORE any Mixdog module loads.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2, 4);
const scratch = mkdtempSync(join(tmpdir(), 'bridge-golden-'));
for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR']) {
  process.env[name] = join(scratch, name.toLowerCase());
  mkdirSync(process.env[name], { recursive: true });
}
delete process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
for (const name of Object.keys(process.env)) if (name.startsWith('MIXDOG_FEATURE_')) delete process.env[name];

const FILES = { browser: 'browser-bridge.json', computer: 'computer-bridge.json', terminal: 'terminal-bridge.json', visualize: 'visualize-bridge.json' };
const IDS = Object.keys(FILES);
const good = (extra = {}) => JSON.stringify({ version: 1, port: 4100, token: 't0k', pid: '{alive}', ...extra });
const all = (text, ageSec = 5) => Object.fromEntries(IDS.map((id) => [FILES[id], { text, ageSec }]));

const cases = [
  { name: 'no files', files: {} },
  { name: 'all four up', files: all(good()) },
  { name: 'only browser', files: { [FILES.browser]: { text: good(), ageSec: 5 } } },
  { name: 'only visualize', files: { [FILES.visualize]: { text: good(), ageSec: 5 } } },
  { name: 'no pid field', files: all(JSON.stringify({ version: 1, port: 4100, token: 't0k' })) },
  { name: 'pid zero', files: all(good({ pid: 0 })) },
  { name: 'pid negative', files: all(good({ pid: -4 })) },
  { name: 'pid fractional', files: all(good({ pid: 2.5 })) },
  { name: 'pid text', files: all(good({ pid: 'abc' })) },
  { name: 'pid null', files: all(good({ pid: null })) },
  { name: 'pid numeric text alive', files: all(good({ pid: '{alive}' })) },
  { name: 'pid of an exited process', files: all(good({ pid: 2147483646 })) },
  { name: 'version 2', files: all(good({ version: 2 })) },
  { name: 'version text', files: all(good({ version: '1' })) },
  { name: 'version missing', files: all(JSON.stringify({ port: 4100, token: 't0k', pid: '{alive}' })) },
  { name: 'port zero', files: all(good({ port: 0 })) },
  { name: 'port too big', files: all(good({ port: 65536 })) },
  { name: 'port max', files: all(good({ port: 65535 })) },
  { name: 'port fractional', files: all(good({ port: 80.5 })) },
  { name: 'port text', files: all(good({ port: '8080' })) },
  { name: 'port text junk', files: all(good({ port: 'x' })) },
  { name: 'port null', files: all(good({ port: null })) },
  { name: 'token empty', files: all(good({ token: '' })) },
  { name: 'token missing', files: all(JSON.stringify({ version: 1, port: 4100, pid: '{alive}' })) },
  { name: 'token number', files: all(good({ token: 7 })) },
  { name: 'token zero', files: all(good({ token: 0 })) },
  { name: 'file fresh at four minutes', files: all(good(), 240) },
  { name: 'file expired at six minutes', files: all(good(), 360) },
  { name: 'file expired long ago', files: all(good(), 86400) },
  { name: 'json null', files: all('null') },
  { name: 'json array', files: all('[1]') },
  { name: 'json string', files: all('"x"') },
  { name: 'json broken', files: all('{"version":1,') },
  { name: 'file empty', files: all('') },
  { name: 'file is a folder', dirs: IDS.map((id) => FILES[id]), files: {} },
  { name: 'mixed: browser up, computer expired, terminal broken', files: {
    [FILES.browser]: { text: good(), ageSec: 5 },
    [FILES.computer]: { text: good(), ageSec: 900 },
    [FILES.terminal]: { text: '{', ageSec: 5 },
  } },
  { name: 'env on without a file', files: {}, env: { MIXDOG_FEATURE_BROWSER: '1', MIXDOG_FEATURE_COMPUTER: 'yes', MIXDOG_FEATURE_TERMINAL: ' TRUE ', MIXDOG_FEATURE_VISUALIZE: 'on' } },
  { name: 'env off with files', files: all(good()), env: { MIXDOG_FEATURE_BROWSER: '0', MIXDOG_FEATURE_COMPUTER: 'false', MIXDOG_FEATURE_TERMINAL: 'No', MIXDOG_FEATURE_VISUALIZE: 'OFF' } },
  { name: 'env blank defers to the file', files: all(good()), env: { MIXDOG_FEATURE_BROWSER: '  ', MIXDOG_FEATURE_COMPUTER: '' } },
  { name: 'visualize module off', files: all(good()), config: { modules: { visualize: { enabled: false } } } },
  { name: 'visualize module off, env on', files: all(good()), config: { modules: { visualize: { enabled: false } } }, env: { MIXDOG_FEATURE_VISUALIZE: '1' } },
  { name: 'visualize module off, no file', files: {}, config: { modules: { visualize: { enabled: false } } } },
  { name: 'discovery dir set', files: all(good()), where: 'discovery' },
  { name: 'data dir only', files: all(good()), where: 'data' },
  { name: 'home only', files: all(good()), where: 'home' },
  { name: 'files in the data dir while a discovery dir is set', files: all(good()), where: 'data', env: { MIXDOG_BRIDGE_DISCOVERY_DIR: '{other}' } },
  { name: 'empty discovery dir variable falls through', files: all(good()), where: 'data', env: { MIXDOG_BRIDGE_DISCOVERY_DIR: '' } },
];

const features = await import(pathToFileURL(join(root, 'src/runtime/agent/orchestrator/runtime-core/builtin-features.mjs')).href);
const SET = ['MIXDOG_BRIDGE_DISCOVERY_DIR', 'MIXDOG_DATA_DIR', 'MIXDOG_HOME'];
const recorded = [];
for (const [index, c] of cases.entries()) {
  const folder = join(scratch, `case${index}`);
  const dirs = { discovery: join(folder, 'discovery'), data: join(folder, 'data'), home: join(folder, 'home', 'data'), other: join(folder, 'other') };
  const where = c.where ?? 'discovery';
  for (const name of SET) delete process.env[name];
  for (const name of Object.keys(process.env)) if (name.startsWith('MIXDOG_FEATURE_')) delete process.env[name];
  if (where === 'discovery') process.env.MIXDOG_BRIDGE_DISCOVERY_DIR = dirs.discovery;
  if (where === 'data') process.env.MIXDOG_DATA_DIR = dirs.data;
  if (where === 'home') process.env.MIXDOG_HOME = join(folder, 'home');
  if (where !== 'home') process.env.MIXDOG_HOME = join(folder, 'unused-home');
  for (const [name, value] of Object.entries(c.env ?? {})) process.env[name] = value.replaceAll('{other}', dirs.other);
  const dir = dirs[where];
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const [file, { text, ageSec }] of Object.entries(c.files)) {
    const path = join(dir, file);
    writeFileSync(path, text.replaceAll('{alive}', String(process.pid)));
    const at = new Date(now - ageSec * 1000);
    utimesSync(path, at, at);
  }
  for (const file of c.dirs ?? []) mkdirSync(join(dir, file), { recursive: true });
  const answer = Object.fromEntries(IDS.map((id) => [id, features.builtinFeatureActive(c.config, id)]));
  recorded.push({ name: c.name, where, files: c.files, dirs: c.dirs ?? [], env: c.env ?? {}, config: c.config ?? null, answer });
}
rmSync(scratch, { recursive: true, force: true });
writeFileSync(out, `${JSON.stringify({ cases: recorded }, null, 2)}\n`);
