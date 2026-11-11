#!/usr/bin/env node
// Recording of media/store.test.mjs (b6f10295a): the media catalog store (src/runtime/media/store.mjs) over a temp data dir.
// Each case imports the store as a fresh module instance (a distinct ?query URL, as the Node test does), writes the catalog
// files the case starts from and records every result of the calls the test made. Generated ids (uuids) are renamed
// <uuid1>, <uuid2>… in first-seen order; Date.now is the recorder's fixed clock. Error cases record the error's name and, where
// the test matched one, its message; the Windows-only read-only-index case records {skipped} elsewhere.
//
//   node benchmarks/rust-core/recorders/record-media-store-cases.mjs --tree <export of b6f10295a with node_modules>
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSet } from './lib/case-set.mjs';
import { parseArgs, resolveTree } from './lib/common.mjs';

const set = openSet('media-store-cases', import.meta.url);
const tree = resolveTree(parseArgs());
const STORE_URL = pathToFileURL(join(tree, 'src/runtime/media/store.mjs')).href;
let instance = 0;
const freshStore = () => import(`${STORE_URL}?instance=${(instance += 1)}`);
const roots = [];
const DAY = 24 * 60 * 60 * 1_000;

/** The case's value with every uuid renamed in first-seen order (the ids the store generated). */
function named(value) {
  const seen = new Map();
  const text = JSON.stringify(value, (_, v) => (v === undefined ? { undefined: true } : v)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    if (!seen.has(id)) seen.set(id, `<uuid${seen.size + 1}>`);
    return seen.get(id);
  });
  return JSON.parse(text);
}
const thrown = (fn) => { try { fn(); return { returned: true }; } catch (e) { return { name: e?.name ?? null, code: e?.code ?? null, message: e?.code ? null : String(e?.message ?? e) }; } };
const dataDir = () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-media-store-'));
  roots.push(root);
  process.env.MIXDOG_DATA_DIR = root;
  return root;
};
const done = (root) => { delete process.env.MIXDOG_DATA_DIR; rmSync(root, { recursive: true, force: true }); };
const read = (p) => readFileSync(p, 'utf8');

