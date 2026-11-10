import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mock } from 'node:test';

const source = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const only = process.argv.indexOf('--only');
if (only !== -1) assert.equal(process.argv[only + 1], 'retention-boundaries');
const root = await mkdtemp('D:/mixdog-build/tmp/office-startup-');
const data = join(root, 'data');
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_RUNTIME_ROOT']) {
  process.env[key] = join(root, key);
  await mkdir(process.env[key], { recursive: true });
}
process.env.MIXDOG_DATA_DIR = data;
process.env.NODE_ENV = 'production';
await mkdir(join(data, 'office-transactions'), { recursive: true });
process.chdir(data);
const now = Date.parse('2026-01-31T12:00:00.000Z');
const limit = 30 * 24 * 60 * 60 * 1000;
const inputs = [];
const artifacts = [];
for (const [id, age] of [['inside', limit - 1], ['equal', limit], ['outside', limit + 1]]) {
  const record = {
    version: 1, id, updatedAt: new Date(now - age).toISOString(),
    checkpoint: `${id}.checkpoint`, baselinePdf: `${id}.pdf`,
  };
  inputs.push({ path: `office-transactions/${id}.json`, text: `${JSON.stringify(record, null, 2)}\n`, mtimeMs: now });
  inputs.push({ path: record.checkpoint, text: `checkpoint ${id}`, mtimeMs: now });
  inputs.push({ path: record.baselinePdf, text: `pdf ${id}`, mtimeMs: now });
  artifacts.push(record.checkpoint, record.baselinePdf);
}
inputs.push({ path: 'office-transactions/malformed.json', text: '{"unfinished":', mtimeMs: now - limit - 1 });
inputs.push({ path: 'office-transactions/not-a-journal.txt', text: 'retain me', mtimeMs: now - limit - 1 });
for (const input of inputs) {
  await writeFile(input.path, input.text);
  await utimes(input.path, input.mtimeMs / 1000, input.mtimeMs / 1000);
}

async function tree(directory, prefix = '') {
  const entries = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) {
      entries.push({ path, kind: 'directory' }, ...await tree(join(directory, entry.name), `${path}/`));
    } else {
      entries.push({ path, kind: 'file', base64: (await readFile(join(directory, entry.name))).toString('base64') });
    }
  }
  return entries;
}

// Observe the original background promise without substituting the startup or journal implementation.
const bootstrap = pathToFileURL(join(source, 'src/session-runtime/runtime-bootstrap.mjs')).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== bootstrap) return loaded;
    const text = String(loaded.source);
    const call = 'listOfficeJournals(dataDir).catch(() => {});';
    assert.equal(text.split(call).length, 2, 'the recorded Node bootstrap has one sweep');
    return { ...loaded, source: text.replace(call, `globalThis.__officeStartupSweep = ${call}`) };
  },
});
const { prepareStandaloneEnvironment } = await import(bootstrap);
hooks.deregister();
let deadline;
const expired = new Promise((_, reject) => {
  deadline = setTimeout(() => reject(new Error('Node startup office-journal sweep did not complete within 30 seconds')), 30_000);
});
mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval', 'setImmediate'], now: now - 1 });
mock.timers.tick(1);
let result;
try {
  prepareStandaloneEnvironment();
  assert.ok(globalThis.__officeStartupSweep, 'Node startup did not initiate the office-journal sweep');
  await Promise.race([globalThis.__officeStartupSweep, expired]);
  result = {
    journals: await tree(join(data, 'office-transactions')),
    artifacts: await Promise.all(artifacts.map(async (path) => {
      try {
        return { path, present: true, base64: (await readFile(join(data, path))).toString('base64') };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return { path, present: false };
      }
    })),
  };
} finally {
  mock.timers.reset();
  clearTimeout(deadline);
}
const recorder = fileURLToPath(import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(join(output, 'recording.json'), `${JSON.stringify({ inputs, now, tree: result }, null, 2)}\n`);
await writeFile(join(output, 'manifest.json'), `${JSON.stringify({
  product: { exact: true, commit: 'b6f10295a2f698afc85332467192de28500bd146' }, node: process.version,
  scenario: 'retention-boundaries', inputs, now,
  boundary: { directory: 'office-transactions', artifacts, nonJournal: 'office-transactions/not-a-journal.txt' },
  notes: 'Compare every entry recursively within office-transactions, including the prepared non-journal, and every explicitly named artifact (presence and bytes). Core stores elsewhere are outside the sweep subject: Node bootstrap never had them. Exclude nothing within this boundary.',
  files: [{ path: '../../../../benchmarks/rust-core/recorders/record-office-startup.mjs', sha256: createHash('sha256').update(await readFile(recorder)).digest('hex') }],
}, null, 2)}\n`);
console.log(JSON.stringify({ root, output, journalEntries: result.journals.length, artifacts: result.artifacts.length }));
process.chdir(source);
await rm(root, { recursive: true });
