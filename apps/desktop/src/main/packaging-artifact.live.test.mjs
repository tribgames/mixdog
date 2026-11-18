// Built-artifact checks: these read electron-vite output (out/), the staged
// platform runtime (.runtime/) and the packaged installer payload (dist/), so
// they run after a build — `verify:packaging-artifact` in desktop-package.yml —
// never in the default discovery lane. Source-shape packaging invariants stay
// in packaging.test.mjs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, open, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { CORE_READS, onnxRuntimeSupported, ortBinaryDir, UNPACKED_NODE_MODULES } from '../../scripts/core-layout.mjs';
import { packagedOutputName } from '../../scripts/packaged-output.mjs';
import { verifyStagedResources } from '../../scripts/verify-staged-package.mjs';
import { artifactFile, artifactPath, withPackagedCore } from './test-support/packaged-runtime.mjs';

const distDir = () => fileURLToPath(new URL('../../dist', import.meta.url));

async function packagedResources() {
  const expected = packagedOutputName(process.platform, process.arch);
  const { MIXDOG_PACKAGED_OUTPUT: name, MIXDOG_PACKAGED_BUILD_STARTED_AT: startedAt } = process.env;
  assert.ok(name && startedAt, 'an explicit package output and pre-build timestamp are required');
  assert.equal(name, expected, 'package lane handed off the wrong Electron Builder output');
  const cutoff = Number(startedAt);
  assert.ok(/^[1-9]\d*$/.test(startedAt) && Number.isSafeInteger(cutoff) && cutoff <= Date.now(), 'invalid package build timestamp');
  assert.ok((await lstat(distDir())).isDirectory(), 'dist must be a real directory');
  const output = join(distDir(), name);
  const info = await lstat(output);
  assert.ok(info.isDirectory(), `${output} is not an unpacked package directory`);
  assert.ok(info.birthtimeMs >= cutoff, `${output} existed before this package build`);
  const resources = process.platform === 'darwin'
    ? join(output, 'Mixdog.app', 'Contents', 'Resources')
    : join(output, 'resources');
  await artifactPath(output, resources);
  assert.ok((await stat(resources)).isDirectory(), `${resources} is not a directory`);
  return resources;
}

/** Every file under `directory`, as paths relative to it. */
async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files.push(relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'));
  }
  return files;
}

async function streamingFileIdentity(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const handle = await open(path, 'r');
  let bytes = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest('hex') };
}

const MACHO_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const LC_SEGMENT_64 = 0x19;

// Developer ID signing rewrites every Mach-O binary's __LINKEDIT segment (it
// holds the code signature) and the load commands that size it, so a signed
// macOS package can never match the staged file byte for byte. The code and
// data segments must still be identical, which is what "emitted unchanged"
// guards. Returns null for non-Mach-O files so callers fall back to bytes.
function machoSliceSegments(data, base, digest) {
  if (data.readUInt32LE(base) !== MACHO_64) return false;
  const commandCount = data.readUInt32LE(base + 16);
  let offset = base + 32;
  for (let index = 0; index < commandCount; index += 1) {
    const command = data.readUInt32LE(offset);
    const size = data.readUInt32LE(offset + 4);
    if (command === LC_SEGMENT_64) {
      const name = data.toString('latin1', offset + 8, offset + 24).replace(/\0+$/, '');
      const fileOffset = Number(data.readBigUInt64LE(offset + 40));
      const fileSize = Number(data.readBigUInt64LE(offset + 48));
      if (name !== '__LINKEDIT' && fileSize > 0) {
        // __TEXT starts with the header and load commands, then free padding.
        // Signing an unsigned (x86_64) binary adds LC_CODE_SIGNATURE into that
        // padding, so compare __TEXT only from its first section's file data.
        let textStart = fileOffset;
        if (name === '__TEXT') {
          const sectionCount = data.readUInt32LE(offset + 64);
          const sectionOffsets = [];
          for (let section = 0; section < sectionCount; section += 1) {
            const sectionOffset = data.readUInt32LE(offset + 72 + section * 80 + 48);
            if (sectionOffset > 0) sectionOffsets.push(sectionOffset);
          }
          textStart = sectionOffsets.length ? Math.min(...sectionOffsets) : fileOffset + fileSize;
        }
        const start = base + textStart;
        digest.update(name);
        digest.update(data.subarray(start, base + fileOffset + fileSize));
      }
    }
    offset += size;
  }
  return true;
}

