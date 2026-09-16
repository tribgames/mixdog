#!/usr/bin/env node
/**
 * Resolve, download, hash, and write src/runtime/tidy/engines-manifest.json.
 *
 *   node scripts/tidy/sync-engines-manifest.mjs
 *   node scripts/tidy/sync-engines-manifest.mjs --check
 *   node scripts/tidy/sync-engines-manifest.mjs --pin biome=@biomejs/biome@2.5.13
 *
 * clang-format source: the npm `clang-format` 1.8.0 tarball only ships
 * win32 / linux_x64 / darwin_x64. muttleyxd/clang-tools-static-binaries
 * clang-format-20 adds darwin-arm64 but still has no linux-arm64. The
 * four available platforms use muttleyxd so every host runs the same
 * clang-format major; linux-arm64 is omitted.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = join(ROOT, 'src/runtime/tidy/engines-manifest.json');
const TMP_DIR = join(ROOT, '.tmp-tidy-engines');
const MANIFEST_VERSION = 1;
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
const PLATFORMS = Object.freeze(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);

/** @typedef {{ match: (name: string, ctx: { tag: string, version: string }) => boolean, archive?: 'none'|'zip'|'tar.gz', binNames?: string[] }} AssetSpec */

/**
 * Embedded engine table. `optional` engines (mago, air) are dropped unless
 * every platform key resolves. Required engines omit a platform key when
 * upstream has no asset.
 *
 * @type {readonly object[]}
 */
