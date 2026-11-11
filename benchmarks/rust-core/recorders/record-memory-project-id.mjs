#!/usr/bin/env node
// Node's project id marker read (src/runtime/memory/lib/project-id-resolver.test.mjs, 1 case) from the real
// `resolveProjectId`: a NUL-filled `.mixdog/project.id` is no marker, a real one resolves; further marker contents
// (common, any case, blank, CRLF, inner empty marker under an outer one, no marker) show the rest of the read.
//
//   node benchmarks/rust-core/recorders/record-memory-project-id.mjs --tree <dir>
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { begin, capture, finish, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const { resolveProjectId } = await importFrom(ctx.tree, 'src/runtime/memory/lib/project-id-resolver.mjs');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-project-id-')));
let n = 0;
const projectWithId = (bytes) => {
  const root = join(base, `p${n++}`);
  mkdirSync(join(root, '.mixdog'), { recursive: true });
  if (bytes !== null) writeFileSync(join(root, '.mixdog', 'project.id'), bytes);
  return root;
};
const hex = (bytes) => (bytes === null ? null : Buffer.from(bytes).toString('hex'));
const probe = async (name, bytes, sub = '') => {
  const root = projectWithId(bytes);
  const cwd = sub ? join(root, sub) : root;
  if (sub) mkdirSync(cwd, { recursive: true });
  return { name, markerBytesHex: hex(bytes), cwdBelowMarkerRoot: sub || '.', ...(await capture(() => resolveProjectId(cwd))) };
};

const cases = [
  await probe('a NUL-filled project.id is no marker', Buffer.alloc(64)),
  await probe('a real one still resolves', 'my-project\n'),
  await probe('common is the common scope', 'common\n'),
  await probe('COMMON in any case', 'CoMMon'),
  await probe('blank marker', '  \n\t '),
  await probe('empty marker', ''),
  await probe('CRLF line end', 'win-project\r\n'),
  await probe('NUL bytes with text are kept as read', Buffer.concat([Buffer.from('abc'), Buffer.alloc(3)])),
  await probe('a sub directory resolves through the ancestor marker', 'outer\n', 'a/b'),
];
{
  const outer = projectWithId('outer-id\n');
  const inner = join(outer, 'inner');
  mkdirSync(join(inner, '.mixdog'), { recursive: true });
  cases.push({ name: 'an inner .mixdog without project.id does not mask the outer marker', innerHasMarker: false, ...(await capture(() => resolveProjectId(inner))) });
}
{
  const bare = join(base, 'bare');
  mkdirSync(bare, { recursive: true });
  cases.push({ name: 'no marker in any ancestor of the temp base', ...(await capture(() => resolveProjectId(bare))) });
}
rmSync(base, { recursive: true, force: true });

finish(ctx, {
  url: import.meta.url,
  set: 'memory-project-id',
  golden: { domain: 'memory-project-id', source: 'src/runtime/memory/lib/project-id-resolver.test.mjs', cases },
  extra: {
    entry: { runs: 'resolveProjectId (project-id-resolver.mjs) on real directories with a .mixdog/project.id of the given bytes', notRun: 'resolveProjectScope (explicit session cwd): no case of the test file' },
    replay: "mixdog-services memory/project.rs: pub async fn resolve_project_id (:33), which reads .mixdog/project.id (:37) through the ancestors (:21). A replay writes each case's marker bytes into a temp directory and compares the resolved id",
    exclusions: 'the last case ("no marker in any ancestor") depends on the temp base having no .mixdog/project.id above it: true on the recording PC; a replay must run in a base with none',
    normalised: { paths: 'directories are temp; the recording holds marker bytes (hex) and the sub path, not absolute paths' },
  },
});
process.exit(0);
