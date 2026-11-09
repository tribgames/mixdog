// Classifies the failing tests of a `node scripts/test.mjs --lane all` run, for the K1 cut.
//
//   node scripts/k1-failing-tests.mjs --run <this branch's run log> --reference <o1's run log of the same lane>
//        --manifest <k1-deletion-manifest.txt> [--root <repo root>]
//
// A run log is the runner's output. A failure is a "[failure-summary] FAILED <file> > <test>" line; its reason is the
// first message line of the log's "failing tests:" block for that test. A test process that exited before reporting
// (the summary name is "<file> (test process exited with code N)") has the first "Error ...:" line of that file's stderr.
//   a  the file is on the manifest under a section that deletes it (DELETE*, BLOCKED-*, SCRIPTS, SCRIPT TESTS)
//   b  not on the delete list, and every one of its failing tests fails on the reference with the same test name and
//      the same reason: it fails regardless of this branch
//   c  not on the delete list, and some failing test has no identical failure on the reference: this branch (or
//      something new in the run) broke it
// The import check runs on every file whatever its class: the first relative import, followed through the files the
// test loads, that no longer exists in this tree. A file in class b or c with a missing import is flagged "IMPORT".
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []));
const root = resolve(args.root ?? '.');

const slash = (text) => text.replaceAll('\\', '/');
// A reason compared across two checkouts: absolute roots and timings differ between runs, nothing else should.
const normalize = (text) =>
  slash(text)
    .replace(/[A-Za-z]:\/[^\s'")]*?\/(?:w18|dcr)\//g, '<root>/')
    .replace(/\d+(?:\.\d+)?ms\b/g, 'Nms')
    .trim();

const FILE_MARK = /^[✔✖] (\S+\.mjs) \(/;
function parseLog(logPath) {
  const lines = readFileSync(logPath, 'utf8').split(/\r?\n/);
  const start = lines.indexOf('✖ failing tests:');
  // stderr reasons of process exits: the text between the previous file marker and this file's own marker
  const exitReason = new Map();
  let segmentStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const mark = FILE_MARK.exec(lines[i]);
    if (!mark) continue;
    if (i < start || start < 0) {
      const error = lines.slice(segmentStart, i).find((line) => /^\s*\w*Error(?: \[\w+\])?: /.test(line));
      exitReason.set(slash(mark[1]), error ? normalize(error) : 'no error line in stderr');
    }
    segmentStart = i + 1;
  }
  const blockReason = new Map();
  for (let i = start + 1; start >= 0 && i < lines.length; i += 1) {
    const block = /^test at (.+?):\d+:\d+$/.exec(lines[i]);
    if (!block) continue;
    const name = /^✖ (.+?) \([\d.]+ms\)$/.exec(lines[i + 1] ?? '')?.[1];
    let j = i + 2;
    while (j < lines.length && !lines[j].trim()) j += 1;
    if (name) blockReason.set(`${slash(block[1])}\0${name}`, normalize(lines[j] ?? ''));
  }
  const failures = new Map();
  for (const [, file, name] of lines.join('\n').matchAll(/\[failure-summary\] FAILED (\S+) > (.+)/g)) {
    const key = slash(file);
    const exited = /\(test process exited with code/.test(name);
    const reason = exited ? exitReason.get(slash(name.split(' (test process')[0])) ?? 'no error line in stderr' : blockReason.get(`${slash(file)}\0${name}`) ?? 'no message in the failing tests block';
    if (!failures.has(key)) failures.set(key, []);
    failures.get(key).push({ name: normalize(name), reason });
  }
  return failures;
}

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

const failures = parseLog(args.run);
const reference = parseLog(args.reference);
const deleted = deletedByManifest(args.manifest);
const sameFailureOnReference = (file) =>
  failures.get(file).every((f) => (reference.get(file) ?? []).some((r) => r.name === f.name && r.reason === f.reason));
const rows = [...failures.keys()].sort().map((file) => {
  const missing = existsSync(resolve(root, file)) ? missingImport(file) : `${file} is not in this tree`;
  if (deleted.has(file)) return { file, cls: 'a', missing };
  if (sameFailureOnReference(file)) return { file, cls: 'b', missing };
  const differing = failures.get(file).filter((f) => !(reference.get(file) ?? []).some((r) => r.name === f.name && r.reason === f.reason));
  return { file, cls: 'c', missing, why: `${differing.length} test(s) without an identical failure on the reference, e.g. "${differing[0].name}": ${differing[0].reason}` };
});
for (const { file, cls, missing, why } of rows) console.log(`${cls}\t${file}${missing ? `\tIMPORT ${missing}` : ''}${why ? `\t${why}` : ''}`);
const count = (cls) => rows.filter((row) => row.cls === cls).length;
console.log(`total ${rows.length}: a (on the delete list) ${count('a')}, b (every failing test fails identically on the reference) ${count('b')}, c (not on the reference) ${count('c')}`);
console.log(`import check: ${rows.filter((r) => r.missing).length} files have a missing import (a ${rows.filter((r) => r.missing && r.cls === 'a').length}, b ${rows.filter((r) => r.missing && r.cls === 'b').length}, c ${rows.filter((r) => r.missing && r.cls === 'c').length})`);