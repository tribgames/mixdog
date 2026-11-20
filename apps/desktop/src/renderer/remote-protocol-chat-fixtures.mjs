// The phone chat's recorded fixtures, each a folder of N recordings of a running mixdogd with its MANIFEST.json: the count and order of
// the recordings with each file's sha256, and the recorder and the local modules it imports with theirs.
// Loading verifies all of it: a file missing, extra or changed, or a recorder file changed since the recordings were made, fails.
//
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs src/renderer/remote-protocol-chat-fixtures.mjs <fixture> <recording.json>...
// installs the recordings as the fixture's folder (live | refusals).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Each fixture's folder and the files its recorder is made of (paths relative to this folder). */
export const FIXTURES = {
  live: {
    dir: 'remote-protocol-chat-live.core/',
    recorder: [
      'remote-protocol-chat-live.record.mjs',
      '../../../../packages/protocol-client/src/client.ts',
      'remote-protocol-chat-abort-live.mjs',
      'remote-protocol-chat-record-core.mjs',
      'remote-protocol-chat-fixtures.mjs',
      'remote-protocol-chat-abort-procs.mjs',
    ],
  },
  refusals: {
    dir: 'remote-protocol-chat-refusals.core/',
    recorder: [
      'remote-protocol-chat-refusals.record.mjs',
      '../../../../packages/protocol-client/src/client.ts',
      '../main/protocol/service-route.ts',
      '../shared/core-lanes/service-route.ts',
      'remote-protocol-chat-abort-live.mjs',
      'remote-protocol-chat-record-core.mjs',
      'remote-protocol-chat-fixtures.mjs',
      'remote-protocol-chat-abort-procs.mjs',
    ],
  },
};

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dirOf = (name) => new URL(FIXTURES[name].dir, import.meta.url);
export const recorderHashes = (name) =>
  Object.fromEntries(
    FIXTURES[name].recorder.map((file) => [file, sha256(readFileSync(new URL(file, import.meta.url)))])
  );

/** Every file of the public harness the core recorders run on (lib/), by name: what a capture is bound to. */
export function harnessHashes(lib = new URL('./remote-protocol-chat-harness/lib/', import.meta.url)) {
  if (!existsSync(lib)) throw new Error('the public harness remote-protocol-chat-harness/lib is missing');
  return Object.fromEntries(
    readdirSync(lib)
      .sort()
      .map((file) => [`lib/${file}`, sha256(readFileSync(new URL(file, lib)))])
  );
}

/** The one folder name a recording's core-visible paths live under (a run's own folder inside it, at a drive's root): no user or checkout in it. */
export const NEUTRAL_ROOT = 'mixdog-chat-record';
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|*?]*/g;
const NEUTRAL_PATH = new RegExp(`^[A-Za-z]:[\\\\/]${NEUTRAL_ROOT}[\\\\/]`, 'i');
// /home/ names a profile only as a rooted path: a protocol method such as agent/home/open is not one.
const PROFILE_PATH = /\\\\(?![?.]\\)[^\\/]|[\\/]Users[\\/]|(?<![A-Za-z0-9_])[\\/]home[\\/]/;
/**
 * The first string anywhere in `value` (keys included) that names a private path: a drive path outside the neutral folder, a UNC path, a user
 * profile. Raw text is only looked at, never changed: a recording that has one is refused whole.
 */
export function privatePathIn(value) {
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        strings.push(k);
        walk(x);
      }
  })(value);
  for (const s of strings) {
    if (PROFILE_PATH.test(s)) return s;
    for (const [path] of s.matchAll(DRIVE_PATH)) if (!NEUTRAL_PATH.test(path)) return path;
  }
  return null;
}

