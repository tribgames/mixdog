// Classifies the test files a `node scripts/test.mjs --lane all` run failed, for the K1 cut.
//
//   node scripts/k1-failing-tests.mjs --run <this branch's run log> --reference <o1's run log of the same lane>
//        --manifest <k1-deletion-manifest.txt> [--root <repo root>]
//
// A run log is the runner's output; the files are read from its "[failure-summary] FAILED <file> > ..." lines.
//   a  the file is on the manifest under a section that deletes it (DELETE*, BLOCKED-*, SCRIPTS, SCRIPT TESTS)
//   b  not on the delete list, and it fails on the reference too (it fails regardless of this branch)
//   c  not on the delete list and passes on the reference: this branch broke it. The reason is the first import,
//      followed through the files the test loads, that no longer exists in this tree.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []));
const root = resolve(args.root ?? '.');

const failedFiles = (logPath) => new Set([...readFileSync(logPath, 'utf8').matchAll(/\[failure-summary\] FAILED (\S+) >/g)].map((m) => m[1].replaceAll('\\', '/')));

const DELETING = /^## (DELETE|BLOCKED-|SCRIPTS|SCRIPT TESTS)/;
function deletedByManifest(manifestPath) {
  const deleted = new Set();
  let deleting = false;
  for (const line of readFileSync(manifestPath, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('## ')) deleting = DELETING.test(line);
    else if (deleting && line.trim() && !line.startsWith('#')) deleted.add(line.trim().replaceAll('\\', '/').replace(/\s+#.*$/, ''));
  }
  return deleted;
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
// The first relative import that is missing, searching the files the test loads (breadth-first, each file once).
function missingImport(file) {
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length) {
    const from = queue.shift();
    const text = readFileSync(resolve(root, from), 'utf8');
    for (const [, spec] of text.matchAll(IMPORT)) {
      const target = resolve(dirname(resolve(root, from)), spec);
      const rel = target.slice(root.length + 1).replaceAll('\\', '/');
      if (!existsSync(target)) return `${from} imports ${rel} (missing)`;
      if (/\.(mjs|js|jsx|ts)$/.test(rel) && !seen.has(rel) && !rel.includes('node_modules')) {
        seen.add(rel);
        queue.push(rel);
      }
    }
  }
  return null;
}

const failed = [...failedFiles(args.run)].sort();
const reference = failedFiles(args.reference);
const deleted = deletedByManifest(args.manifest);
const rows = failed.map((file) => {
  if (deleted.has(file)) return { file, cls: 'a' };
  if (reference.has(file)) return { file, cls: 'b' };
  return { file, cls: 'c', reason: missingImport(file) ?? 'no missing import found' };
});
for (const { file, cls, reason } of rows) console.log(`${cls}\t${file}${reason ? `\t${reason}` : ''}`);
const count = (cls) => rows.filter((row) => row.cls === cls).length;
console.log(`total ${rows.length}: a (on the delete list) ${count('a')}, b (also fails on the reference) ${count('b')}, c (broken by this branch) ${count('c')}`);
