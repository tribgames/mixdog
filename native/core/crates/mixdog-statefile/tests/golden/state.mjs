// Records, from today's Node `atomic-file.mjs`, what each state-file operation answers, which
// files it leaves behind and the order of its file-system calls: the golden the Rust
// `mixdog-statefile` replays. Usage: node state.mjs <repo-root> <out.json>
//
// Lock files (`*.lock`) are left out of both the listing and the trace: a held-lock scenario
// leaves its holder's record, and the lock traffic is not a data-file operation.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);

const mask = (s) => s.replace(/\.corrupt-\d+/g, '.corrupt-<N>').replace(/mixdog-tmp-[0-9a-f]+/g, 'mixdog-tmp-<H>');
const nameOf = (p) => mask(basename(String(p)));
const trace = [];
const fds = new Map();
const real = {
  openSync: fs.openSync,
  closeSync: fs.closeSync,
  fsyncSync: fs.fsyncSync,
  renameSync: fs.renameSync,
  linkSync: fs.linkSync,
  unlinkSync: fs.unlinkSync,
};
const isDirectory = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
fs.openSync = (p, flags, mode) => {
  const dir = flags === 'r' && isDirectory(p);
  if (dir) trace.push('open-dir');
  const fd = real.openSync(p, flags, mode);
  fds.set(fd, { dir, name: nameOf(p) });
  if (flags === 'wx' || flags === 'w') trace.push(`create ${nameOf(p)}`);
  return fd;
};
fs.closeSync = (fd) => {
  fds.delete(fd);
  return real.closeSync(fd);
};
fs.fsyncSync = (fd) => {
  const entry = fds.get(fd);
  trace.push(entry?.dir ? 'fsync-dir' : `fsync ${entry?.name}`);
  return real.fsyncSync(fd);
};
fs.renameSync = (a, b) => {
  trace.push(`rename ${nameOf(a)} ${nameOf(b)}`);
  return real.renameSync(a, b);
};
fs.linkSync = (a, b) => {
  trace.push(`link ${nameOf(a)} ${nameOf(b)}`);
  return real.linkSync(a, b);
};
fs.unlinkSync = (p) => {
  trace.push(`unlink ${nameOf(p)}`);
  return real.unlinkSync(p);
};
syncBuiltinESMExports();

const { readJsonStateSync, updateJsonAtomicSync, writeFileAtomicSync, writeJsonAtomicSync, unsupportedState } =
  await import(pathToFileURL(join(root, 'src', 'runtime', 'shared', 'atomic-file.mjs')).href);

const validators = {
  none: undefined,
  object: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  },
  versioned: (v) => {
    if (v && Number.isSafeInteger(v.version) && v.version > 1) throw unsupportedState('newer build');
    if (!v || v.version !== 1) throw new Error('unreadable');
    return v;
  },
};
const mutators = {
  wrap: (cur) => ({ seen: cur }),
  noop: () => undefined,
  throw: () => {
    throw Object.assign(new Error('mutator'), { code: 'EMUTATOR' });
  },
};

const GOOD = '{"a":1}\n';
const GOOD2 = '{"b":2}\n';
const NUL = '\u0000\u0000\u0000\u0000';
const V1 = '{"version":1,"x":1}\n';
const b64 = (bytes) => ({ b64: Buffer.from(bytes).toString('base64') });

const read = (name, files, opts = {}, validate = 'none', extra = {}) => ({
  name,
  files,
  call: { fn: 'read', validate, opts },
  ...extra,
});
const update = (name, files, mutate, opts = {}, extra = {}) => ({
  name,
  files,
  call: { fn: 'update', mutate, opts },
  ...extra,
});
const writeJson = (name, files, value, opts = {}) => ({ name, files, call: { fn: 'writeJson', value, opts } });
const writeFile = (name, files, text, opts = {}) => ({ name, files, call: { fn: 'writeFile', text, opts } });