/** A core recording, whole, must be of this checkout's recorder and public harness as they are now, bind a core build by hash, and name no private path. */
export function checkCoreRecording(name, file, recording) {
  const label = `${FIXTURES[name].dir}${file}`;
  const manifest = recording.manifest;
  const hex = /^[0-9a-f]{64}$/;
  if (JSON.stringify(manifest.recorder) !== JSON.stringify(recorderHashes(name)))
    throw new Error(`${label} was captured by another recorder than the current one: record again`);
  if (JSON.stringify(manifest.harness) !== JSON.stringify(harnessHashes()))
    throw new Error(`${label} was captured on another public harness than the current one: record again`);
  if (!hex.test(manifest.binarySha256 ?? '') || !hex.test(manifest.builtFrom?.sourceSha256 ?? ''))
    throw new Error(`${label} does not bind its core binary and the sources it was built from`);
  if (!/^[A-Za-z0-9._-]+$/.test(manifest.binary ?? ''))
    throw new Error(`${label}: the manifest's binary must be a bare file name`);
  if (
    manifest.clientVersion !== JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
  )
    throw new Error(`${label} announced another client version than this tree's`);
  const leaked = privatePathIn(recording);
  if (leaked) throw new Error(`${label} names a private path: ${leaked}`);
}

/** The fixture's manifest and recordings, verified against its folder (`dir`, by default its own) and its recorder as they are now. */
export function verifiedFixture(name, dir = dirOf(name)) {
  const manifest = JSON.parse(readFileSync(new URL('MANIFEST.json', dir), 'utf8'));
  const present = readdirSync(dir)
    .filter((file) => file !== 'MANIFEST.json')
    .sort();
  const listed = manifest.recordings.map((r) => r.file).sort();
  if (JSON.stringify(present) !== JSON.stringify(listed))
    throw new Error(
      `${FIXTURES[name].dir} holds ${JSON.stringify(present)}, its manifest lists ${JSON.stringify(listed)}`
    );
  if (manifest.count !== manifest.recordings.length)
    throw new Error(
      `${FIXTURES[name].dir}: the manifest counts ${manifest.count} recordings and lists ${manifest.recordings.length}`
    );
  const recordings = manifest.recordings.map(({ file, sha256: want }) => {
    const bytes = readFileSync(new URL(file, dir));
    if (sha256(bytes) !== want)
      throw new Error(
        `${FIXTURES[name].dir}${file} is not the recording the manifest names (sha256 ${sha256(bytes)}, manifest ${want})`
      );
    return JSON.parse(bytes.toString('utf8'));
  });
  const now = recorderHashes(name);
  if (JSON.stringify(Object.keys(manifest.recorder).sort()) !== JSON.stringify(Object.keys(now).sort()))
    throw new Error(`${FIXTURES[name].dir}: the manifest does not hash every recorder file`);
  for (const [file, want] of Object.entries(manifest.recorder)) {
    if (now[file] !== want)
      throw new Error(
        `${file} changed since ${FIXTURES[name].dir} was recorded (sha256 ${now[file]}, manifest ${want}): record again`
      );
  }
  manifest.recordings.forEach(({ file }, i) => checkCoreRecording(name, file, recordings[i]));
  return { manifest, recordings };
}

/**
 * Installs `files` (recordings, in order) as the fixture `name`, with `extra` fields in its manifest. Each file is read once: the bytes that
 * are validated are the bytes that are written and hashed, and nothing of the old fixture is cleared before every recording has passed.
 */
export function installFixture(name, files, extra = {}) {
  const bytesOf = files.map((file) => readFileSync(file));
  const recordings = bytesOf.map((bytes) => JSON.parse(bytes.toString('utf8')));
  recordings.forEach((r, i) => checkCoreRecording(name, files[i], r));
  const listed = bytesOf.map((bytes, i) => ({ file: `${String(i + 1).padStart(2, '0')}.json`, sha256: sha256(bytes) }));
  const manifest = {
    count: files.length,
    recordings: listed,
    recorder: recorderHashes(name),
    ...extra,
  };
  const dir = dirOf(name);
  mkdirSync(dir, { recursive: true });
  for (const file of readdirSync(dir)) rmSync(new URL(file, dir));
  listed.forEach(({ file }, i) => writeFileSync(new URL(file, dir), bytesOf[i]));
  writeFileSync(new URL('MANIFEST.json', dir), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, recordings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [name, ...files] = process.argv.slice(2);
  if (!FIXTURES[name] || !files.length)
    throw new Error(`usage: <${Object.keys(FIXTURES).join(' | ')}> <recording.json>...`);
  const { manifest } = installFixture(name, files);
  console.log(`installed ${manifest.count} recordings as ${FIXTURES[name].dir}`);
}
