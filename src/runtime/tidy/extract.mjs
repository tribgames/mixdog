// Archive extraction for managed engine downloads. zip goes through the
// existing `jszip` dependency (lazily imported — the tidy tool must not pay for
// it on boot) and tar.gz through node:zlib plus the minimal ustar reader below.
// No new dependencies, and no shelling out to tar/unzip.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const TAR_BLOCK = 512;

/** Reject absolute paths, drive letters, and any `..` traversal segment. */
export function isSafeEntryPath(name) {
  const value = String(name || '').replaceAll('\\', '/');
  if (!value || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '..');
}

function readField(block, start, length) {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function readOctal(block, start, length) {
  const text = readField(block, start, length).trim();
  if (!text) return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Minimal ustar/GNU reader: regular files and directories, with `prefix`
 * support, GNU long names (typeflag 'L'), and pax headers skipped.
 */
export function parseUstar(buffer) {
  const entries = [];
  let offset = 0;
  let longName = '';
  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = readField(header, 0, 100);
    const mode = readOctal(header, 100, 8);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0).replace('\u0000', '');
    const prefix = readField(header, 345, 155);
    const dataStart = offset + TAR_BLOCK;
    const data = buffer.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (typeflag === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') continue;
    const full = longName || (prefix ? `${prefix}/${name}` : name);
    longName = '';
    if (!full) continue;
    if (typeflag === '5') {
      entries.push({ name: full.replace(/\/+$/, ''), type: 'dir', mode, size: 0, data: Buffer.alloc(0) });
      continue;
    }
    if (typeflag === '' || typeflag === '0') {
      entries.push({ name: full, type: 'file', mode, size, data: Buffer.from(data) });
    }
  }
  return entries;
}

function writeEntry(destDir, name, data, mode) {
  const target = join(destDir, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  if (process.platform !== 'win32' && mode) {
    try { chmodSync(target, mode & 0o777); } catch { /* best-effort */ }
  }
  return name;
}

/** Extract a .tar.gz into destDir; returns the written entry names. */
export function extractTarGz(srcPath, destDir) {
  const entries = parseUstar(gunzipSync(readFileSync(srcPath)));
  const written = [];
  for (const entry of entries) {
    if (!isSafeEntryPath(entry.name)) {
      throw new Error(`refusing unsafe archive entry: ${entry.name}`);
    }
    if (entry.type === 'dir') {
      mkdirSync(join(destDir, entry.name), { recursive: true });
      continue;
    }
    written.push(writeEntry(destDir, entry.name, entry.data, entry.mode));
  }
  return written;
}

/** Extract a .zip into destDir; returns the written entry names. */
export async function extractZip(srcPath, destDir) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(readFileSync(srcPath));
  const written = [];
  for (const [name, file] of Object.entries(zip.files)) {
    if (!isSafeEntryPath(name)) {
      throw new Error(`refusing unsafe archive entry: ${name}`);
    }
    if (file.dir) {
      mkdirSync(join(destDir, name), { recursive: true });
      continue;
    }
    const data = await file.async('nodebuffer');
    const mode = Number(file.unixPermissions) || 0;
    written.push(writeEntry(destDir, name, data, mode));
  }
  return written;
}

/** Extract by manifest archive kind; 'none' copies the single downloaded file. */
export async function extractArchive({ archive, srcPath, destDir, binPath }) {
  mkdirSync(destDir, { recursive: true });
  if (archive === 'zip') return extractZip(srcPath, destDir);
  if (archive === 'tar.gz' || archive === 'tgz') return extractTarGz(srcPath, destDir);
  if (archive === 'none' || !archive) {
    const name = String(binPath || '').replaceAll('\\', '/');
    if (!isSafeEntryPath(name)) throw new Error(`refusing unsafe binPath: ${binPath}`);
    return [writeEntry(destDir, name, readFileSync(srcPath), 0o755)];
  }
  throw new Error(`unsupported archive kind "${archive}"`);
}
