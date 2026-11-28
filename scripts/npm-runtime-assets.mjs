#!/usr/bin/env node
// The native runtime archives of a release and what the npm package carries about them (scripts/npm-platforms.mjs says why):
//   node scripts/npm-runtime-assets.mjs --artifacts <folder> --out <folder> --package <folder> --build-id <id>
//       [--repository <owner/name>] [--tag <tag>]
//     writes <out>/mixdog-runtime-<key>.tar.gz for every platform, from the artifacts of mixdogd-build.yml downloaded side by
//     side (<artifacts>/mixdogd-<target>/{mixdogd,mixdog-askpass} and <artifacts>/mixdog-entry-<target>/mixdog): the three
//     programs and the Office templates the core reads beside mixdogd, as they sit in the runtime folder. Then, into the
//     package folder, bin/runtime-manifest.json, made from the archives as written, and src/cli.mjs, the command an install
//     made by 1.4.5 links to. The tree carries neither: both are written for the pack (the desktop's package, made from the
//     same tree, refuses src/cli.mjs, a path K1 removed).
//   node scripts/npm-runtime-assets.mjs --from <folder> [--from <folder>]... --key <key> --out <folder>
//     the archive of one platform, from folders that hold its built programs.
// The version is the root package.json's (the one Deploy stamps); the build id names the commit the release gate verified.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';

import { OFFICE_TEMPLATES_DIR, OFFICE_TEMPLATES_SOURCE, OFFICE_TEMPLATE_FILES } from '../apps/desktop/scripts/core-layout.mjs';
import { RUNTIME_MANIFEST, manifestProblems } from '../bin/runtime.mjs';
import { NATIVE_PROGRAMS, PLATFORMS, platformOf, programFile, runtimeAssetName } from './npm-platforms.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** The command 1.4.5 linked `mixdog` to, which its staged updater requires of a package before it swaps it in. */
export const LEGACY_ENTRY = 'src/cli.mjs';
export const LEGACY_ENTRY_SOURCE = `#!/usr/bin/env node
// The command of an install that 1.4.5 made: npm linked its \`mixdog\` to this file, and its staged updater accepts only a
// package that has it, swaps it in and starts this file again. A swap never rewrites that link: this file is the launcher.
import { main } from '../bin/mixdog.mjs';

await main();
`;

/** The files of the runtime of `platform`, as paths in the archive and in the runtime folder: the programs, then the templates. */
export const runtimeFiles = (platform) => [
  ...NATIVE_PROGRAMS.map((name) => programFile(name, platform)),
  ...OFFICE_TEMPLATE_FILES.map((name) => `${OFFICE_TEMPLATES_DIR}/${name}`),
];

const octalField = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;

