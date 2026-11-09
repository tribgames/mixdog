#!/usr/bin/env node
// The user-data guard (runtime/shared/user-data-guard.mjs) and the config layer's use of it
// (runtime/shared/config.mjs: readConfig, updateConfig): the real functions run over representative
// data dirs. Every scenario is a list of operations over one dir (`root/data` is the data dir,
// `root/mhome` MIXDOG_HOME, `root/home` the home directory); the full directory tree left behind,
// each operation's answer, and what it wrote to stderr are recorded. Rust `mixdog_core_config::user_data`
// and `Config` must reproduce all three.
//
//   node benchmarks/rust-core/recorders/record-user-data-guard.mjs --tree <git checkout at the commit> --commit <40-hex id>
//
// The tree must be a clean git checkout of exactly that commit (commitCheckoutIdentity refuses anything else).
//
// Output: native/core/fixtures/user-data-guard/golden.json.
//
// Node's own nondeterminism is fixed, not filtered: `Date` and `crypto.randomUUID` are replaced before the
// modules load (the clock is set by each operation's `at`; ids count up from 1). The scenario root is a
// temp dir, so its path is replaced by `<root>` wherever it appears (file contents, answers, log lines), and
// the scope folder name (a hash of that path) by `<scope>`; `scopeName` and `dataDirKey` keep the real ones
// so a replay can check the hash. File modes are not recorded: this recording is made on Windows, where
// Node's modes are advisory.
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const CFG = '{"defaultsVersion":2,"agent":{"lead":"x"},"mix":{"v":1}}';
const CFG_B = '{"defaultsVersion":2,"agent":{"lead":"y"},"mix":{"v":2}}';
const SINGLE = '{"mix":{"v":9}}';
const ID1 = '00000000-0000-4000-8000-000000000001';
const T = 1_790_000_000_000;

const file = (path, text) => ({ op: 'file', path, text });
const manifest = (id) => `{"dataDir":"$DATA_J","instanceId":${JSON.stringify(id)},"reason":"made","createdAt":"2026-01-01T00:00:00.000Z"}`;
const legacyManifest = '{"dataDir":"$DATA_J","reason":"made","createdAt":"2026-01-01T00:00:00.000Z"}';
const at = (n, op) => ({ at: T + n * 1000, ...op });
const seq = (ops) => ops.map((op, i) => (op.at ? op : at(i, op)));
const withData = (...ops) => [file('data/.keep', ''), ...ops];
const SCOPE = 'mhome/backups/user-data/scope-$SCOPE';
const LEGACY = 'home/.mixdog/backups/user-data';

// An initialized dir: a config written through the config layer (marker, pre/post snapshots).
const initialized = [file('data/mixdog-config.json', CFG), { op: 'update', set: { zz: 1 } }];