const scenarios = [
  read('read: intact file', { 'f.json': GOOD }),
  read('read: absent file answers the fallback', {}),
  read('read: byte order mark is skipped', { 'f.json': `\ufeff${GOOD}` }),
  read('read: invalid UTF-8 decodes lossily and parses', { 'f.json': b64([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]) }),
  read('read: damaged without a backup is set aside', { 'f.json': '{"a":' }),
  read('read: damaged restores the backup', { 'f.json': '{"a":', 'f.json.bak': GOOD2 }),
  read('read: NUL-filled restores the backup', { 'f.json': NUL, 'f.json.bak': GOOD2 }),
  read('read: damaged backup does not restore', { 'f.json': '{"a":', 'f.json.bak': '{"b":' }),
  read('read: validate rejection is damage', { 'f.json': '[1]', 'f.json.bak': GOOD2 }, {}, 'object'),
  read('read: newer version stays in place', { 'f.json': '{"version":2}\n', 'f.json.bak': V1 }, {}, 'versioned'),
  read('read: restoreBackup false sets aside and answers the fallback', { 'f.json': '{"a":', 'f.json.bak': GOOD2 }, { restoreBackup: false }),
  read('read: keepWithoutBackup leaves a damaged file', { 'f.json': '{"a":' }, { keepWithoutBackup: true }),
  read('read: keepWithoutBackup still restores a good backup', { 'f.json': '{"a":', 'f.json.bak': GOOD2 }, { keepWithoutBackup: true }),
  read('read: busy lock leaves the damaged file', { 'f.json': '{"a":', 'f.json.bak': GOOD2 }, { timeoutMs: 0 }, 'none', { lockHeld: true }),
  read('read: lock timeout leaves the damaged file', { 'f.json': '{"a":', 'f.json.bak': GOOD2 }, { timeoutMs: 100 }, 'none', { lockHeld: true }),
  read('read: an intact file is read while the lock is held', { 'f.json': GOOD }, { timeoutMs: 0 }, 'none', { lockHeld: true }),

  update('update: absent file is created', {}, 'wrap'),
  update('update: backup keeps the replaced version', { 'f.json': GOOD }, 'wrap', { backup: true }),
  update('update: no change writes nothing', { 'f.json': GOOD }, 'noop'),
  update('update: damaged file feeds the backup to the mutator', { 'f.json': '{"a":', 'f.json.bak': GOOD2 }, 'wrap'),
  update('update: damaged file without a backup feeds null', { 'f.json': '{"a":' }, 'wrap'),
  update('update: NUL-filled file feeds null', { 'f.json': NUL }, 'wrap', { backup: true }),
  update('update: restoreBackup false feeds null', { 'f.json': '{"a":', 'f.json.bak': GOOD2 }, 'wrap', { restoreBackup: false }),
  update('update: keepWithoutBackup leaves the file and feeds null', { 'f.json': '{"a":' }, 'wrap', { keepWithoutBackup: true }),
  update('update: a throwing mutator writes nothing', { 'f.json': GOOD }, 'throw', { backup: true }),
  update('update: busy lock fails', { 'f.json': GOOD }, 'wrap', { timeoutMs: 0 }, { lockHeld: true }),
  update('update: lock timeout fails', { 'f.json': GOOD }, 'wrap', { timeoutMs: 100 }, { lockHeld: true }),
  update('update: fsyncDir syncs the directory last', { 'f.json': GOOD }, 'wrap', { fsyncDir: true, backup: true }),

  writeJson('writeJson: fresh file', {}, { a: [1, 2], b: 'x' }),
  writeJson('writeJson: compact', {}, { a: [1, 2], b: 'x' }, { compact: true }),
  writeJson('writeJson: backup publishes before the rename', { 'f.json': GOOD }, { c: 3 }, { backup: true }),
  writeJson('writeJson: backup skips a damaged file', { 'f.json': '{"a":' }, { c: 3 }, { backup: true }),
  writeJson('writeJson: backup skips a NUL-filled file', { 'f.json': NUL }, { c: 3 }, { backup: true }),
  writeJson('writeJson: backup replaces an older backup', { 'f.json': GOOD, 'f.json.bak': GOOD2 }, { c: 3 }, { backup: true }),
  writeJson('writeJson: no fsync', {}, { a: 1 }, { fsync: false }),
  writeJson('writeJson: fsyncDir', {}, { a: 1 }, { fsyncDir: true }),
  writeJson('writeJson: lock', { 'f.json': GOOD }, { a: 1 }, { lock: true }),

  writeFile('writeFile: createOnly on an absent file', {}, 'hello', { createOnly: true }),
  writeFile('writeFile: createOnly leaves an existing file', { 'f.json': 'keep' }, 'hello', { createOnly: true }),
  writeFile('writeFile: backup keeps a text file', { 'f.json': 'old text' }, 'new text', { backup: true }),
  writeFile('writeFile: backup skips a NUL-filled file', { 'f.json': NUL }, 'new text', { backup: true }),
  writeFile('writeFile: backup keeps an unparsable text file', { 'f.json': '{"a":' }, 'new text', { backup: true }),
  writeFile('writeFile: replaces without a backup', { 'f.json': 'old text' }, 'new text'),
];

const render = (buf) => {
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : b64(buf);
};

function call(spec, file) {
  const opts = { ...spec.opts };
  switch (spec.fn) {
    case 'read':
      return readJsonStateSync(file, { validate: validators[spec.validate], fallback: 'FALLBACK', ...opts });
    case 'update':
      return updateJsonAtomicSync(file, mutators[spec.mutate], opts);
    case 'writeJson':
      return writeJsonAtomicSync(file, spec.value, opts);
    case 'writeFile':
      return writeFileAtomicSync(file, spec.text, opts);
    default:
      throw new Error(spec.fn);
  }
}

const record = [];
for (const scenario of scenarios) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'statefile-golden-'));
  for (const [name, value] of Object.entries(scenario.files)) {
    fs.writeFileSync(join(dir, name), typeof value === 'string' ? value : Buffer.from(value.b64, 'base64'));
  }
  if (scenario.lockHeld) fs.writeFileSync(join(dir, 'f.json.lock'), `${process.pid} ${Date.now()} other-token\n`);
  trace.length = 0;
  let returned = null;
  let threw = null;
  try {
    const value = call(scenario.call, join(dir, 'f.json'));
    returned = value === undefined ? null : value;
  } catch (error) {
    threw = error?.code ?? String(error?.message);
  }
  const files = {};
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.endsWith('.lock')) continue;
    files[mask(name)] = render(fs.readFileSync(join(dir, name)));
  }
  record.push({
    ...scenario,
    expect: { returned, threw, files, trace: trace.filter((entry) => !entry.includes('.lock')) },
  });
  fs.rmSync(dir, { recursive: true, force: true });
}
fs.writeFileSync(out, `${JSON.stringify(record, null, 1)}\n`);