/** The ustar header of an entry, a regular file unless `type` says otherwise (owner 0, time 0: the same files make the same archive). */
export function tarHeader(path, size, mode, type = 0x30) {
  if (Buffer.byteLength(path) > 100) throw new Error(`${path} is longer than a ustar name`);
  const block = Buffer.alloc(512);
  block.write(path, 0, 'utf8');
  block.write(octalField(mode, 8), 100, 'latin1');
  block.write(octalField(0, 8), 108, 'latin1');
  block.write(octalField(0, 8), 116, 'latin1');
  block.write(octalField(size, 12), 124, 'latin1');
  block.write(octalField(0, 12), 136, 'latin1');
  block.fill(0x20, 148, 156);
  block[156] = type;
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

/** Writes the gzip-compressed ustar archive of `entries` ({ path, source, size, mode }) to `file`. */
async function writeTar(entries, file) {
  async function* blocks() {
    for (const { path, source, size, mode } of entries) {
      yield tarHeader(path, size, mode);
      let written = 0;
      for await (const chunk of createReadStream(source)) {
        written += chunk.length;
        yield chunk;
      }
      if (written !== size) throw new Error(`${source} changed while it was archived`);
      if (size % 512 !== 0) yield Buffer.alloc(512 - (size % 512));
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(blocks(), createGzip({ level: 9 }), createWriteStream(file));
}

async function sha256Of(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Writes the archive of platform `key` into `out` from the programs in the `from` folders (each found in one of them) and
 * the templates in `templates`; returns what the manifest says of it. Throws naming a file that is not there.
 */
export async function writeRuntimeArchive({ key, from, out, templates = OFFICE_TEMPLATES_SOURCE }) {
  const { platform } = platformOf(key);
  const programs = new Set(NATIVE_PROGRAMS.map((name) => programFile(name, platform)));
  const entries = runtimeFiles(platform).map((path) => {
    const source = programs.has(path)
      ? from.map((dir) => join(dir, path)).find((candidate) => existsSync(candidate))
      : join(templates, path.slice(OFFICE_TEMPLATES_DIR.length + 1));
    if (!source || !existsSync(source)) throw new Error(`${path} of ${key} is not built (looked in ${programs.has(path) ? from.join(', ') : templates})`);
    return { path, source, size: statSync(source).size, mode: programs.has(path) ? 0o755 : 0o644 };
  });
  mkdirSync(out, { recursive: true });
  const asset = runtimeAssetName(key);
  const file = join(out, asset);
  await writeTar(entries, file);
  return { key, asset, file, length: statSync(file).size, sha256: await sha256Of(file), files: Object.fromEntries(entries.map(({ path, size }) => [path, size])) };
}

/** The runtime manifest of `archives` (what `writeRuntimeArchive` returned), checked as the launcher checks it. */
export function runtimeManifest({ archives, version, buildId, repository, tag }) {
  const manifest = {
    schema: 1,
    repository,
    tag,
    targets: Object.fromEntries(
      archives.map(({ key, asset, length, sha256, files }) => [key, { asset, length, sha256, version, buildId, files }])
    ),
  };
  const problems = manifestProblems(manifest, version);
  if (problems.length > 0) throw new Error(`the runtime manifest is not sound: ${problems.join('; ')}`);
  return manifest;
}

/** Writes what the package carries beyond the tree into `packageDir`: the runtime manifest and the 1.4.5 command. */
export function writePackageFiles(packageDir, manifest) {
  writeFileSync(join(packageDir, 'bin', RUNTIME_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, LEGACY_ENTRY), LEGACY_ENTRY_SOURCE);
}

/** `owner/name` of a package.json `repository` on GitHub. */
export function githubRepository(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url ?? '');
  if (!match) throw new Error(`the repository ${JSON.stringify(url)} is not on GitHub`);
  return match[1];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const all = (name) => args.flatMap((arg, at) => (arg === name && args[at + 1] !== undefined ? [args[at + 1]] : []));
  const one = (name) => all(name)[0];
  const out = one('--out');
  if (one('--artifacts') && out && one('--package') && one('--build-id')) {
    const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const artifacts = resolve(one('--artifacts'));
    const archives = await Promise.all(
      PLATFORMS.map(({ key, target }) =>
        writeRuntimeArchive({ key, from: [join(artifacts, `mixdogd-${target}`), join(artifacts, `mixdog-entry-${target}`)], out: resolve(out) })
      )
    );
    const manifest = runtimeManifest({
      archives,
      version: rootManifest.version,
      buildId: one('--build-id'),
      repository: one('--repository') ?? githubRepository(rootManifest.repository),
      tag: one('--tag') ?? `v${rootManifest.version}`,
    });
    writePackageFiles(resolve(one('--package')), manifest);
    for (const { file, length, sha256 } of archives) process.stdout.write(`${file} ${length} ${sha256}\n`);
  } else if (all('--from').length > 0 && one('--key') && out) {
    const archive = await writeRuntimeArchive({ key: one('--key'), from: all('--from').map((dir) => resolve(dir)), out: resolve(out) });
    process.stdout.write(`${archive.file} ${archive.length} ${archive.sha256}\n`);
  } else {
    process.stderr.write(
      'usage: node scripts/npm-runtime-assets.mjs --artifacts <folder> --out <folder> --package <folder> --build-id <id> [--repository <owner/name>] [--tag <tag>]\n' +
        '       node scripts/npm-runtime-assets.mjs --from <folder> [--from <folder>]... --key <key> --out <folder>\n'
    );
    process.exit(2);
  }
}