const SCENARIOS = [
  { name: 'fresh dir: a read answers empty and writes nothing', ops: seq([{ op: 'read' }]) },
  { name: 'fresh dir: the first update writes the config, marker and both snapshots', ops: seq([...withData(), { op: 'update', set: { mix: { v: 1 } } }, { op: 'read' }]) },
  { name: 'upgraded dir: a readable config without a marker gets marker and first snapshot once', ops: seq([...withData(file('data/mixdog-config.json', CFG)), { op: 'read' }, { op: 'read' }, { op: 'ensure' }]) },
  { name: 'a write is wrapped in pre and post snapshots', ops: seq([file('data/mixdog-config.json', CFG), { op: 'read' }, { op: 'update', set: { mix: { v: 3 } } }, { op: 'update', set: { mix: { v: 4 } } }]) },
  { name: 'a write with no change snapshots nothing', ops: seq([file('data/mixdog-config.json', CFG), { op: 'read' }, { op: 'update', set: {} }]) },
  { name: 'initialized, config missing, backups: a read restores and saves', ops: seq([...initialized, { op: 'rm', path: 'data/mixdog-config.json' }, { op: 'read' }, { op: 'read' }]) },
  { name: 'initialized, config missing, no backups: a read answers empty', ops: seq([...withData(), { op: 'mark' }, { op: 'read' }, { op: 'expected' }]) },
  { name: 'initialized, config missing, no backups: an update refuses', ops: seq([...withData(), { op: 'mark' }, { op: 'update', set: { mix: { v: 1 } } }]) },
  { name: 'initialized, config missing, backups: an update restores first', ops: seq([...initialized, { op: 'rm', path: 'data/mixdog-config.json' }, { op: 'update', set: { extra: true } }]) },
  { name: 'malformed config with backups: a read keeps it aside and restores', ops: seq([...initialized, file('data/mixdog-config.json', '{"agent":'), { op: 'read' }, { op: 'read' }]) },
  { name: 'malformed config without backups: a read keeps it aside and answers empty', ops: seq([...withData(file('data/mixdog-config.json', '{bad')), { op: 'read' }, { op: 'read' }]) },
  { name: 'malformed config without backups: an update starts empty', ops: seq([...withData(file('data/mixdog-config.json', '{bad')), { op: 'mark' }, { op: 'update', set: { mix: { v: 1 } } }]) },
  { name: 'malformed config with backups: an update restores first', ops: seq([...initialized, file('data/mixdog-config.json', 'not json'), { op: 'update', set: { extra: true } }]) },
  { name: 'a config that is not an object: a read answers empty', ops: seq([...withData(file('data/mixdog-config.json', '[1,2]')), { op: 'read' }]) },
  { name: 'a config that is not an object: an update keeps it aside', ops: seq([...initialized, file('data/mixdog-config.json', '"text"'), { op: 'update', set: { extra: true } }]) },
  { name: 'a config of null: a read restores from backup', ops: seq([...initialized, file('data/mixdog-config.json', 'null'), { op: 'read' }]) },
  { name: 'two quarantines in one millisecond take distinct names', ops: seq([...initialized, file('data/mixdog-config.json', '{a'), at(5, { op: 'read' }), file('data/mixdog-config.json', '{b'), at(5, { op: 'read' })]) },
  { name: 'incarnation mismatch: a backup of another incarnation is not restored', ops: seq([...initialized, { op: 'rm', path: 'data/mixdog-config.json' }, file('data/.mixdog-user-data.json', '{"instanceId":"other","dataDir":"$DATA_J","createdAt":"x"}'), { op: 'read' }, { op: 'loadLatest', fresh: true }]) },
  { name: 'a recreated dir at the same path starts fresh', ops: seq([...initialized, { op: 'rm', path: 'data' }, ...withData(), { op: 'read' }, { op: 'expected' }, { op: 'update', set: { mix: { v: 1 } } }]) },
  { name: 'damaged marker: unparseable', ops: seq([...withData(file('data/.mixdog-user-data.json', '{oops')), { op: 'read' }, { op: 'update', set: { mix: { v: 1 } } }, { op: 'mark' }, { op: 'expected' }]) },
  { name: 'damaged marker: no instanceId', ops: seq([...withData(file('data/.mixdog-user-data.json', '{"instanceId":""}'), file('data/mixdog-config.json', CFG)), { op: 'read' }, { op: 'backup', reason: 'x' }]) },
  { name: 'damaged marker: a snapshot of a readable config fails', ops: seq([...withData(file('data/.mixdog-user-data.json', '[]'), file('data/mixdog-config.json', CFG)), { op: 'backup', reason: 'x' }, { op: 'ensure' }]) },
  { name: 'an existing marker is never replaced', ops: seq([...initialized, { op: 'mark' }, { op: 'mark' }]) },
  { name: 'no marker without a data dir', ops: seq([{ op: 'mark' }, { op: 'backup', reason: 'x' }]) },
  { name: 'scoped backups: the newest complete one wins, incomplete ones are skipped', ops: seq([...withData(), { op: 'mark' },
    file(`${SCOPE}/2026-01-01T00-00-00-000Z-0001-old/backup.json`, manifest(ID1)), file(`${SCOPE}/2026-01-01T00-00-00-000Z-0001-old/mixdog-config.json`, CFG),
    file(`${SCOPE}/2026-01-02T00-00-00-000Z-0001-new/backup.json`, manifest(ID1)), file(`${SCOPE}/2026-01-02T00-00-00-000Z-0001-new/mixdog-config.json`, CFG_B),
    file(`${SCOPE}/2026-01-03T00-00-00-000Z-0001-single/backup.json`, manifest(ID1)), file(`${SCOPE}/2026-01-03T00-00-00-000Z-0001-single/mixdog-config.json`, SINGLE),
    file(`${SCOPE}/2026-01-04T00-00-00-000Z-0001-nomanifest/mixdog-config.json`, CFG),
    { op: 'loadLatest', fresh: true }, { op: 'read' }]) },
  { name: 'unscoped backups with this incarnation are used when the scope has none', ops: seq([...withData(), { op: 'mark' },
    file(`${LEGACY.replace('home/.mixdog', 'mhome')}/2026-01-01T00-00-00-000Z-old/backup.json`, manifest(ID1)), file(`${LEGACY.replace('home/.mixdog', 'mhome')}/2026-01-01T00-00-00-000Z-old/mixdog-config.json`, CFG_B),
    { op: 'loadLatest', fresh: true }, { op: 'read' }]) },
  { name: 'a backup of another data dir is not restored', ops: seq([...withData(), { op: 'mark' },
    file(`${SCOPE}/2026-01-01T00-00-00-000Z-0001-x/backup.json`, '{"dataDir":"$ROOT_J\\\\elsewhere","instanceId":"' + ID1 + '","reason":"x"}'), file(`${SCOPE}/2026-01-01T00-00-00-000Z-0001-x/mixdog-config.json`, CFG),
    { op: 'loadLatest', fresh: true }]) },
  { name: 'legacy unscoped backup naming this dir (no marker): read restores, update restores', ops: seq([...withData(),
    file(`${LEGACY}/2026-01-01T00-00-00-000Z-old/backup.json`, legacyManifest), file(`${LEGACY}/2026-01-01T00-00-00-000Z-old/mixdog-config.json`, CFG),
    { op: 'expected' }, { op: 'legacy' }, { op: 'read' }, { op: 'read' }]) },
  { name: 'legacy update restores the legacy backup', ops: seq([...withData(),
    file(`${LEGACY}/2026-01-01T00-00-00-000Z-old/backup.json`, legacyManifest), file(`${LEGACY}/2026-01-01T00-00-00-000Z-old/mixdog-config.json`, CFG),
    { op: 'update', set: { extra: 1 } }]) },
  { name: 'legacy marker without a verifiable backup: read is empty, update refuses', ops: seq([...withData(),
    file(`${LEGACY}/.initialized-0123456789abcdef.json`, '{"dataDir":"$DATA_J"}'),
    { op: 'expected' }, { op: 'legacy', fresh: true }, { op: 'read' }, { op: 'update', set: { extra: 1 } }]) },
  { name: 'legacy backup without a manifest is never restored', ops: seq([...withData(),
    file(`${LEGACY}/2026-01-01T00-00-00-000Z-old/mixdog-config.json`, CFG),
    { op: 'expected' }, { op: 'legacy' }, { op: 'read' }]) },
  { name: 'a migrated dir (scoped backups exist) has no legacy evidence', ops: seq([...initialized, { op: 'rm', path: 'data/.mixdog-user-data.json' },
    file(`${LEGACY}/.initialized-0123456789abcdef.json`, '{"dataDir":"$DATA_J"}'), { op: 'legacy', fresh: true }, { op: 'expected', fresh: true }]) },
  { name: 'retention keeps the newest forty', ops: seq([file('data/mixdog-config.json', CFG), { op: 'backup', reason: 'many', repeat: 44, step: true }]) },
  { name: 'a snapshot carries schedules, webhooks, workflows and the extra folders', ops: seq([file('data/mixdog-config.json', CFG), file('data/schedules/a.json', '{"s":1}'), file('data/webhooks/w/b.json', '{}'), file('data/workflows/c.md', 'wf'), file('data/agents/x.md', 'ag'), file('data/bots/y.json', '{}'), file('data/other/z.txt', 'no'),
    { op: 'backup', reason: 'plain' }, { op: 'backup', reason: 'bot-split', dirs: ['agents', 'bots'] }]) },
  { name: 'a snapshot of a dir with nothing to copy leaves nothing', ops: seq([...withData(), { op: 'backup', reason: 'empty' }, { op: 'mark' }]) },
  { name: 'reason strings are made safe and short', ops: seq([file('data/mixdog-config.json', CFG), { op: 'backup', reason: 'a b/c:d*e' + 'x'.repeat(60) }, { op: 'backup', reason: '' }, { op: 'backup', reason: '???' }]) },
  { name: 'snapshots skipped by MIXDOG_SKIP_USER_DATA_BACKUP', env: { MIXDOG_SKIP_USER_DATA_BACKUP: '1' }, ops: seq([file('data/mixdog-config.json', CFG), { op: 'read' }, { op: 'update', set: { a: 1 } }, { op: 'backup', reason: 'x' }, { op: 'ensure' }]) },
  { name: 'quiet setup logs no snapshot lines', env: { MIXDOG_SETUP_QUIET: '1' }, ops: seq([file('data/mixdog-config.json', CFG), { op: 'backup', reason: 'x' }]) },
  { name: 'backups under MIXDOG_USER_DATA_BACKUP_ROOT', env: { MIXDOG_USER_DATA_BACKUP_ROOT: '$ROOT/custom' }, ops: seq([file('data/mixdog-config.json', CFG), { op: 'read' }, { op: 'update', set: { a: 1 } }, { op: 'rm', path: 'data/mixdog-config.json' }, { op: 'read' }]) },
  { name: 'backups under MIXDOG_CONFIG_DIR when MIXDOG_HOME is unset', env: { MIXDOG_HOME: null, MIXDOG_CONFIG_DIR: '$ROOT/cfg' }, ops: seq([file('data/mixdog-config.json', CFG), { op: 'read' }, { op: 'update', set: { a: 1 } }]) },
];