const ENGINES = Object.freeze([
  {
    id: 'biome',
    repo: 'biomejs/biome',
    license: 'MIT',
    kind: ['format', 'lint'],
    languages: ['javascript', 'typescript'],
    homepage: 'https://biomejs.dev',
    versionFromTag: (tag) => tag.replace(/^@biomejs\/biome@/, ''),
    binNames: ['biome', 'biome.exe'],
    assets: {
      'darwin-arm64': exact('biome-darwin-arm64'),
      'darwin-x64': exact('biome-darwin-x64'),
      'linux-arm64': exact('biome-linux-arm64'),
      'linux-x64': exact('biome-linux-x64'),
      'win32-x64': exact('biome-win32-x64.exe'),
    },
  },
  {
    id: 'ruff',
    repo: 'astral-sh/ruff',
    license: 'MIT',
    kind: ['format', 'lint'],
    languages: ['python'],
    homepage: 'https://docs.astral.sh/ruff',
    binNames: ['ruff', 'ruff.exe'],
    assets: {
      'darwin-arm64': exact('ruff-aarch64-apple-darwin.tar.gz'),
      'darwin-x64': exact('ruff-x86_64-apple-darwin.tar.gz'),
      'linux-arm64': exact('ruff-aarch64-unknown-linux-gnu.tar.gz'),
      'linux-x64': exact('ruff-x86_64-unknown-linux-gnu.tar.gz'),
      'win32-x64': exact('ruff-x86_64-pc-windows-msvc.zip'),
    },
  },
  {
    id: 'clang-format',
    repo: 'muttleyxd/clang-tools-static-binaries',
    license: 'Apache-2.0 WITH LLVM-exception',
    kind: ['format'],
    languages: ['c', 'cpp', 'objc', 'java', 'csharp'],
    homepage: 'https://clang.llvm.org/docs/ClangFormat.html',
    resolve: 'clang-format-major',
    binNames: [],
    assets: {},
  },
  {
    id: 'shfmt',
    repo: 'mvdan/sh',
    license: 'BSD-3-Clause',
    kind: ['format'],
    languages: ['bash'],
    homepage: 'https://github.com/mvdan/sh',
    binNames: ['shfmt', 'shfmt.exe'],
    assets: mvdanAssets('shfmt'),
  },
  {
    id: 'shellcheck',
    repo: 'koalaman/shellcheck',
    license: 'GPL-3.0',
    kind: ['lint'],
    languages: ['bash'],
    homepage: 'https://www.shellcheck.net',
    mirror: false,
    binNames: ['shellcheck', 'shellcheck.exe'],
    assets: {
      'darwin-arm64': versioned((v) => `shellcheck-v${v}.darwin.aarch64.tar.gz`),
      'darwin-x64': versioned((v) => `shellcheck-v${v}.darwin.x86_64.tar.gz`),
      'linux-arm64': versioned((v) => `shellcheck-v${v}.linux.aarch64.tar.gz`),
      'linux-x64': versioned((v) => `shellcheck-v${v}.linux.x86_64.tar.gz`),
      'win32-x64': versioned((v) => `shellcheck-v${v}.zip`),
    },
  },
  {
    id: 'stylua',
    repo: 'JohnnyMorganz/StyLua',
    license: 'MPL-2.0',
    kind: ['format'],
    languages: ['lua'],
    homepage: 'https://github.com/JohnnyMorganz/StyLua',
    binNames: ['stylua', 'stylua.exe'],
    assets: {
      'darwin-arm64': exact('stylua-macos-aarch64.zip'),
      'darwin-x64': exact('stylua-macos-x86_64.zip'),
      'linux-arm64': exact('stylua-linux-aarch64.zip'),
      'linux-x64': exact('stylua-linux-x86_64.zip'),
      'win32-x64': exact('stylua-windows-x86_64.zip'),
    },
  },
  {
    id: 'gofumpt',
    repo: 'mvdan/gofumpt',
    license: 'BSD-3-Clause',
    kind: ['format'],
    languages: ['go'],
    homepage: 'https://github.com/mvdan/gofumpt',
    binNames: ['gofumpt', 'gofumpt.exe'],
    assets: mvdanAssets('gofumpt'),
  },
  {
    id: 'dprint',
    repo: 'dprint/dprint',
    license: 'MIT',
    kind: ['format'],
    languages: ['javascript', 'typescript'],
    homepage: 'https://dprint.dev',
    binNames: ['dprint', 'dprint.exe'],
    assets: {
      'darwin-arm64': exact('dprint-aarch64-apple-darwin.zip'),
      'darwin-x64': exact('dprint-x86_64-apple-darwin.zip'),
      'linux-arm64': exact('dprint-aarch64-unknown-linux-gnu.zip'),
      'linux-x64': exact('dprint-x86_64-unknown-linux-gnu.zip'),
      'win32-x64': exact('dprint-x86_64-pc-windows-msvc.zip'),
    },
  },
  {
    id: 'mago',
    repo: 'carthage-software/mago',
    license: 'MIT',
    kind: ['format', 'lint'],
    languages: ['php'],
    homepage: 'https://mago.carthage.software/',
    optional: true,
    binNames: ['mago', 'mago.exe'],
    assets: {
      'darwin-arm64': versioned((v) => `mago-${v}-aarch64-apple-darwin.tar.gz`),
      'darwin-x64': versioned((v) => `mago-${v}-x86_64-apple-darwin.tar.gz`),
      'linux-arm64': versioned((v) => `mago-${v}-aarch64-unknown-linux-gnu.tar.gz`),
      'linux-x64': versioned((v) => `mago-${v}-x86_64-unknown-linux-gnu.tar.gz`),
      'win32-x64': versioned((v) => `mago-${v}-x86_64-pc-windows-msvc.zip`),
    },
  },
  {
    id: 'air',
    repo: 'posit-dev/air',
    license: 'MIT',
    kind: ['format'],
    languages: ['r'],
    homepage: 'https://posit-dev.github.io/air',
    optional: true,
    binNames: ['air', 'air.exe'],
    assets: {
      'darwin-arm64': exact('air-aarch64-apple-darwin.tar.gz'),
      'darwin-x64': exact('air-x86_64-apple-darwin.tar.gz'),
      'linux-arm64': exact('air-aarch64-unknown-linux-gnu.tar.gz'),
      'linux-x64': exact('air-x86_64-unknown-linux-gnu.tar.gz'),
      'win32-x64': exact('air-x86_64-pc-windows-msvc.zip'),
    },
  },
]);

function exact(name) {
  return { match: (candidate) => candidate === name };
}

function versioned(build) {
  return { match: (candidate, ctx) => candidate === build(ctx.version) };
}

function mvdanAssets(prefix) {
  return {
    'darwin-arm64': versioned((v) => `${prefix}_v${v}_darwin_arm64`),
    'darwin-x64': versioned((v) => `${prefix}_v${v}_darwin_amd64`),
    'linux-arm64': versioned((v) => `${prefix}_v${v}_linux_arm64`),
    'linux-x64': versioned((v) => `${prefix}_v${v}_linux_amd64`),
    'win32-x64': versioned((v) => `${prefix}_v${v}_windows_amd64.exe`),
  };
}

