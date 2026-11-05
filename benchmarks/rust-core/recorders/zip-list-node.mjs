// Prints the file list today's Node `scanFolder` (zip-folder.ts) keeps for each folder given,
// as JSON: [{ root, files: [rel...], ignored }]. The Rust workspace crate's zip test runs it
// live over generated repos and compares lists (DS-WS-7).
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/zip-list-node.mjs --tree <desktop repo root>
// with the folders as a JSON array in the ZIP_FOLDERS environment variable.
import { realpathSync } from 'node:fs';
import { importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const folders = JSON.parse(process.env.ZIP_FOLDERS ?? '[]');
const zip = await importFrom(tree, 'apps/desktop/src/main/zip-folder.ts');
const out = [];
for (const folder of folders) {
  const root = realpathSync(folder);
  const scan = await zip.scanFolder(root, { maxBytes: 2 ** 40, maxFiles: 1e9 });
  out.push({ root: folder, files: scan.files.map((f) => f.rel), ignored: scan.ignored });
}
process.stdout.write(`${JSON.stringify(out)}\n`);