if (process.argv[2] === '--child') {
  await child(process.argv[3], process.argv[4], process.argv[5]);
} else {
  await parent();
}

async function parent() {
  const { FIXTURES_ROOT, commitCheckoutIdentity, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
  const args = parseArgs();
  const tree = resolveTree(args);
  const commit = args.get('commit') ?? (() => { throw new Error('--commit is required'); })();
  const identity = commitCheckoutIdentity(tree, commit);
  const finalDir = join(FIXTURES_ROOT, 'user-data-guard');
  const stage = stageSet(finalDir);
  const base = mkdtempSync(join(process.env.TEMP ?? tmpdir(), 'user-data-guard-rec-'));
  const scenarios = SCENARIOS.map((scenario, index) => {
    const root = join(base, String(index));
    mkdirSync(root, { recursive: true });
    const out = join(root, 'out.json');
    const spec = join(base, `${index}.json`);
    writeFileSync(spec, JSON.stringify(scenario));
    const ran = spawnSync(process.execPath, [SELF, '--child', spec, join(root, 'run'), tree, out], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });
    if (ran.status !== 0) throw new Error(`scenario ${scenario.name} failed:\n${ran.stderr}`);
    return JSON.parse(readFileSync(out, 'utf8'));
  });
  rmSync(base, { recursive: true, force: true });
  writeJson(join(stage, 'golden.json'), { scenarios });
  const recorder = 'benchmarks/rust-core/recorders/record-user-data-guard.mjs';
  writeSetManifest(stage, { set: 'user-data-guard', recorder, command: 'node ' + recorder + ' --tree <git checkout at commit> --commit <full id>', identity });
  commitStage(stage, finalDir);
}

