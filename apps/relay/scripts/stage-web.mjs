// Stage the built desktop renderer beside the relay for web-app deployment.
//
// Text assets are precompressed here rather than on the VPS: a phone pays for
// every byte over a mobile link, brotli lands well under on-the-fly gzip, and
// the 1GB relay box stops re-compressing the same megabyte stylesheet for
// every visitor (which also cuts the wait before the first byte). Build
// filenames carry a content hash, so compressed output is reusable — a
// redeploy only pays for the chunks that actually changed.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';

const relayRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rendererDist = join(relayRoot, '..', 'desktop', 'out', 'renderer');
const webDir = join(relayRoot, 'renderer');
// Survives the staging wipe below: keyed by the hashed build filename, so a
// hit is byte-identical to what compression would produce again.
const cacheDir = join(relayRoot, '.web-precompress');

const compressBrotli = promisify(brotliCompress);

// woff2/png/ico arrive compressed; re-encoding them only burns build time.
const COMPRESSIBLE = new Set([
  '.js', '.mjs', '.css', '.html', '.json', '.webmanifest', '.svg', '.txt', '.map', '.wasm',
]);
const MIN_BYTES = 1024;
// Below this the encoded copy is not worth the extra file (and the extra stat
// on every request).
const KEEP_RATIO = 0.95;
// Quality 11 costs ~8s on the 7.6MB Monaco chunk for ~10% over quality 10.
const LARGE_FILE_BYTES = 2 * 1024 * 1024;
// zlib's async API runs on the libuv threadpool, so this is real parallelism;
// the bound keeps peak memory to a handful of buffered chunks.
const CONCURRENCY = 6;
const HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.[^.]+$/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

async function mapPool(items, limit, run) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await run(items[index]);
    }
  });
  await Promise.all(lanes);
}

const stats = { files: 0, raw: 0, brotli: 0, cacheHits: 0 };

async function encode(cacheName, cacheable, produce) {
  const cachePath = join(cacheDir, cacheName);
  if (cacheable && existsSync(cachePath)) {
    stats.cacheHits += 1;
    return readFileSync(cachePath);
  }
  const encoded = await produce();
  if (cacheable) {
    try { writeFileSync(cachePath, encoded); } catch { /* cache is optional */ }
  }
  return encoded;
}

async function precompress(file) {
  const raw = readFileSync(file);
  if (raw.length < MIN_BYTES) return;
  const relativeName = relative(webDir, file);
  const cacheKey = relativeName.split(sep).join('_');
  const cacheable = HASHED_NAME.test(relativeName);
  const quality = raw.length >= LARGE_FILE_BYTES ? 10 : 11;
  // Brotli only. A staged .gz would add ~4.6MB of already-compressed bytes to
  // every deploy upload for the vanishingly rare client that negotiates gzip
  // but not brotli — and the relay still answers that client from its
  // on-the-fly gzip path.
  const brotliBody = await encode(`${cacheKey}.br`, cacheable, () => compressBrotli(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: quality,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  }));
  if (brotliBody.length < raw.length * KEEP_RATIO) {
    writeFileSync(`${file}.br`, brotliBody);
    stats.files += 1;
    stats.raw += raw.length;
    stats.brotli += brotliBody.length;
  }
}

if (!existsSync(join(rendererDist, 'index.html'))) {
  console.error('[relay] renderer build not found. Run `npm run build` in apps/desktop first.');
  process.exit(1);
}
rmSync(webDir, { recursive: true, force: true });
cpSync(rendererDist, webDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

const targets = [...walk(webDir)].filter((file) => COMPRESSIBLE.has(extname(file).toLowerCase()));
const startedAt = Date.now();
await mapPool(targets, CONCURRENCY, precompress);

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)}MB`;
console.log(`[relay] staged web app -> ${webDir}`);
console.log(
  `[relay] precompressed ${stats.files} files: ${mb(stats.raw)} -> ${mb(stats.brotli)} brotli`
  + ` (${stats.cacheHits} cache hits, ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
);
