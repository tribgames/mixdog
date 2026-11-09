#!/usr/bin/env node
// What Node's `absoluteLocalPath` (apps/desktop/src/main/local-files.ts, the shape check every local-path operation of the phone runs first)
// answers for each class of input, recorded from an exact export of b6f10295a on this Windows host. A path without a drive resolves onto
// the working directory's drive, so each input is recorded with the working directory on each drive present.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-absolute-local-path.mjs --tree <git archive of b6f10295a with node_modules>
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'absolute-local-path');
const DRIVES = ['C', 'D'];
const tree = resolveTree(parseArgs());

// `absent` is the argument `undefined` (a missing `path` param), which JSON cannot hold.
const inputs = [
  ['relative', 'relative/dir'],
  ['dot', '.'],
  ['dot-dot', '..'],
  ['dot slash', './x'],
  ['dot-dot backslash', '..\\x'],
  ['drive-relative', 'C:foo'],
  ['drive-relative other drive', 'D:foo'],
  ['drive only', 'C:'],
  ['rooted slash', '/dir'],
  ['rooted backslash', '\\dir'],
  ['rooted with dot-dot and trailing slash', '/dir/../x/'],
  ['root slash', '/'],
  ['root backslash', '\\'],
  ['two slashes and a name', '//server'],
  ['two backslashes and a name', '\\\\server'],
  ['drive-absolute', 'C:\\a\\b\\..\\c'],
  ['drive-absolute forward slashes, lower case', 'c:/A/B/'],
  ['drive-absolute with a trailing separator', 'C:\\a\\'],
  ['drive root', 'C:\\'],
  ['drive root dot-dot', 'C:\\..'],
  ['UNC share', '//server/share'],
  ['UNC with dot-dot and a trailing separator', '\\\\server\\share\\a\\..\\b\\'],
  ['two slashes, name and trailing slash', '//tmp/Mixed/'],
  ['device path ?', '\\\\?\\C:\\x\\y'],
  ['device path .', '\\\\.\\C:\\x'],
  ['device UNC', '\\\\?\\UNC\\srv\\sh\\a'],
  ['device path with forward slashes', '//?/C:/x'],
  ['trimmed spaces', ' D:\\x '],
  ['trimmed tab and newline', '\tD:\\x\n'],
  ['trimmed no-break space and BOM', '\u00a0\ufeffD:\\x\u00a0\ufeff'],
  ['empty', ''],
  ['blank', '   '],
  ['NUL inside', 'a\u0000b'],
  ['NUL after a drive-absolute path', 'C:\\a\u0000'],
  ['16384 characters', `C:\\${'a'.repeat(16_381)}`],
  ['16385 characters', `C:\\${'a'.repeat(16_382)}`],
  ['null', null],
  ['number', 123],
  ['true', true],
  ['object', {}],
  ['array', []],
  ['object with a path', { path: 'C:\\x' }],
].map(([name, value]) => ({ name, value }));
inputs.push({ name: 'undefined', absent: true });

const { absoluteLocalPath } = await importFrom(tree, 'apps/desktop/src/main/local-files.ts');
const answer = (input) => {
  try {
    return { result: absoluteLocalPath(input.absent ? undefined : input.value) };
  } catch (error) {
    return { error: { name: error.name, message: error.message } };
  }
};

const drives = {};
for (const drive of DRIVES) {
  const root = `${drive}:\\`;
  if (!existsSync(root)) continue;
  process.chdir(root);
  drives[drive] = inputs.map(answer);
}
if (!Object.keys(drives).length) throw new Error(`none of the drives ${DRIVES.join(', ')} exists on this host`);

const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), {
  note: "Node's absoluteLocalPath per class of input, on a Windows host: per working-directory drive, each input's answer (the resolved path) or its error (name and message), in the order of `inputs`.",
  inputs,
  drives,
});
writeSetManifest(out, {
  set: 'absolute-local-path',
  recorder: 'benchmarks/rust-core/recorders/record-absolute-local-path.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-absolute-local-path.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
  extra: { inputs: inputs.length, drives: Object.keys(drives) },
});
commitStage(out, FIXTURES);
console.log(`absolute-local-path: ${inputs.length} inputs on drives ${Object.keys(drives).join(', ')}`);
process.exit(0);
