import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  writeFileSync(join(root, 'media', 'index.json'), JSON.stringify({
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
  }));

  try {
    const store = await import(`./store.mjs?test=${Date.now()}`);
    assert.deepEqual(
      store.mediaOpenCommand('C:\\Media Assets\\clip.mp4', {
        reveal: true,
        platform: 'win32',
      }),
      ['explorer.exe', ['/select,', 'C:\\Media Assets\\clip.mp4']],
    );
    assert.deepEqual(
      store.mediaOpenCommand('/Users/me/Media Assets/image.png', {
        reveal: true,
        platform: 'darwin',
      }),
      ['open', ['-R', '/Users/me/Media Assets/image.png']],
    );
    const beforeMigration = store.listMediaAssets({ limit: 10 }).assets;
    assert.equal(beforeMigration[0].file, 'legacy-image.jpg',
      'read-only listing must not run the write-side layout migration');
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
    const listed = ['legacy-image', 'legacy-video'].map((id) =>
      migrated.find((entry) => entry.id === id));
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
    assert.equal(cacheAfterReads.indexDiskReads, cacheBeforeReads.indexDiskReads,
      'a thumbnail-resolution burst must reuse the parsed media index');
    assert.ok(cacheAfterReads.indexCacheHits >= cacheBeforeReads.indexCacheHits + 3);
    const cachedOnlyMiss = await store.resolveMediaFile('legacy-image', {
      variant: 'thumb',
      generate: false,
    });
    assert.equal(cachedOnlyMiss.available, false,
      'a local protocol probe must not start native rendition generation on a cache miss');
    assert.equal(
      (await store.readMediaAsset('legacy-video')).base64,
      Buffer.from('video').toString('base64'),
    );

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
    assert.equal(cachedTarget.available, true,
      'a cache-only local protocol probe must serve a browser-generated rendition');
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
