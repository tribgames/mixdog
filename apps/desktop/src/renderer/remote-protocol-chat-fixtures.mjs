// The phone chat's recorded fixtures, each a folder of N recordings with its MANIFEST.json: the count and order of the recordings
// with each file's sha256, the recorder and the local modules it imports with theirs, and (for a recording of Node) the Node commit.
// Loading verifies all of it: a file missing, extra or changed, or a recorder file changed since the recordings were made, fails.
//
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs src/renderer/remote-protocol-chat-fixtures.mjs <fixture> <recording.json>...
// installs the recordings as the fixture's folder (history | roster | live | refusals).
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Each fixture's folder and the files its recorder is made of (paths relative to this folder). */
export const FIXTURES = {
  // Node's state history at the store's publish, one recording per case, each recorded twice byte-identical before it was installed.
  history: {
    dir: 'remote-protocol-chat-history.node/',
    recorder: [
      'remote-protocol-chat-history.record.mjs',
      'remote-protocol-chat-history-loader.mjs',
      'remote-protocol-chat-vclock.mjs',
      'remote-protocol-chat-node-export.mjs',
      'remote-protocol-chat-abort-cases.mjs',
      'remote-protocol-chat-abort-provider.mjs',
      'remote-protocol-chat-abort-procs.mjs',
    ],
    node: true,
  },
  roster: { dir: 'remote-protocol-chat-roster.node/', recorder: ['remote-protocol-chat-roster.record.mjs'], node: true },
  live: { dir: 'remote-protocol-chat-live.core/', recorder: ['remote-protocol-chat-live.record.mjs', '../../../../packages/protocol-client/src/client.ts', 'remote-protocol-chat-abort-procs.mjs'], node: false },
  refusals: {
    dir: 'remote-protocol-chat-refusals.core/',
    recorder: ['remote-protocol-chat-refusals.record.mjs', '../../../../packages/protocol-client/src/client.ts', '../main/protocol/service-route.ts', 'remote-protocol-chat-abort-procs.mjs'],
    node: false,
  },
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dirOf = (name) => new URL(FIXTURES[name].dir, import.meta.url);
const recorderHashes = (name) => Object.fromEntries(FIXTURES[name].recorder.map((file) => [file, sha256(readFileSync(new URL(file, import.meta.url)))]));

/** The fixture's manifest and recordings, verified against its folder (`dir`, by default its own) and its recorder as they are now. */
export function verifiedFixture(name, dir = dirOf(name)) {
  const manifest = JSON.parse(readFileSync(new URL('MANIFEST.json', dir), 'utf8'));
  const present = readdirSync(dir).filter((file) => file !== 'MANIFEST.json').sort();
  const listed = manifest.recordings.map((r) => r.file).sort();
  if (JSON.stringify(present) !== JSON.stringify(listed)) throw new Error(`${FIXTURES[name].dir} holds ${JSON.stringify(present)}, its manifest lists ${JSON.stringify(listed)}`);
  if (manifest.count !== manifest.recordings.length) throw new Error(`${FIXTURES[name].dir}: the manifest counts ${manifest.count} recordings and lists ${manifest.recordings.length}`);
  const recordings = manifest.recordings.map(({ file, sha256: want }) => {
    const bytes = readFileSync(new URL(file, dir));
    if (sha256(bytes) !== want) throw new Error(`${FIXTURES[name].dir}${file} is not the recording the manifest names (sha256 ${sha256(bytes)}, manifest ${want})`);
    return JSON.parse(bytes.toString('utf8'));
  });
  const now = recorderHashes(name);
  if (JSON.stringify(Object.keys(manifest.recorder).sort()) !== JSON.stringify(Object.keys(now).sort())) throw new Error(`${FIXTURES[name].dir}: the manifest does not hash every recorder file`);
  for (const [file, want] of Object.entries(manifest.recorder)) {
    if (now[file] !== want) throw new Error(`${file} changed since ${FIXTURES[name].dir} was recorded (sha256 ${now[file]}, manifest ${want}): record again`);
  }
  if (FIXTURES[name].node) {
    for (const r of recordings) if (r.manifest.commit !== manifest.commit || r.manifest.exact !== true) throw new Error(`${FIXTURES[name].dir}: a recording is not of the manifest's exact Node commit`);
  }
  return { manifest, recordings };
}

/** Installs `files` (recordings, in order) as the fixture `name`, with `extra` fields in its manifest. */
export function installFixture(name, files, extra = {}) {
  const recordings = files.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  const commit = FIXTURES[name].node ? recordings[0].manifest.commit : undefined;
  if (FIXTURES[name].node) for (const r of recordings) if (r.manifest.commit !== commit || r.manifest.exact !== true) throw new Error('the recordings are not all of one exact Node commit');
  const dir = dirOf(name);
  mkdirSync(dir, { recursive: true });
  for (const file of readdirSync(dir)) rmSync(new URL(file, dir));
  const listed = files.map((file, i) => {
    const bytes = readFileSync(file);
    const named = `${String(i + 1).padStart(2, '0')}.json`;
    writeFileSync(new URL(named, dir), bytes);
    return { file: named, sha256: sha256(bytes) };
  });
  const manifest = { count: files.length, ...(commit ? { commit } : {}), recordings: listed, recorder: recorderHashes(name), ...extra };
  writeFileSync(new URL('MANIFEST.json', dir), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, recordings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [name, ...files] = process.argv.slice(2);
  if (!FIXTURES[name] || !files.length) throw new Error(`usage: <${Object.keys(FIXTURES).join(' | ')}> <recording.json>...`);
  const { manifest } = installFixture(name, files);
  console.log(`installed ${manifest.count} recordings as ${FIXTURES[name].dir}`);
}