async function machoContentIdentity(path) {
  const data = await readFile(path);
  if (data.length < 32) return null;
  const digest = createHash('sha256');
  if (data.readUInt32BE(0) === FAT_MAGIC) {
    const architectures = data.readUInt32BE(4);
    for (let index = 0; index < architectures; index += 1) {
      const sliceOffset = data.readUInt32BE(8 + index * 20 + 8);
      if (!machoSliceSegments(data, sliceOffset, digest)) return null;
    }
  } else if (!machoSliceSegments(data, 0, digest)) {
    return null;
  }
  return { segments: digest.digest('hex') };
}

async function emittedFileIdentity(path) {
  if (process.platform === 'darwin') {
    const macho = await machoContentIdentity(path);
    if (macho) return macho;
  }
  return streamingFileIdentity(path);
}

test('electron-vite emitted the preload entry the main process loads', async () => {
  await access(new URL('../../out/preload/index.js', import.meta.url));
});

test('the build staged the core the app starts, with its js-runtime manifest beside it', async () => {
  const core = fileURLToPath(new URL('../../.runtime/core/', import.meta.url));
  await access(join(core, process.platform === 'win32' ? 'mixdogd.exe' : 'mixdogd'));
  await access(join(core, 'js-runtime.json'));
});

async function assertRuntimeEmitted(resources, stagedModules, stagedFiles) {
  // Targets without an onnxruntime-node binding (darwin-x64) ship none at all.
  const onnx = onnxRuntimeSupported(process.platform, process.arch);
  assert.equal(await stat(join(resources, 'runtime.asar')).then(() => true, () => false), false, 'the package ships a runtime.asar nothing opens');
  const builtModules = join(resources, UNPACKED_NODE_MODULES);
  const files = await filesUnder(builtModules);
  for (const required of ['mixdog/package.json', ...CORE_READS.files.map((file) => `mixdog/${file}`)]) {
    assert.ok(files.includes(required), `the built runtime is missing ${required}`);
  }
  assert.equal(
    files.some((entry) => /\.mixdog-edit\.[^/]+$/i.test(entry)),
    false,
    'the built runtime contains an Office authoring copy'
  );
  const binaries = files.filter((entry) => entry.startsWith('onnxruntime-node/bin/napi-v6/'));
  const ownBinaryDir = `onnxruntime-node/${ortBinaryDir(process.platform, process.arch)}/`;
  if (onnx) assert.ok(files.includes(`${ownBinaryDir}onnxruntime_binding.node`), `the built runtime is missing the ${process.platform}-${process.arch} ONNX binding`);
  assert.deepEqual(
    binaries.filter((entry) => !onnx || !entry.startsWith(ownBinaryDir)),
    [],
    'the built runtime contains foreign ONNX platform binaries'
  );
  assert.equal(
    files.some((entry) => /\/onnxruntime-web\/(?:dist|lib)\//.test(entry)),
    false,
    'the built runtime contains unused ONNX web payloads'
  );
  const nativeBinaries = files.filter((entry) => /\.(?:node|dll|dylib|so(?:\.\d+)*)$/i.test(entry));
  assert.ok(nativeBinaries.some((entry) => entry.endsWith('.node')), 'the built runtime contains no native addon');
  // Every staged file reached the package unchanged (a signed macOS binary: same code and data segments).
  const builtSet = new Set(files);
  for (const entry of stagedFiles.filter((file) => /\.(?:node|dll|dylib|so(?:\.\d+)*)$/i.test(file) || file.startsWith('mixdog/src/defaults/skills/'))) {
    assert.ok(builtSet.has(entry), `${entry} is not in the built runtime`);
    assert.deepEqual(
      await emittedFileIdentity(join(builtModules, ...entry.split('/'))),
      await emittedFileIdentity(join(stagedModules, ...entry.split('/'))),
      `${entry} was not emitted unchanged`
    );
  }
}

test('the built runtime is the staged real-file tree: no archive, the closure, the ONNX library of this target, nothing foreign', async () => {
  const resources = await packagedResources();
  const stagedModules = fileURLToPath(new URL('../../.runtime/native-modules/', import.meta.url));
  const stagedFiles = await filesUnder(stagedModules);
  await assertRuntimeEmitted(resources, stagedModules, stagedFiles);
});

test('the packaged resources hold the Rust core, its unpacked resource root, the ONNX library and the extension host closure', async () => {
  const resources = await packagedResources();
  const archive = await artifactFile(resources, join(resources, 'app.asar'));
  assert.ok(extractFile(archive, 'out/preload/index.js').length > 0, 'the package is missing the desktop preload');
  assert.deepEqual(verifyStagedResources({ resources, platform: process.platform, arch: process.arch }).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
  ]);
});

