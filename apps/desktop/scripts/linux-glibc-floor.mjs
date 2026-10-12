// Glibc floor of an extracted Linux package: the highest GLIBC_x.y version any
// bundled ELF file requires. Fails closed.
//   node scripts/linux-glibc-floor.mjs <extractedDir> [maxAllowed]
//        [--arch x64|arm64] [--require rel/path,rel/path,...]
// Point it at the payload extracted from the built .deb (dpkg-deb -x) or
// AppImage (--appimage-extract), never at a build directory. It exits non-zero when
//   - objdump is missing or fails on any ELF of the package architecture,
//   - an ELF that links glibc (NEEDED libc.so.6 ...) yields no GLIBC_ symbol,
//   - a --require path is not a scanned ELF of the package architecture,
//   - no GLIBC symbols were found at all, or the floor exceeds [maxAllowed].
// ELF files built for another architecture (e.g. node-pty's linux-arm
// prebuilds) cannot load on this package and are counted, not parsed.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const [, value] = args.splice(index, 2);
  return value;
};
const archName = flag('--arch') ?? process.arch;
const required = (flag('--require') ?? '').split(',').filter(Boolean);
const [rootArg, maxAllowed] = args;
const machines = { x64: 62, arm64: 183 };
const machine = machines[archName];
const die = (message) => {
  console.error(`GLIBC FLOOR CHECK FAILED: ${message}`);
  process.exit(1);
};
if (!rootArg) die('usage: linux-glibc-floor.mjs <dir> [maxAllowed] [--arch x64|arm64] [--require a,b]');
if (!machine) die(`unsupported --arch ${archName}`);
const root = resolve(rootArg);

const objdump = (...objdumpArgs) => {
  try {
    return execFileSync('objdump', objdumpArgs, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.code === 'ENOENT' ? 'objdump is not installed' : String(error.stderr || error.message).trim();
    return die(`objdump ${objdumpArgs.join(' ')}: ${detail}`);
  }
};
objdump('--version');

const parse = (v) => v.split('.').map(Number);
const cmp = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  return x[0] - y[0] || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
};
const elfMachine = (file) => {
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(20);
    if (readSync(fd, header, 0, 20, 0) < 20 || header.toString('latin1', 0, 4) !== '\x7fELF') return null;
    return header[5] === 2 ? header.readUInt16BE(18) : header.readUInt16LE(18);
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

const GLIBC_NEEDED = /^(libc\.so\.6|libm\.so\.6|libdl\.so\.2|libpthread\.so\.0|librt\.so\.1|ld-linux\S*)$/;
const perFile = [];
const scannedFiles = new Set();
let scanned = 0;
let foreign = 0;
let staticElf = 0;
for await (const file of walk(root)) {
  const m = elfMachine(file);
  if (m === null) continue;
  const rel = relative(root, file);
  if (m !== machine) {
    foreign += 1;
    continue;
  }
  scanned += 1;
  scannedFiles.add(rel);
  const headers = objdump('-p', file);
  const needed = [...headers.matchAll(/^\s*NEEDED\s+(\S+)/gm)].map((match) => match[1]);
  if (needed.length === 0) {
    // No shared-library dependency at all (static or static-pie): nothing can
    // be imported from glibc.
    staticElf += 1;
    continue;
  }
  const linksGlibc = needed.some((name) => GLIBC_NEEDED.test(name));
  let max = '';
  for (const match of objdump('-T', file).matchAll(/\(GLIBC_(\d+(?:\.\d+)+)\)/g)) {
    if (!max || cmp(match[1], max) > 0) max = match[1];
  }
  if (linksGlibc && !max) die(`${rel} links glibc (${needed.join(', ')}) but no GLIBC_ symbol version was parsed`);
  if (max) perFile.push({ file: rel, max });
}
for (const path of required) {
  if (!scannedFiles.has(path)) die(`required ${path} is not an ELF of arch ${archName} in ${root}`);
}
if (scanned === 0) die(`no ${archName} ELF files under ${root}`);
if (perFile.length === 0) die('no GLIBC symbol versions found in any ELF');
perFile.sort((a, b) => cmp(b.max, a.max));
const floor = perFile[0].max;
console.log(
  `scanned ${scanned} ${archName} ELF files (${staticElf} static, ${foreign} other-arch skipped); ${perFile.length} require GLIBC symbols`
);
for (const { file, max } of perFile.slice(0, 15)) console.log(`GLIBC_${max}  ${file}`);
for (const path of required)
  console.log(`required ok: ${path}  GLIBC_${perFile.find((f) => f.file === path)?.max ?? 'static'}`);
console.log(`GLIBC FLOOR: ${floor}`);
if (maxAllowed && cmp(floor, maxAllowed) > 0) die(`floor ${floor} exceeds allowed ${maxAllowed}`);