function parseArgs(argv) {
  const pins = new Map();
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--pin') {
      const spec = argv[i + 1];
      i += 1;
      const eq = spec?.indexOf('=') ?? -1;
      if (!spec || eq <= 0) throw new Error('--pin requires <id>=<tag>');
      pins.set(spec.slice(0, eq), spec.slice(eq + 1));
      continue;
    }
    if (arg.startsWith('--pin=')) {
      const spec = arg.slice('--pin='.length);
      const eq = spec.indexOf('=');
      if (eq <= 0) throw new Error('--pin requires <id>=<tag>');
      pins.set(spec.slice(0, eq), spec.slice(eq + 1));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { check, pins };
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'mixdog-tidy-engines-sync',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function downloadHeaders() {
  const headers = { 'User-Agent': 'mixdog-tidy-engines-sync' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubJson(url) {
  const response = await fetch(url, { headers: githubHeaders(), redirect: 'follow' });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub ${response.status} ${url}${body ? `\n${body.slice(0, 400)}` : ''}`);
  }
  return response.json();
}

async function fetchRelease(repo, tag) {
  if (tag) {
    return githubJson(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  }
  return githubJson(`https://api.github.com/repos/${repo}/releases/latest`);
}

function toSemver(raw) {
  const cleaned = String(raw).replace(/^v/, '');
  if (/^\d+\.\d+\.\d+$/.test(cleaned)) return cleaned;
  if (/^\d+\.\d+$/.test(cleaned)) return `${cleaned}.0`;
  if (/^\d+$/.test(cleaned)) return `${cleaned}.0.0`;
  throw new Error(`cannot map '${raw}' to x.y.z`);
}

function archiveOf(name, explicit) {
  if (explicit) return explicit;
  if (name.endsWith('.tar.gz')) return 'tar.gz';
  if (name.endsWith('.zip')) return 'zip';
  return 'none';
}

function clangFormatAssets(release) {
  const names = (release.assets || [])
    .filter((asset) => asset.state === 'uploaded')
    .map((asset) => asset.name)
    .filter((name) => /^clang-format-\d+/.test(name) && !name.endsWith('sum'));
  const majors = [
    ...new Set(
      names.map((name) => {
        const match = /^clang-format-(\d+)/.exec(name);
        return match ? Number(match[1]) : 0;
      })
    ),
  ]
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const major = majors.at(-1);
  if (!major) throw new Error('no clang-format-N assets on muttleyxd release');
  const prefix = `clang-format-${major}_`;
  const map = {
    'darwin-arm64': `${prefix}macos-arm-arm64`,
    'darwin-x64': `${prefix}macosx-amd64`,
    'linux-x64': `${prefix}linux-amd64`,
    'win32-x64': `${prefix}windows-amd64.exe`,
  };
  const assets = {};
  for (const [platform, name] of Object.entries(map)) {
    assets[platform] = { match: (candidate) => candidate === name };
  }
  return { version: `${major}.0.0`, assets, missing: ['linux-arm64'] };
}

function findAsset(release, spec, ctx) {
  const hits = (release.assets || []).filter((asset) => asset.state === 'uploaded' && spec.match(asset.name, ctx));
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    throw new Error(`ambiguous asset match for ${ctx.id} ${ctx.platform}: ${hits.map((a) => a.name).join(', ')}`);
  }
  return hits[0];
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

function encodeManifest(manifest) {
  return `${JSON.stringify(sortValue(manifest), null, 2)}\n`;
}

function listZip(buffer) {
  const sig = 0x06054b50;
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === sig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip EOCD not found');
  let offset = buffer.readUInt32LE(eocd + 16);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const end = offset + cdSize;
  const names = [];
  while (offset + 46 <= end && offset + 46 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    names.push(buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8'));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function listTarGz(buffer) {
  const tar = gunzipSync(buffer);
  const names = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = `${prefix}/${name}`;
    const sizeOct = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeOct, 8) || 0;
    const type = String.fromCharCode(header[156] || 0);
    if (type === 'L' || type === 'K') {
      const next = tar
        .subarray(offset + 512, offset + 512 + size)
        .toString('utf8')
        .replace(/\0.*$/, '');
      offset += 512 + Math.ceil(size / 512) * 512;
      if (type === 'L') {
        names.push(next);
        const real = tar.subarray(offset, offset + 512);
        const realSize = Number.parseInt(real.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
        offset += 512 + Math.ceil(realSize / 512) * 512;
        continue;
      }
    } else if (name) {
      names.push(name);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

function pickBinPath(entries, binNames, fallback) {
  const files = entries.map((entry) => entry.replace(/\\/g, '/')).filter((entry) => entry && !entry.endsWith('/'));
  for (const want of binNames) {
    const hit = files.find((file) => file === want || file.endsWith(`/${want}`));
    if (hit) return hit;
  }
  const loose = files.filter((file) => {
    const base = file.split('/').pop();
    return binNames.some((want) => {
      const stem = want.replace(/\.exe$/i, '');
      return base === want || base.startsWith(`${stem}-`) || base.startsWith(`${stem}_`) || base.startsWith(stem);
    });
  });
  if (loose.length === 1) return loose[0];
  if (fallback && files.includes(fallback)) return fallback;
  throw new Error(`no binary ${binNames.join('|')} in archive (found ${files.slice(0, 12).join(', ') || 'nothing'})`);
}

async function downloadAsset(url, dest) {
  const response = await fetch(url, {
    headers: downloadHeaders(),
    redirect: 'follow',
    signal: AbortSignal.timeout(300_000),
  });
  if (response.status >= 400 && response.status < 500) {
    throw new Error(`HTTP ${response.status} is terminal — ${url}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} — ${url}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_ASSET_BYTES) {
    return { skipped: true, reason: `content-length ${declared} > ${MAX_ASSET_BYTES}`, bytes: declared };
  }
  if (!response.body) throw new Error(`empty body — ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  const hash = createHash('sha256');
  let received = 0;
  let oversize = false;
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > MAX_ASSET_BYTES) {
        oversize = true;
        cb(new Error('MAX_ASSET_BYTES'));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(dest));
  } catch (error) {
    await rm(dest, { force: true });
    if (oversize) {
      return { skipped: true, reason: `download exceeded ${MAX_ASSET_BYTES}`, bytes: received };
    }
    throw error;
  }
  return { skipped: false, sha256: hash.digest('hex'), bytes: received };
}

function log(line) {
  process.stderr.write(`${line}\n`);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function resolveEngine(engine, pinTag) {
  const release = await fetchRelease(engine.repo, pinTag);
  const tag = release.tag_name;
  let version;
  let assetSpecs = engine.assets;
  const omitted = [];
  if (engine.resolve === 'clang-format-major') {
    const picked = clangFormatAssets(release);
    version = picked.version;
    assetSpecs = picked.assets;
    omitted.push(...picked.missing);
  } else {
    version = toSemver(engine.versionFromTag ? engine.versionFromTag(tag) : tag);
  }
  const resolved = [];
  for (const platform of PLATFORMS) {
    const spec = assetSpecs[platform];
    if (!spec) {
      omitted.push(platform);
      continue;
    }
    const asset = findAsset(release, spec, { id: engine.id, platform, tag, version });
    if (!asset) {
      omitted.push(platform);
      continue;
    }
    resolved.push({
      platform,
      name: asset.name,
      url: asset.browser_download_url,
      archive: archiveOf(asset.name, spec.archive),
      apiSize: asset.size || 0,
    });
  }
  return { tag, version, resolved, omitted: [...new Set(omitted)] };
}

async function materializeAsset(engine, item, destDir) {
  const dest = join(destDir, `${engine.id}-${item.platform}-${item.name.replace(/[\\/]/g, '_')}`);
  log(`download ${engine.id} ${item.platform} ${item.name} (${formatBytes(item.apiSize)})`);
  const result = await downloadAsset(item.url, dest);
  if (result.skipped) {
    return { ...result, platform: item.platform, name: item.name, url: item.url };
  }
  let binPath = item.name;
  if (item.archive !== 'none') {
    const buf = await readFile(dest);
    const entries = item.archive === 'zip' ? listZip(buf) : listTarGz(buf);
    binPath = pickBinPath(entries, engine.binNames || [], item.name);
  }
  return {
    skipped: false,
    platform: item.platform,
    name: item.name,
    url: item.url,
    archive: item.archive,
    sha256: result.sha256,
    bytes: result.bytes,
    binPath,
  };
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

async function generate(pins) {
  const notes = [];
  const engines = {};
  const perPlatform = Object.fromEntries(PLATFORMS.map((p) => [p, 0]));
  await mkdir(TMP_DIR, { recursive: true });

  for (const engine of ENGINES) {
    const pin = pins.get(engine.id);
    log(`resolve ${engine.id} ${pin ? `pin=${pin}` : 'latest'} (${engine.repo})`);
    const resolved = await resolveEngine(engine, pin);
    log(`  tag ${resolved.tag} version ${resolved.version}`);
    if (engine.optional && resolved.omitted.length) {
      notes.push(`dropped ${engine.id}: missing ${resolved.omitted.join(', ')}`);
      log(`  DROP optional engine, missing ${resolved.omitted.join(', ')}`);
      continue;
    }
    if (resolved.resolved.length === 0) {
      throw new Error(`${engine.id}: no platform assets on ${resolved.tag}`);
    }
    if (resolved.omitted.length) {
      notes.push(`${engine.id} ${resolved.tag}: omitted ${resolved.omitted.join(', ')} (upstream has no asset)`);
      log(`  omit ${resolved.omitted.join(', ')}`);
    }
    const downloaded = await mapPool(resolved.resolved, 3, (item) => materializeAsset(engine, item, TMP_DIR));
    const assets = {};
    for (const item of downloaded) {
      if (item.skipped) {
        notes.push(`${engine.id} ${item.platform}: skipped ${item.name} (${item.reason})`);
        log(`  SKIP ${item.platform} ${item.reason}`);
        continue;
      }
      assets[item.platform] = {
        url: item.url,
        sha256: item.sha256,
        archive: item.archive,
        binPath: item.binPath,
      };
      perPlatform[item.platform] += item.bytes;
      log(`  ${item.platform} ${formatBytes(item.bytes)} ${item.sha256} bin=${item.binPath}`);
    }
    if (engine.optional && PLATFORMS.some((platform) => !assets[platform])) {
      const missing = PLATFORMS.filter((platform) => !assets[platform]);
      notes.push(`dropped ${engine.id}: assets missing after download (${missing.join(', ')})`);
      continue;
    }
    if (Object.keys(assets).length === 0) {
      throw new Error(`${engine.id}: every asset skipped or missing`);
    }
    engines[engine.id] = {
      version: resolved.version,
      license: engine.license,
      kind: [...engine.kind],
      languages: [...engine.languages],
      homepage: engine.homepage,
      source: 'upstream',
      assets,
    };
  }

  const manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    engines,
  };
  await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, encodeManifest(manifest));
  log(`wrote ${MANIFEST_PATH}`);
  for (const platform of PLATFORMS) {
    log(`total ${platform} ${formatBytes(perPlatform[platform])}`);
  }
  for (const note of notes) log(`note: ${note}`);
  return { manifest, notes, perPlatform };
}

async function check() {
  const committed = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  if (committed.version !== MANIFEST_VERSION) {
    throw new Error(`manifest version ${committed.version} != ${MANIFEST_VERSION}`);
  }
  await mkdir(TMP_DIR, { recursive: true });
  const failures = [];
  const jobs = [];
  for (const [id, engine] of Object.entries(committed.engines || {})) {
    for (const [platform, asset] of Object.entries(engine.assets || {})) {
      jobs.push({ id, platform, asset });
    }
  }
  await mapPool(jobs, 3, async (job) => {
    const expected = String(job.asset.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      failures.push(`${job.id} ${job.platform}: missing sha256`);
      return;
    }
    const dest = join(TMP_DIR, `check-${job.id}-${job.platform}`);
    log(`check ${job.id} ${job.platform}`);
    const result = await downloadAsset(job.asset.url, dest);
    if (result.skipped) {
      failures.push(`${job.id} ${job.platform}: skipped (${result.reason})`);
      return;
    }
    if (result.sha256 !== expected) {
      failures.push(`${job.id} ${job.platform}: sha256 ${result.sha256} != ${expected}`);
      return;
    }
    log(`  ok ${job.id} ${job.platform} ${formatBytes(result.bytes)}`);
  });
  if (failures.length) {
    throw new Error(`--check failed:\n${failures.map((line) => `  ${line}`).join('\n')}`);
  }
  log('--check passed');
}

async function main() {
  const { check: checkOnly, pins } = parseArgs(process.argv.slice(2));
  for (const id of pins.keys()) {
    if (!ENGINES.some((engine) => engine.id === id)) {
      throw new Error(`--pin unknown engine '${id}'`);
    }
  }
  if (checkOnly) {
    await check();
    return;
  }
  await generate(pins);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