test('the shipped desktop core serves MCP connectors and bundled skills from the package', async (t) => {
  const resources = await packagedResources();
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(typeof version === 'string' && version, 'the selected desktop version is missing');
  const archive = await artifactFile(resources, join(resources, 'app.asar'));
  const packagedDesktop = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(packagedDesktop.version, version, 'the packaged desktop version must match the selected desktop version');
  await withPackagedCore(resources, version, async ({ call, program, source, workspace, copyFixture, runGuardedSkill, launchSkill }) => {
    await t.test(`MCP stdio connector (${relative(distDir(), resources)})`, async () => {
      const name = 'packaged-smoke';
      const fixture = await copyFixture('packaged-mcp-server.mjs');
      const added = await call('mcp/addMcpServer', {
        opId: randomUUID(),
        input: {
          name,
          command: program,
          args: [fixture, program],
          cwd: workspace,
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      });
      const server = added.status.servers.find((row) => row.name === name);
      assert.equal(server?.connected, true, `the packaged MCP server did not connect: ${JSON.stringify(server)}`);
      assert.deepEqual(await call('connector/listConnectorTools', { connectorId: name }), [
        {
          name: 'packaged_echo',
          description: 'Echoes fixture text.',
          readOnly: true,
          annotations: { readOnlyHint: true },
        },
      ]);
    });

    await t.test(`bundled skill and launcher (${relative(distDir(), resources)})`, async () => {
      const name = 'skill-creator';
      const skill = join(source, 'defaults', 'skills', name);
      const packagedBody = await artifactFile(source, join(skill, 'SKILL.md'));
      const validator = await artifactFile(source, join(skill, 'scripts', 'validate-skill.mjs'));
      const status = await call('skills/skillsStatus', { options: { cwd: workspace } });
      const discovered = status.skills.find((row) => row.name === name);
      assert.equal(discovered?.source, 'builtin');
      const content = await call('skills/skillContent', { name });
      assert.equal(content.source, 'builtin');
      for (const filePath of [discovered.filePath, content.filePath]) {
        assert.equal(await artifactFile(source, filePath), packagedBody);
      }
      assert.match(content.content, /scripts\/validate-skill\.mjs/);

      // Calling the validator directly via skill-run can take its native fast
      // path. The driver makes the generated launcher reach the shipped JS entry.
      const driver = await copyFixture('packaged-skill-driver.mjs');
      const forwarded = ['argument with spaces', ''];
      const args = [driver, program, validator, skill, ...forwarded];
      const expected = { skill: name, forwarded };
      assert.deepEqual(JSON.parse(await launchSkill(args)), expected);
      assert.deepEqual(JSON.parse(await runGuardedSkill(args)), expected);
    });
  });
});
