// Records the glibc floor of an unpacked Linux package: the highest
// GLIBC_x.y symbol version any bundled ELF file imports (objdump -T).
//   node scripts/linux-glibc-floor.mjs <unpackedDir> [maxAllowed]
// Prints the top files and the overall floor; exits 1 when a floor above
// [maxAllowed] (e.g. 2.35 for Ubuntu 22.04) is exceeded.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const maxAllowed = process.argv[3];
const parse = (v) => v.split('.').map(Number);
const cmp = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  return x[0] - y[0] || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
};
const isElf = (file) => {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    return readSync(fd, buf, 0, 4, 0) === 4 && buf.toString('latin1') === '\x7fELF';
  } finally {
    closeSync(fd);
  }
};
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}
const perFile = [];
let scanned = 0;
for await (const file of walk(root)) {
  if (!isElf(file)) continue;
  scanned += 1;
  let text;
  try {
    text = execFileSync('objdump', ['-T', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    continue; // static binaries have no dynamic symbol table
  }
  let max = '';
  for (const m of text.matchAll(/\(GLIBC_(\d+(?:\.\d+)+)\)/g)) if (!max || cmp(m[1], max) > 0) max = m[1];
  if (max) perFile.push({ file: relative(root, file), max });
}
perFile.sort((a, b) => cmp(b.max, a.max));
const floor = perFile[0]?.max ?? '0';
console.log(`scanned ${scanned} ELF files; ${perFile.length} import GLIBC symbols`);
for (const { file, max } of perFile.slice(0, 15)) console.log(`GLIBC_${max}  ${file}`);
console.log(`GLIBC FLOOR: ${floor}`);
if (maxAllowed && cmp(floor, maxAllowed) > 0) {
  console.error(`glibc floor ${floor} exceeds allowed ${maxAllowed}`);
  process.exit(1);
}
