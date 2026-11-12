#!/usr/bin/env node
// Node's project id marker read (src/runtime/memory/lib/project-id-resolver.test.mjs, 1 case) from the real
// `resolveProjectId` on real directory trees: a NUL-filled `.mixdog/project.id` is no marker, a real one resolves;
// further marker contents (common, any case, blank, CRLF, inner empty marker under an outer one, no marker) show the
// rest of the read. Each case records the tree it built (`layout`) and the directory it resolved from (`cwd`).
//
//   node benchmarks/rust-core/recorders/record-memory-project-id.mjs --tree <dir>
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { begin, capture, finish, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const { resolveProjectId } = await importFrom(ctx.tree, 'src/runtime/memory/lib/project-id-resolver.mjs');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-project-id-')));
const hex = (bytes) => Buffer.from(bytes).toString('hex');
let n = 0;
/**
 * Builds the case's directory tree under a fresh root (`layout`: directories, and files with their bytes, by path
 * relative to the root, in creation order), resolves from `cwd` below the root, and records the layout as made.
 */
const probe = async (name, entries, cwd) => {
  const root = join(base, `p${n++}`);
  mkdirSync(root);
  const layout = [];
  for (const entry of entries) {
    if (entry.bytes === undefined) {
      mkdirSync(join(root, entry.path), { recursive: true });
      layout.push({ dir: entry.path });
    } else {
      writeFileSync(join(root, entry.path), entry.bytes);
      layout.push({ file: entry.path, bytesHex: hex(entry.bytes) });
    }
  }
  return { name, layout, cwd, ...(await capture(() => resolveProjectId(join(root, cwd)))) };
};
const marker = (bytes, sub) => [{ path: '.mixdog' }, { path: '.mixdog/project.id', bytes }, ...(sub ? [{ path: sub }] : [])];

const cases = [
  await probe('a NUL-filled project.id is no marker', marker(Buffer.alloc(64)), '.'),
  await probe('a real one still resolves', marker('my-project\n'), '.'),
  await probe('common is the common scope', marker('common\n'), '.'),
  await probe('COMMON in any case', marker('CoMMon'), '.'),
  await probe('blank marker', marker('  \n\t '), '.'),
  await probe('empty marker', marker(''), '.'),
  await probe('CRLF line end', marker('win-project\r\n'), '.'),
  await probe('NUL bytes with text are kept as read', marker(Buffer.concat([Buffer.from('abc'), Buffer.alloc(3)])), '.'),
  await probe('a sub directory resolves through the ancestor marker', marker('outer\n', 'a/b'), 'a/b'),
  await probe('an inner .mixdog without project.id does not mask the outer marker', [...marker('outer-id\n'), { path: 'inner/.mixdog' }], 'inner'),
  await probe('no marker in any ancestor of the temp base', [{ path: 'bare' }], 'bare'),
];
rmSync(base, { recursive: true, force: true });

finish(ctx, {
  url: import.meta.url,
  set: 'memory-project-id',
  golden: { domain: 'memory-project-id', source: 'src/runtime/memory/lib/project-id-resolver.test.mjs', cases },
  extra: {
    entry: { runs: 'resolveProjectId (project-id-resolver.mjs) on a real directory tree per case, built on disk from the case\'s `layout` (directories and marker files with their bytes), resolved from `cwd`', notRun: 'resolveProjectScope (explicit session cwd): no case of the test file' },
    replay: "mixdog-services memory/project.rs resolve_project_id, which reads .mixdog/project.id through the cwd's ancestors on disk. The replay (memory/replays/project_id.rs) builds each case's directory tree from the recorded `layout` under a fresh temp root, in order, resolves from the recorded `cwd` and compares the result whole; it checks that no marker lies above the temp root, as on the recording PC",
    exclusions: 'none',
    normalised: { paths: 'the root of each tree is a temp directory; the recording holds the layout and cwd relative to it' },
  },
});
process.exit(0);
