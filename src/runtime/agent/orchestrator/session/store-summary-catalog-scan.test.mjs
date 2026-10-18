import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// A distinct URL is a separate module instance: no derivation it could share.
let instance = 0;
const freshCatalogModule = () => import(`./store-summary-catalog.mjs?fresh=${++instance}`);

const SUMMARY_ANCHOR_TEXT = 'A previous model worked on this task';

function sessionRecord(index, turn) {
  const id = `sess_scan_${String(index).padStart(3, '0')}`;
  const agent = index % 3 === 0;
  const messages = [
    { role: 'system', content: 'system prompt' },
    // Preview noise the catalog skips, then the user's own words.
    { role: 'user', content: `${SUMMARY_ANCHOR_TEXT} before.` },
    { role: 'user', content: `<system-reminder>hidden</system-reminder> Task ${index} "quoted" \\ 한글 🐶` },
    { role: 'user', content: '[truncated]' },
    { role: 'user', content: 'internal', meta: { source: 'runtime' } },
    { role: 'user', content: [{ type: 'text', text: `imported ${index}` }], meta: { source: 'import' } },
  ];
  for (let n = 0; n < turn; n++) {
    messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: `c${n}`, input: { raw: '{"a":["}]\\""]}' } }] },
      { role: 'tool', content: `result ${n} ${'z'.repeat(300)}` }
    );
  }
  return {
    id,
    owner: agent ? 'agent' : 'user',
    agent: agent ? 'worker' : 'lead',
    ...(agent ? { ownerSessionId: 'sess_scan_000', parentSessionId: 'sess_scan_000' } : {}),
    sourceType: index % 7 === 3 ? 'exec' : agent ? 'agent' : 'lead',
    title: index % 5 === 0 ? '' : `Session ${index} turn ${turn}`,
    messages: index % 11 === 4 ? [] : messages,
    tools: [{ name: 'read', schema: { type: 'object' } }],
    deferredToolCatalog: [{ name: 'deferred', description: 'd'.repeat(200) }],
    cwd: 'C:\\Project\\mixdog',
    desktopSession: index % 2 ? { classification: 'project', projectPath: 'C:\\Project\\mixdog' } : null,
    provider: 'test-provider',
    model: `model-${index % 3}`,
    createdAt: 1_792_000_000_000 + index,
    updatedAt: 1_792_000_000_000 + index * 1000 + turn,
    lastUsedAt: 1_792_000_000_000 + index * 1000 + turn,
    generation: turn,
    closed: index % 13 === 6,
    ...(index % 17 === 9 ? { importOrigin: { key: `import-${index}` } } : {}),
  };
}

function withDataDirs(run) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-catalog-scan-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  const compact = join(root, 'compact');
  const pretty = join(root, 'pretty');
  for (const dir of [compact, pretty]) mkdirSync(join(dir, 'sessions'), { recursive: true });
  const use = (dir) => {
    process.env.MIXDOG_DATA_DIR = dir;
  };
  return Promise.resolve()
    .then(() => run({ compact, pretty, use }))
    .finally(() => {
      if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
      else process.env.MIXDOG_DATA_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    });
}

/** Writes record `index` serialized (the strict fast path) and pretty-printed
 *  (whitespace sends it down the authoritative full parse). */
function writeRecord(dirs, index, turn, { inPlace = false, extra = '' } = {}) {
  const doc = sessionRecord(index, turn);
  for (const [dir, text] of [
    [dirs.compact, JSON.stringify(doc) + extra],
    [dirs.pretty, JSON.stringify(doc, null, 2) + extra],
  ]) {
    const path = join(dir, 'sessions', `${doc.id}.json`);
    if (inPlace) writeFileSync(path, text);
    else {
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path);
    }
  }
}

// The file fingerprint differs between the two copies by construction.
const content = (rows) => rows.map(({ storageMtimeMs: _m, storageSize: _s, ...row }) => row);

async function listing(module, dir, use) {
  use(dir);
  const catalog = module.createOrdinaryCatalog();
  return catalog.refresh(catalog.loadIndex()).rows;
}

test('a cold catalog lists exactly what the full parse of every record lists', async () => {
  await withDataDirs(async (dirs) => {
    for (let index = 0; index < 60; index++) writeRecord(dirs, index, 1 + (index % 4));
    // Records the authority rejects stay out of both listings.
    writeRecord(dirs, 60, 1, { extra: ' trailing' });
    const ambiguous = '{"id":"sess_scan_061","id":"sess_scan_061","messages":[{"role":"user","content":"x"}]}';
    writeFileSync(join(dirs.compact, 'sessions', 'sess_scan_061.json'), ambiguous);
    writeFileSync(join(dirs.pretty, 'sessions', 'sess_scan_061.json'), ambiguous);
    const rows = await listing(await freshCatalogModule(), dirs.compact, dirs.use);
    const reference = await listing(await freshCatalogModule(), dirs.pretty, dirs.use);
    assert.ok(rows.length > 30, 'the fixture lists most of its sessions');
    assert.ok(rows.some((row) => row.preview.startsWith('Task')));
    assert.equal(rows.filter((row) => /^sess_scan_06[01]$/.test(row.id)).length, 0);
    assert.deepEqual(content(rows), content(reference));
  });
});

test('a catalog kept current under churn lists what a cold full parse lists', async () => {
  await withDataDirs(async (dirs) => {
    const turns = new Map();
    for (let index = 0; index < 40; index++) {
      turns.set(index, 1);
      writeRecord(dirs, index, 1);
    }
    const module = await freshCatalogModule();
    dirs.use(dirs.compact);
    const live = module.createOrdinaryCatalog();
    live.refresh(live.loadIndex());
    for (let round = 0; round < 5; round++) {
      for (const index of [1, 2, 4, 5, 10 + round]) {
        turns.set(index, turns.get(index) + 1);
        // Replacements and in-place rewrites alike (the latter found by the
        // background pass, as in production).
        writeRecord(dirs, index, turns.get(index), { inPlace: index % 2 === 0 });
      }
      if (round === 1) writeRecord(dirs, 50, 1);
      if (round === 3) {
        rmSync(join(dirs.compact, 'sessions', 'sess_scan_007.json'));
        rmSync(join(dirs.pretty, 'sessions', 'sess_scan_007.json'));
      }
      dirs.use(dirs.compact);
      await live.verify();
      const rows = live.refresh(live.loadIndex()).rows;
      assert.deepEqual(rows, await listing(await freshCatalogModule(), dirs.compact, dirs.use), `cold, round ${round}`);
      assert.deepEqual(
        content(rows),
        content(await listing(await freshCatalogModule(), dirs.pretty, dirs.use)),
        `full parse, round ${round}`
      );
    }
    live.clear();
  });
});
