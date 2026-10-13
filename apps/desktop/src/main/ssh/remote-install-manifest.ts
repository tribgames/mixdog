// The server payload's manifest and wire archive. The desktop hashes every
// file it ships; the server unpacks the archive into a staging directory and
// re-hashes what landed on ITS disk against the manifest before the install
// is trusted.
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);

export interface PayloadFile {
  /** Relative to the version directory, `/`-separated. */
  path: string;
  size: number;
  sha256: string;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** One digest over the sorted manifest: the build identity of the payload.
 *  The server program carries the same function (REMOTE_MANIFEST_SOURCE). */
export function manifestBuildHash(files: readonly PayloadFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  return hash.digest('hex').slice(0, 16);
}

/** gzip( u32be manifestLength · manifest JSON · file bytes in manifest order ). */
export async function encodePayloadArchive(
  files: readonly PayloadFile[],
  read: (path: string) => Promise<Buffer>
): Promise<Buffer> {
  const manifest = Buffer.from(JSON.stringify({ files }), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifest.length, 0);
  const parts: Buffer[] = [header, manifest];
  for (const file of files) {
    const data = await read(file.path);
    if (data.length !== file.size || sha256Hex(data) !== file.sha256) {
      throw new Error(`${file.path} changed while the server payload was being built.`);
    }
    parts.push(data);
  }
  return gzipAsync(Buffer.concat(parts));
}

/** Defines manifestBuildHash, unpackPayload(archive, dir) and
 *  verifyManifest(dir, manifest, expectedBuildHash). */
export const REMOTE_MANIFEST_SOURCE = String.raw`
function manifestBuildHash(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(file.path + '\0' + file.size + '\0' + file.sha256 + '\n');
  return hash.digest('hex').slice(0, 16);
}
function safeManifestPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
  return rel.split('/').every((part) => part && part !== '.' && part !== '..');
}
function unpackPayload(archive, dir) {
  let data;
  try { data = zlib.gunzipSync(archive); } catch (error) { fail('install-failed', 'The uploaded server payload is not a valid archive: ' + error.message); }
  if (data.length < 4) fail('install-failed', 'The uploaded server payload is truncated.');
  const headerLength = data.readUInt32BE(0);
  let manifest = null;
  try { manifest = JSON.parse(data.subarray(4, 4 + headerLength).toString('utf8')); } catch {}
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) fail('install-failed', 'The uploaded server payload has no manifest.');
  let offset = 4 + headerLength;
  for (const file of manifest.files) {
    if (!safeManifestPath(file.path) || !Number.isInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(String(file.sha256))) {
      fail('install-failed', 'The server payload manifest has an invalid entry: ' + JSON.stringify(file).slice(0, 200));
    }
    const end = offset + file.size;
    if (end > data.length) fail('install-failed', 'The uploaded server payload is truncated at ' + file.path + '.');
    const target = path.join(dir, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data.subarray(offset, end));
    offset = end;
  }
  if (offset !== data.length) fail('install-failed', 'The uploaded server payload has trailing bytes.');
  fs.writeFileSync(path.join(dir, '.manifest.json'), JSON.stringify(manifest));
  return manifest;
}
function verifyManifest(dir, manifest, expectedBuildHash) {
  const actual = manifestBuildHash(manifest.files);
  if (actual !== expectedBuildHash) fail('install-failed', 'The server payload manifest hashes to ' + actual + ', expected ' + expectedBuildHash + '.');
  for (const file of manifest.files) {
    let data = null;
    try { data = fs.readFileSync(path.join(dir, ...file.path.split('/'))); } catch {}
    if (!data) fail('install-failed', 'The uploaded file ' + file.path + ' is missing on the server.');
    if (data.length !== file.size || sha256Of(data) !== file.sha256) fail('install-failed', 'The uploaded file ' + file.path + ' does not match its sha256 in the manifest.');
  }
}
`;
