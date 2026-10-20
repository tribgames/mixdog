import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('media assets are organized by kind, provider, model, and local date while flat files migrate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-media-store-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const assetsDir = join(root, 'media', 'assets');
  const createdAt = new Date(2026, 6, 5, 12, 0, 0).getTime();
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, 'legacy-image.jpg'), Buffer.from('image'));
  writeFileSync(join(assetsDir, 'legacy-video.mp4'), Buffer.from('video'));
  writeFileSync(
    join(root, 'media', 'index.json'),
    JSON.stringify({
      version: 1,
      assets: [
        {
          id: 'legacy-image',
          file: 'legacy-image.jpg',
          kind: 'image',
          lane: 'gemini',
          model: 'image-alpha',
          prompt: 'image',
          options: { aspectRatio: '4:3' },
          mime: 'image/jpeg',
          bytes: 5,
          createdAt,
        },
        {
          id: 'legacy-video',
          file: 'legacy-video.mp4',
          kind: 'video',
          lane: 'grok',
          model: 'video-beta',
          prompt: 'video',
          options: { aspectRatio: '16:9' },
          mime: 'video/mp4',
          bytes: 5,
          createdAt,
        },
      ],
    })
  );

  try {
    const store = await import(`./store.mjs?test=${Date.now()}`);
    assert.deepEqual(
      store.mediaOpenCommand('C:\\Media Assets\\clip.mp4', {
        reveal: true,
        platform: 'win32',
      }),
      ['explorer.exe', ['/select,', 'C:\\Media Assets\\clip.mp4']]
    );
    assert.deepEqual(
      store.mediaOpenCommand('/Users/me/Media Assets/image.png', {
        reveal: true,
        platform: 'darwin',
      }),
      ['open', ['-R', '/Users/me/Media Assets/image.png']]
    );
    const beforeMigration = store.listMediaAssets({ limit: 10 }).assets;
    assert.equal(
      beforeMigration[0].file,
      'legacy-image.jpg',
      'read-only listing must not run the write-side layout migration'
    );
    const saved = store.saveMediaAsset({
      kind: 'video',
      lane: 'gemini',
      model: 'veo:3/preview',
      prompt: 'new clip',
      options: { aspectRatio: '16:9' },
      mime: 'video/mp4',
      bytes: Buffer.from('new-video'),
    });
    const migrated = store.listMediaAssets({ limit: 10 }).assets;
    const listed = ['legacy-image', 'legacy-video'].map((id) => migrated.find((entry) => entry.id === id));
    assert.equal(listed[0].file, 'images/gemini/image-alpha/2026-07-05/legacy-image.jpg');
    assert.equal(listed[1].file, 'videos/grok/video-beta/2026-07-05/legacy-video.mp4');
    assert.equal(existsSync(join(assetsDir, ...listed[0].file.split('/'))), true);
    assert.equal(existsSync(join(assetsDir, ...listed[1].file.split('/'))), true);
    assert.equal(existsSync(join(assetsDir, 'legacy-image.jpg')), false);
    const cacheBeforeReads = store.mediaStoreCacheStats();
    await Promise.all([
      store.resolveMediaFile('legacy-image'),
      store.resolveMediaFile('legacy-video'),
      store.resolveMediaFile('legacy-image'),
    ]);
    const cacheAfterReads = store.mediaStoreCacheStats();
    assert.equal(
      cacheAfterReads.indexDiskReads,
      cacheBeforeReads.indexDiskReads,
      'a thumbnail-resolution burst must reuse the parsed media index'
    );
    assert.ok(cacheAfterReads.indexCacheHits >= cacheBeforeReads.indexCacheHits + 3);
    const cachedOnlyMiss = await store.resolveMediaFile('legacy-image', {
      variant: 'thumb',
      generate: false,
    });
    assert.equal(
      cachedOnlyMiss.available,
      false,
      'a local protocol probe must not start native rendition generation on a cache miss'
    );
    assert.equal((await store.readMediaAsset('legacy-video')).base64, Buffer.from('video').toString('base64'));

    // A tile-sized rendition is impossible for these stub bytes (and video
    // needs ffmpeg): the read must REPORT the miss instead of quietly
    // shipping the original, which is what made the remote gallery slow.
    const missing = await store.readMediaAsset('legacy-image', {
      variant: 'thumb',
      generate: false,
    });
    assert.equal(missing.available, false);
    assert.equal(missing.base64, '');
    // Callers that can afford full-size bytes (local IPC) opt in explicitly
    // and get them labelled as a downgrade.
    const downgraded = await store.readMediaAsset('legacy-image', {
      variant: 'thumb',
      allowOriginal: true,
      generate: false,
    });
    assert.equal(downgraded.variant, 'original');
    assert.equal(downgraded.downgraded, true);
    assert.equal(downgraded.base64, Buffer.from('image').toString('base64'));
    const browserThumb = Buffer.from('browser-generated-thumbnail');
    const cached = store.cacheMediaThumbnail('legacy-video', {
      mime: 'image/jpeg',
      base64: browserThumb.toString('base64'),
      durationSeconds: 7,
    });
    assert.equal(cached.available, true);
    const cachedTarget = await store.resolveMediaFile('legacy-video', {
      variant: 'thumb',
      generate: false,
    });
    assert.equal(
      cachedTarget.available,
      true,
      'a cache-only local protocol probe must serve a browser-generated rendition'
    );
    const cachedRead = await store.readMediaAsset('legacy-video', { variant: 'thumb' });
    assert.equal(cachedRead.mime, 'image/jpeg');
    assert.equal(cachedRead.base64, browserThumb.toString('base64'));
    assert.equal(cachedRead.durationSeconds, 7);

    assert.match(saved.file, /^videos\/gemini\/veo-3-preview\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.mp4$/);
    assert.equal(existsSync(join(assetsDir, ...saved.file.split('/'))), true);
    assert.equal(store.deleteMediaAsset(saved.id).removed, true);
    assert.equal(existsSync(join(assetsDir, ...saved.file.split('/'))), false);

    const persisted = JSON.parse(readFileSync(join(root, 'media', 'index.json'), 'utf8'));
    assert.equal(persisted.version, 2);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed duration write leaves the cached index row untouched', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-media-duration-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const assetsDir = join(root, 'media', 'assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, 'clip.mp4'), Buffer.from('video'));
  writeFileSync(
    join(root, 'media', 'index.json'),
    JSON.stringify({
      version: 2,
      assets: [
        {
          id: 'clip',
          file: 'clip.mp4',
          kind: 'video',
          lane: 'grok',
          model: 'm',
          mime: 'video/mp4',
          bytes: 5,
          createdAt: 1,
        },
      ],
    })
  );
  try {
    const store = await import(`./store.mjs?test=duration-${Date.now()}`);
    store.listMediaAssets({ limit: 10 });
    // A read-only index makes the atomic replace fail on Windows.
    const indexFile = join(root, 'media', 'index.json');
    chmodSync(indexFile, 0o444);
    const cachedRow = store.listMediaAssets({ limit: 10 }).assets[0];
    assert.throws(() =>
      store.cacheMediaThumbnail('clip', {
        mime: 'image/jpeg',
        base64: Buffer.from('thumb').toString('base64'),
        durationSeconds: 7,
      })
    );
    assert.equal(cachedRow.durationSeconds, undefined);
    assert.equal(store.listMediaAssets({ limit: 10 }).assets[0].durationSeconds, undefined);
    chmodSync(indexFile, 0o644);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('bulk media cleanup previews, then deletes by age, missing file, selection, and kind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-media-bulk-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const assetsDir = join(root, 'media', 'assets');
  const day = 24 * 60 * 60 * 1_000;
  const now = Date.now();
  const row = (id, kind, age, present = true) => {
    const file = `${id}.${kind === 'video' ? 'mp4' : 'png'}`;
    if (present) writeFileSync(join(assetsDir, file), Buffer.from(id));
    return {
      id,
      file,
      kind,
      lane: 'gemini',
      model: 'm',
      prompt: id,
      mime: kind === 'video' ? 'video/mp4' : 'image/png',
      bytes: 1,
      createdAt: now - age * day,
    };
  };
  mkdirSync(assetsDir, { recursive: true });
  const assets = [
    row('fresh', 'image', 1),
    row('old', 'image', 40),
    row('gone', 'image', 2, false),
    row('picked', 'image', 3),
    row('clip', 'video', 60),
  ];
  writeFileSync(join(root, 'media', 'index.json'), JSON.stringify({ version: 2, assets }));

  try {
    const store = await import(`./store.mjs?bulk=${Date.now()}`);
    const ids = () => store.listMediaAssets({ limit: 50 }).assets.map((entry) => entry.id);
    assert.throws(() => store.deleteMediaAssets({ kind: 'image' }), /needs ids, before, missing, or all/);

    const preview = store.deleteMediaAssets({ kind: 'image', before: now - 30 * day, dryRun: true });
    assert.deepEqual(preview.ids, ['old'], 'the age filter stays inside the requested kind');
    assert.equal(ids().length, 5, 'a dry run deletes nothing');

    assert.deepEqual(store.deleteMediaAssets({ ids: preview.ids }).ids, ['old']);
    assert.equal(existsSync(join(assetsDir, 'old.png')), false);

    assert.deepEqual(store.deleteMediaAssets({ kind: 'image', missing: true }).ids, ['gone']);
    assert.deepEqual(store.deleteMediaAssets({ ids: ['picked', 'clip'], kind: 'image' }).ids, ['picked']);
    assert.deepEqual(store.deleteMediaAssets({ kind: 'image', all: true }).ids, ['fresh']);
    assert.deepEqual(ids(), ['clip'], 'other kinds survive a whole-tab delete');
    assert.equal(existsSync(join(assetsDir, 'clip.mp4')), true);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a NUL-filled media index lists an empty gallery, is kept aside, and saving still works', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-media-damaged-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'media'), { recursive: true });
  writeFileSync(join(root, 'media', 'index.json'), Buffer.alloc(128));
  try {
    const store = await import(`./store.mjs?test=damaged-${Date.now()}`);
    assert.deepEqual(store.listMediaAssets({ limit: 10 }), { total: 0, assets: [] });
    assert.ok(readdirSync(join(root, 'media')).some((name) => name.startsWith('index.json.corrupt-')));
    const saved = store.saveMediaAsset({
      kind: 'image',
      lane: 'lane',
      model: 'model',
      prompt: 'p',
      mime: 'image/png',
      bytes: Buffer.from('png-bytes'),
    });
    assert.equal(store.listMediaAssets({ limit: 10 }).total, 1);
    assert.equal(readFileSync(join(root, 'media', 'assets', ...saved.file.split('/'))).toString(), 'png-bytes');
    // The next save keeps the previous catalog as the restorable last good copy.
    store.saveMediaAsset({
      kind: 'image',
      lane: 'lane',
      model: 'model',
      prompt: 'q',
      mime: 'image/png',
      bytes: Buffer.from('b'),
    });
    assert.equal(JSON.parse(readFileSync(join(root, 'media', 'index.json.bak'), 'utf8')).assets.length, 1);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});