async function child(specPath, rootArg, treeArg) {
  const out = process.argv[6];
  const scenario = JSON.parse(readFileSync(specPath, 'utf8'));
  const root = resolve(rootArg);
  const tree = resolve(treeArg);
  const data = join(root, 'data');
  mkdirSync(join(root, 'home'), { recursive: true });
  const expand = (text) =>
    String(text)
      .replaceAll('$DATA_J', JSON.stringify(data).slice(1, -1))
      .replaceAll('$ROOT_J', JSON.stringify(root).slice(1, -1))
      .replaceAll('$DATA', data)
      .replaceAll('$ROOT', root);
  const env = { MIXDOG_HOME: join(root, 'mhome'), MIXDOG_DATA_DIR: data, USERPROFILE: join(root, 'home'), HOME: join(root, 'home') };
  for (const [name, value] of Object.entries(scenario.env ?? {})) env[name] = value === null ? null : expand(value);
  for (const [name, value] of Object.entries(env)) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
  if (!('MIXDOG_CONFIG_DIR' in (scenario.env ?? {}))) delete process.env.MIXDOG_CONFIG_DIR;
  for (const name of ['MIXDOG_USER_DATA_BACKUP_ROOT', 'MIXDOG_SKIP_USER_DATA_BACKUP', 'MIXDOG_SETUP_QUIET']) if (!(name in (scenario.env ?? {}))) delete process.env[name];

  let now = 0;
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() {
      return now;
    }
  };
  let ids = 0;
  const crypto = createRequire(import.meta.url)('node:crypto');
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
  syncBuiltinESMExports();
  let lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };

  const url = (rel) => import(pathToUrl(join(tree, rel)));
  const guard = await url('src/runtime/shared/user-data-guard.mjs');
  const config = await url('src/runtime/shared/config.mjs');

  const rootLower = root.toLowerCase();
  const tokens = [
    [JSON.stringify(root).slice(1, -1), '<root>'],
    [root, '<root>'],
    [rootLower, '<root>'],
  ];
  let scopeName = null;
  const normalizeText = (text) => {
    let result = text;
    for (const [from, to] of tokens) result = result.split(from).join(to);
    if (scopeName) result = result.split(scopeName).join('<scope>');
    return result;
  };
  const jsonOf = (value) => JSON.parse(normalizeText(JSON.stringify(value ?? null)));

  const run = (op) => {
    switch (op.op) {
      case 'file': {
        const path = join(root, ...op.path.replaceAll('$SCOPE', scopeToken()).split('/'));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, expand(op.text));
        return null;
      }
      case 'rm':
        rmSync(join(root, ...op.path.split('/')), { recursive: true, force: true });
        return null;
      case 'read':
        config.invalidateConfigReadCache();
        return config.readConfig();
      case 'update':
        config.invalidateConfigReadCache();
        return config.updateConfig((current) => ({ ...current, ...op.set }));
      case 'backup': {
        const times = op.repeat ?? 1;
        let last = null;
        for (let i = 0; i < times; i++) {
          if (op.step) now += 1000;
          last = guard.backupUserData(data, op.reason, op.dirs ? { dirs: op.dirs } : undefined);
        }
        return last;
      }
      case 'mark':
        return guard.markUserDataInitialized(data);
      case 'ensure':
        return guard.ensureUserDataInitialized(data) ?? null;
      case 'legacy':
        return guard.findLegacyUserDataEvidence(data, { fresh: Boolean(op.fresh) });
      case 'expected':
        return guard.isUserDataRecoveryExpected(data, { fresh: Boolean(op.fresh) });
      case 'loadLatest':
        return guard.loadLatestMixdogConfigFromBackup(data, { fresh: Boolean(op.fresh) });
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  };
  const scopeToken = () => {
    if (!scopeName) {
      const { createHash } = createRequire(import.meta.url)('node:crypto');
      scopeName = `scope-${createHash('sha256').update(data.toLowerCase()).digest('hex').slice(0, 16)}`.slice('scope-'.length);
    }
    return scopeName;
  };

  const results = [];
  for (const op of scenario.ops) {
    if (op.at !== undefined) now = op.at;
    lines = [];
    let answer = null;
    let error = null;
    try {
      answer = run(op);
    } catch (caught) {
      error = { name: caught?.name ?? null, code: caught?.code ?? null, message: String(caught?.message ?? caught) };
    }
    results.push({ op: { ...op, at: undefined }, answer: jsonOf(answer), error: error && jsonOf(error), stderr: lines.map((line) => normalizeText(line)) });
  }

  const files = {};
  const dirs = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        const rel = normalizeText(relative(root, full).split(sep).join('/'));
        // Node's config write (atomic rename with its owner-only ACL step) makes Windows create the empty shell folders
        // home/AppData/{Local,Roaming} under the redirected USERPROFILE; no Mixdog code names them (no 'Roaming' in src/,
        // and a snapshot, read or bare node process leaves them out). They are the host's, not the guard's, so they
        // are not part of the recorded tree.
        if (!/^home\/AppData(\/(Local|Roaming))?$/.test(rel)) dirs.push(rel);
        walk(full);
        continue;
      }
      const rel = normalizeText(relative(root, full).split(sep).join('/'));
      const bytes = readFileSync(full);
      const text = bytes.toString('utf8');
      files[rel] = Buffer.from(text, 'utf8').equals(bytes) ? { text: normalizeText(text) } : { b64: bytes.toString('base64') };
    }
  };
  walk(root);
  writeFileSync(out, JSON.stringify({ name: scenario.name, env: scenario.env ?? {}, ops: scenario.ops, results, dirs: dirs.sort(), files, dataDirKey: data.toLowerCase(), scopeName: scopeToken() }));
}

function pathToUrl(path) {
  return new URL(`file:///${path.replaceAll('\\', '/')}`).href;
}