await set.run('media assets are organized by kind, provider, model, and local date while flat files migrate', async () => {
  const root = dataDir();
  const assetsDir = join(root, 'media', 'assets');
  const createdAt = new Date(2026, 6, 5, 12, 0, 0).getTime();
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, 'legacy-image.jpg'), Buffer.from('image'));
  writeFileSync(join(assetsDir, 'legacy-video.mp4'), Buffer.from('video'));
  const startIndex = { version: 1, assets: [
    { id: 'legacy-image', file: 'legacy-image.jpg', kind: 'image', lane: 'gemini', model: 'image-alpha', prompt: 'image', options: { aspectRatio: '4:3' }, mime: 'image/jpeg', bytes: 5, createdAt },
    { id: 'legacy-video', file: 'legacy-video.mp4', kind: 'video', lane: 'grok', model: 'video-beta', prompt: 'video', options: { aspectRatio: '16:9' }, mime: 'video/mp4', bytes: 5, createdAt },
  ] };
  writeFileSync(join(root, 'media', 'index.json'), JSON.stringify(startIndex));
  try {
    const store = await freshStore();
    const out = { files: ['assets/legacy-image.jpg (image)', 'assets/legacy-video.mp4 (video)'], startIndex };
    out.openCommands = [store.mediaOpenCommand('C:\\Media Assets\\clip.mp4', { reveal: true, platform: 'win32' }), store.mediaOpenCommand('/Users/me/Media Assets/image.png', { reveal: true, platform: 'darwin' })];
    out.beforeMigration = store.listMediaAssets({ limit: 10 }).assets;
    const saved = store.saveMediaAsset({ kind: 'video', lane: 'gemini', model: 'veo:3/preview', prompt: 'new clip', options: { aspectRatio: '16:9' }, mime: 'video/mp4', bytes: Buffer.from('new-video') });
    const migrated = store.listMediaAssets({ limit: 10 }).assets;
    const listed = ['legacy-image', 'legacy-video'].map((id) => migrated.find((entry) => entry.id === id));
    out.migrated = listed;
    out.migratedFilesExist = listed.map((e) => existsSync(join(assetsDir, ...e.file.split('/'))));
    out.legacyFlatFileRemains = existsSync(join(assetsDir, 'legacy-image.jpg'));
    const before = store.mediaStoreCacheStats();
    await Promise.all([store.resolveMediaFile('legacy-image'), store.resolveMediaFile('legacy-video'), store.resolveMediaFile('legacy-image')]);
    const after = store.mediaStoreCacheStats();
    out.thumbnailBurst = { indexDiskReadsUnchanged: after.indexDiskReads === before.indexDiskReads, indexCacheHitsGrewByAtLeast3: after.indexCacheHits >= before.indexCacheHits + 3 };
    const miss = await store.resolveMediaFile('legacy-image', { variant: 'thumb', generate: false });
    out.cachedOnlyMiss = { available: miss.available };
    out.readVideo = await store.readMediaAsset('legacy-video');
    out.readThumbMiss = await store.readMediaAsset('legacy-image', { variant: 'thumb', generate: false });
    out.readThumbDowngraded = await store.readMediaAsset('legacy-image', { variant: 'thumb', allowOriginal: true, generate: false });
    const browserThumb = Buffer.from('browser-generated-thumbnail');
    out.cachedThumbnail = store.cacheMediaThumbnail('legacy-video', { mime: 'image/jpeg', base64: browserThumb.toString('base64'), durationSeconds: 7 });
    out.cachedTarget = { available: (await store.resolveMediaFile('legacy-video', { variant: 'thumb', generate: false })).available };
    const cachedRead = await store.readMediaAsset('legacy-video', { variant: 'thumb' });
    out.cachedRead = { mime: cachedRead.mime, base64: cachedRead.base64, durationSeconds: cachedRead.durationSeconds };
    out.saved = { file: saved.file, matchesLayout: /^videos\/gemini\/veo-3-preview\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.mp4$/.test(saved.file), fileExists: existsSync(join(assetsDir, ...saved.file.split('/'))) };
    out.deleted = { removed: store.deleteMediaAsset(saved.id).removed, fileExists: existsSync(join(assetsDir, ...saved.file.split('/'))) };
    out.persistedVersion = JSON.parse(read(join(root, 'media', 'index.json'))).version;
    return named(out);
  } finally { done(root); }
});
await set.run('a failed duration write leaves the cached index row untouched', async () => {
  if (process.platform !== 'win32') return { skipped: 'Windows only (the Node test skips elsewhere)' };
  const root = dataDir();
  const assetsDir = join(root, 'media', 'assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, 'clip.mp4'), Buffer.from('video'));
  const startIndex = { version: 2, assets: [{ id: 'clip', file: 'clip.mp4', kind: 'video', lane: 'grok', model: 'm', mime: 'video/mp4', bytes: 5, createdAt: 1 }] };
  writeFileSync(join(root, 'media', 'index.json'), JSON.stringify(startIndex));
  try {
    const store = await freshStore();
    store.listMediaAssets({ limit: 10 });
    const indexFile = join(root, 'media', 'index.json');
    chmodSync(indexFile, 0o444);
    const cachedRow = store.listMediaAssets({ limit: 10 }).assets[0];
    const error = thrown(() => store.cacheMediaThumbnail('clip', { mime: 'image/jpeg', base64: Buffer.from('thumb').toString('base64'), durationSeconds: 7 }));
    const out = { startIndex, indexMadeReadOnly: true, cacheMediaThumbnail: { threw: error.returned !== true, name: error.name ?? null, code: error.code ?? null }, cachedRowDuration: cachedRow.durationSeconds ?? null, listedDurationAfter: store.listMediaAssets({ limit: 10 }).assets[0].durationSeconds ?? null };
    chmodSync(indexFile, 0o644);
    return out;
  } finally { done(root); }
});
await set.run('bulk media cleanup previews, then deletes by age, missing file, selection, and kind', async () => {
  const root = dataDir();
  const assetsDir = join(root, 'media', 'assets');
  const now = Date.now();
  const row = (id, kind, age, present = true) => {
    const file = `${id}.${kind === 'video' ? 'mp4' : 'png'}`;
    if (present) writeFileSync(join(assetsDir, file), Buffer.from(id));
    return { id, file, kind, lane: 'gemini', model: 'm', prompt: id, mime: kind === 'video' ? 'video/mp4' : 'image/png', bytes: 1, createdAt: now - age * DAY };
  };
  mkdirSync(assetsDir, { recursive: true });
  const assets = [row('fresh', 'image', 1), row('old', 'image', 40), row('gone', 'image', 2, false), row('picked', 'image', 3), row('clip', 'video', 60)];
  writeFileSync(join(root, 'media', 'index.json'), JSON.stringify({ version: 2, assets }));
  try {
    const store = await freshStore();
    const ids = () => store.listMediaAssets({ limit: 50 }).assets.map((entry) => entry.id);
    const out = { assets, now };
    out.noSelector = thrown(() => store.deleteMediaAssets({ kind: 'image' }));
    const preview = store.deleteMediaAssets({ kind: 'image', before: now - 30 * DAY, dryRun: true });
    out.preview = preview; out.idsAfterDryRun = ids();
    out.deleteByIds = store.deleteMediaAssets({ ids: preview.ids }).ids; out.oldFileExists = existsSync(join(assetsDir, 'old.png'));
    out.deleteMissing = store.deleteMediaAssets({ kind: 'image', missing: true }).ids;
    out.deletePickedWithinKind = store.deleteMediaAssets({ ids: ['picked', 'clip'], kind: 'image' }).ids;
    out.deleteAllImages = store.deleteMediaAssets({ kind: 'image', all: true }).ids;
    out.idsAfter = ids(); out.clipFileExists = existsSync(join(assetsDir, 'clip.mp4'));
    return named(out);
  } finally { done(root); }
});
await set.run('a NUL-filled media index lists an empty gallery, is kept aside, and saving still works', async () => {
  const root = dataDir();
  mkdirSync(join(root, 'media'), { recursive: true });
  writeFileSync(join(root, 'media', 'index.json'), Buffer.alloc(128));
  try {
    const store = await freshStore();
    const out = { indexFile: '128 NUL bytes' };
    out.listed = store.listMediaAssets({ limit: 10 });
    out.keptAsideNames = readdirSync(join(root, 'media')).filter((n) => n.startsWith('index.json.corrupt-')).map(() => 'index.json.corrupt-<stamp>');
    const save = (prompt, bytes) => store.saveMediaAsset({ kind: 'image', lane: 'lane', model: 'model', prompt, mime: 'image/png', bytes: Buffer.from(bytes) });
    const saved = save('p', 'png-bytes');
    out.afterSave = { total: store.listMediaAssets({ limit: 10 }).total, fileBytes: read(join(root, 'media', 'assets', ...saved.file.split('/'))) };
    save('q', 'b');
    out.backupAssetCount = JSON.parse(read(join(root, 'media', 'index.json.bak'))).assets.length;
    return named(out);
  } finally { done(root); }
});
await set.run('boards persist with their results; deleting a board keeps its results in the catalog', async () => {
  const root = dataDir();
  try {
    const store = await freshStore();
    const save = (prompt, meta = {}) => store.saveMediaAsset({ kind: 'image', lane: 'gemini', model: 'm', prompt, mime: 'image/png', bytes: Buffer.from(prompt), meta });
    const out = {};
    const board = store.createMediaBoard('  Gacha   sprites ');
    out.boardName = board.name;
    const loose = save('loose');
    const inBoard = save('in board', { boardId: board.id });
    out.inBoardList = store.listMediaAssets({ boardId: board.id }).assets.map((entry) => entry.id === inBoard.id);
    out.addLoose = store.setMediaAssetBoard([loose.id], board.id);
    store.renameMediaBoard(board.id, 'Icons');
    const reopened = await freshStore();
    const listed = reopened.listMediaBoards();
    out.reopened = { total: listed.total, boards: listed.boards.map(({ name, count }) => ({ name, count })) };
    out.setUnknownBoard = thrown(() => reopened.setMediaAssetBoard([loose.id], 'missing'));
    out.typeChecks = { createWithObject: thrown(() => reopened.createMediaBoard({ name: 'x' })), renameWithNumber: thrown(() => reopened.renameMediaBoard(17, 'x')), setBoardFalse: thrown(() => reopened.setMediaAssetBoard([loose.id], false)), setObjectId: thrown(() => reopened.setMediaAssetBoard([{}], board.id)) };
    out.boardCountAfterRefusals = reopened.listMediaAssets({ boardId: board.id }).total;
    out.removeFromBoard = reopened.setMediaAssetBoard([loose.id], null);
    reopened.setMediaAssetBoard([loose.id], board.id);
    out.deleteBoard = reopened.deleteMediaBoard(board.id);
    out.boardsAfterDelete = reopened.listMediaBoards();
    const all = reopened.listMediaAssets();
    out.assetsAfterDelete = { total: all.total, noneHasBoard: all.assets.every((entry) => !entry.boardId) };
    return named({ ...out, ids: { board: board.id, loose: loose.id, inBoard: inBoard.id } });
  } finally { done(root); }
});
await set.run('a boards file with a malformed list is recovered from its backup before a create, not overwritten', async () => {
  const root = dataDir();
  try {
    const store = await freshStore();
    store.createMediaBoard('One'); store.createMediaBoard('Two'); store.createMediaBoard('Three');
    const boardsFile = join(root, 'media', 'boards.json');
    writeFileSync(boardsFile, JSON.stringify({ version: 1, boards: null }));
    store.createMediaBoard('Four');
    const names = store.listMediaBoards().boards.map((board) => board.name);
    const backup = JSON.parse(read(`${boardsFile}.bak`));
    return { created: ['One', 'Two', 'Three'], overwrittenWith: { version: 1, boards: null }, thenCreated: 'Four', names: [...names].sort(), survivedOneTwoFour: ['One', 'Two', 'Four'].every((n) => names.includes(n)), backupBoardsIsArray: Array.isArray(backup.boards), backupBoardCountAtLeast2: backup.boards.length >= 2, note: 'the backup holds One and Two at the moment of the damage; Three may not have been backed up' };
  } finally { done(root); }
});

await set.finish({
  entry: { runs: 'src/runtime/media/store.mjs (listMediaAssets, saveMediaAsset, resolveMediaFile, readMediaAsset, cacheMediaThumbnail, deleteMediaAsset(s), mediaOpenCommand, mediaStoreCacheStats, boards API) as a fresh module instance per case, over a temp data dir', notRun: 'native rendition generation (the stub bytes cannot render; generate:false or the miss is what is recorded)' },
  replay: { entry: 'mixdog-store media: write the case\'s start files into a temp data dir and compare each result whole; uuids by first-seen order; the date folder of a saved asset by the layout regex', normalised: { uuids: 'renamed <uuidN> in first-seen order', dataDir: 'temp, not in the recording' } },
  replaceInText: roots.map((r) => [r, '<data>']),
});
for (const r of roots) rmSync(r, { recursive: true, force: true });
process.exit(0);
