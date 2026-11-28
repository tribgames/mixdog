// The native runtime of the npm package: the archives the release writes (scripts/npm-runtime-assets.mjs), their manifest,
// and what the package does with them (bin/runtime.mjs, bin/mixdog-runtime.mjs): verify, extract, import, prefetch, postinstall.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { OFFICE_TEMPLATES_DIR, OFFICE_TEMPLATES_SOURCE, OFFICE_TEMPLATE_FILES } from '../apps/desktop/scripts/core-layout.mjs';
import { isStagedInstall, ownsLocation, runCli } from '../bin/mixdog-runtime.mjs';
import {
  READY_FILE,
  assetUrl,
  extractArchive,
  importRuntime,
  installArchive,
  manifestProblems,
  readyRuntime,
  runtimeCacheRoot,
  runtimeFolder,
  selectTarget,
} from '../bin/runtime.mjs';
import { PLATFORMS } from './npm-platforms.mjs';
import { LEGACY_ENTRY, runtimeManifest, tarHeader, writeRuntimeArchive } from './npm-runtime-assets.mjs';
import { writePackage } from './npm-test-fixture.mjs';

const VERSION = '7.8.9';
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-runtime-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Built programs of `platform` in `dir`: small files that name themselves. */
function programs(dir, platform) {
  const folder = join(dir, `built-${platform}`);
  mkdirSync(folder, { recursive: true });
  const suffix = platform === 'win32' ? '.exe' : '';
  for (const name of ['mixdog', 'mixdogd', 'mixdog-askpass']) writeFileSync(join(folder, `${name}${suffix}`), `${name} of ${platform}`);
  return folder;
}

/** The archives of linux-x64 and win32-x64 and the manifest the release writes of them. */
async function release(dir) {
  const archives = [];
  for (const key of ['linux-x64', 'win32-x64']) {
    const platform = key.split('-')[0];
    archives.push(await writeRuntimeArchive({ key, from: [programs(dir, platform)], out: join(dir, 'assets') }));
  }
  const manifest = runtimeManifest({ archives, version: VERSION, buildId: 'abc123', repository: 'tribgames/mixdog', tag: `v${VERSION}` });
  return { archives, manifest, file: (key) => archives.find((archive) => archive.key === key).file };
}

/** A gzip-compressed ustar archive of `entries` ({ path, data, type }), with its end blocks unless `end` is false. */
function craft(file, entries, { end = true, after = Buffer.alloc(0) } = {}) {
  const blocks = [];
  for (const { path, data = Buffer.alloc(0), type = 0x30 } of entries) {
    blocks.push(tarHeader(path, data.length, 0o644, type), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (end) blocks.push(Buffer.alloc(1024));
  writeFileSync(file, gzipSync(Buffer.concat([...blocks, after])));
  return file;
}

test('the archive the release writes holds the programs and the templates, and installs as the runtime the manifest names', async (t) => {
  const dir = scratch(t);
  const { manifest, file } = await release(dir);
  assert.deepEqual(manifestProblems(manifest, VERSION), []);
  const entry = manifest.targets['linux-x64'];
  assert.equal(entry.asset, 'mixdog-runtime-linux-x64.tar.gz');
  assert.equal(entry.length, statSync(file('linux-x64')).size);
  assert.equal(entry.version, VERSION);
  assert.equal(entry.buildId, 'abc123');
  assert.deepEqual(Object.keys(entry.files), [
    'mixdog',
    'mixdogd',
    'mixdog-askpass',
    ...OFFICE_TEMPLATE_FILES.map((name) => `${OFFICE_TEMPLATES_DIR}/${name}`),
  ]);
  assert.ok(Object.keys(manifest.targets['win32-x64'].files).includes('mixdogd.exe'));
  assert.equal(assetUrl(manifest, entry), `https://github.com/tribgames/mixdog/releases/download/v${VERSION}/mixdog-runtime-linux-x64.tar.gz`);
  const cacheRoot = runtimeCacheRoot(join(dir, 'data'));
  const folder = await installArchive({ archive: file('linux-x64'), cacheRoot, key: 'linux-x64', entry });
  assert.equal(folder, join(cacheRoot, VERSION, `linux-x64-${entry.sha256}`));
  assert.equal(readyRuntime({ cacheRoot, key: 'linux-x64', entry }), folder);
  assert.equal(readFileSync(join(folder, 'mixdogd'), 'utf8'), 'mixdogd of linux');
  for (const name of OFFICE_TEMPLATE_FILES)
    assert.deepEqual(readFileSync(join(folder, OFFICE_TEMPLATES_DIR, name)), readFileSync(join(OFFICE_TEMPLATES_SOURCE, name)));
  if (process.platform !== 'win32') assert.ok(statSync(join(folder, 'mixdog-askpass')).mode & 0o100, 'the programs are executable');
  // Only the runtime folder is left in the cache: no download or extraction beside it.
  assert.deepEqual(readdirSync(join(cacheRoot, VERSION)), [`linux-x64-${entry.sha256}`]);
  // Installing again keeps the runtime that is there.
  assert.equal(await installArchive({ archive: file('linux-x64'), cacheRoot, key: 'linux-x64', entry }), folder);
});

test('an archive whose bytes are not the manifest\'s is refused before anything is extracted', async (t) => {
  const dir = scratch(t);
  const { manifest, file } = await release(dir);
  const entry = manifest.targets['linux-x64'];
  const cacheRoot = runtimeCacheRoot(join(dir, 'data'));
  const other = { ...entry, sha256: 'f'.repeat(64) };
  await assert.rejects(installArchive({ archive: file('linux-x64'), cacheRoot, key: 'linux-x64', entry: other }), /its SHA-256 is [0-9a-f]{64}, the release's is f{64}/);
  await assert.rejects(installArchive({ archive: file('linux-x64'), cacheRoot, key: 'linux-x64', entry: { ...entry, length: entry.length + 1 } }), /bytes, not the/);
  assert.equal(existsSync(join(cacheRoot, VERSION)), false, 'nothing was written into the cache');
});

test('an incomplete runtime a running mixdog holds is left whole and named; once free, it is replaced', async (t) => {
  const dir = scratch(t);
  const { manifest, file } = await release(dir);
  const entry = manifest.targets['linux-x64'];
  const cacheRoot = runtimeCacheRoot(join(dir, 'data'));
  const folder = await installArchive({ archive: file('linux-x64'), cacheRoot, key: 'linux-x64', entry });
  writeFileSync(join(folder, 'mixdog-askpass'), 'damaged');
  const before = readdirSync(folder).sort();
  // Windows refuses to move a folder that a running program was started from.
  const held = (from, to) => {
    if (from === folder) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: 'EBUSY' });
    renameSync(from, to);
  };
  const install = (rename) => installArchive({ archive: file('linux-x64'), cacheRoot, key: 'linux-x64', entry, rename });
  await assert.rejects(install(held), /cannot replace the incomplete runtime at .+, which a running mixdog may hold: EBUSY/);
  assert.deepEqual(readdirSync(folder).sort(), before);
  assert.equal(readFileSync(join(folder, 'mixdog-askpass'), 'utf8'), 'damaged');
  assert.deepEqual(readdirSync(join(cacheRoot, VERSION)), [basename(folder)]);
  assert.equal(await install(renameSync), folder);
  assert.equal(readFileSync(join(folder, 'mixdog-askpass'), 'utf8'), 'mixdog-askpass of linux');
  assert.equal(readyRuntime({ cacheRoot, key: 'linux-x64', entry }), folder);
  assert.deepEqual(readdirSync(join(cacheRoot, VERSION)), [basename(folder)]);
});

test('a runtime another process puts in place during the install is the one kept, never removed', async (t) => {
  const dir = scratch(t);
  const { manifest, file } = await release(dir);
  const entry = manifest.targets['linux-x64'];
  const cacheRoot = runtimeCacheRoot(join(dir, 'data'));
  const theirs = await installArchive({ archive: file('linux-x64'), cacheRoot: runtimeCacheRoot(join(dir, 'other')), key: 'linux-x64', entry });
  writeFileSync(join(theirs, 'started-from-here'), '');
  const folder = runtimeFolder(cacheRoot, 'linux-x64', entry);
  let raced = false;
  const race = (from, to) => {
    if (to === folder && !raced) {
      raced = true;
      renameSync(theirs, folder);
    }
    renameSync(from, to);
  };
  assert.equal(await installArchive({ archive: file('linux-x64'), cacheRoot, key: 'linux-x64', entry, rename: race }), folder);
  assert.ok(raced);
  assert.ok(existsSync(join(folder, 'started-from-here')), 'the runtime the other process put there stays');
  assert.deepEqual(readdirSync(join(cacheRoot, VERSION)), [basename(folder)]);
});

test('extraction takes exactly the listed regular files, each once at its size, and nothing else', async (t) => {
  const dir = scratch(t);
  const files = { mixdog: 2, 'assets/templates/a.pptx': 1 };
  const good = [
    { path: 'mixdog', data: Buffer.from('hi') },
    { path: 'assets/templates/a.pptx', data: Buffer.from('a') },
  ];
  const cases = {
    'an entry the runtime does not list': [[...good, { path: 'extra', data: Buffer.from('x') }], {}, /holds extra, which the runtime does not/],
    'a path out of the folder': [[{ path: '../escape', data: Buffer.from('x') }, ...good], {}, /holds \.\.\/escape, which the runtime does not/],
    'a symbolic link': [[...good, { path: 'mixdogd', type: 0x32 }], {}, /holds mixdogd, which is not a regular file/],
    'a folder entry': [[{ path: 'assets/', type: 0x35 }, ...good], {}, /holds assets\/, which is not a regular file/],
    'a file twice': [[...good, good[0]], {}, /holds mixdog twice/],
    'a file of another size': [[{ path: 'mixdog', data: Buffer.from('hey') }, good[1]], {}, /holds mixdog of 3 bytes, not 2/],
    'a listed file missing': [[good[0]], {}, /lacks assets\/templates\/a\.pptx/],
    'no end': [good, { end: false }, /ends before its end/],
    'an entry after the end': [good, { after: tarHeader('late', 0, 0o644) }, /an entry after its end/],
  };
  for (const [what, [entries, options, error]] of Object.entries(cases)) {
    const target = join(dir, what.replace(/\W+/g, '-'));
    mkdirSync(target);
    await assert.rejects(extractArchive(craft(`${target}.tgz`, entries, options), target, files, 'linux'), error, what);
    assert.equal(existsSync(join(dir, 'escape')), false, what);
  }
  const target = join(dir, 'good');
  mkdirSync(target);
  await extractArchive(craft(join(dir, 'good.tgz'), good), target, files, 'linux');
  assert.equal(readFileSync(join(target, 'mixdog'), 'utf8'), 'hi');
});

test('Windows on Arm runs the x64 runtime; no other machine takes another\'s', async (t) => {
  const { manifest } = await release(scratch(t));
  assert.equal(selectTarget(manifest, 'win32', 'arm64').key, 'win32-x64');
  assert.equal(selectTarget(manifest, 'win32', 'x64').key, 'win32-x64');
  assert.equal(selectTarget(manifest, 'linux', 'arm64'), undefined);
  assert.equal(selectTarget(manifest, 'freebsd', 'x64'), undefined);
  assert.deepEqual(
    PLATFORMS.map(({ key }) => key).sort(),
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'],
    'the five targets the release builds'
  );
});

test('a manifest of another version, without a program or with a path out of its folder is not the package\'s', async (t) => {
  const { manifest } = await release(scratch(t));
  assert.match(manifestProblems(manifest, '7.8.10').join('\n'), /the version "7\.8\.9" is not the package's 7\.8\.10/);
  const entry = manifest.targets['linux-x64'];
  const { mixdogd: _core, ...withoutCore } = entry.files;
  const without = { ...manifest, targets: { 'linux-x64': { ...entry, files: withoutCore } } };
  assert.match(manifestProblems(without, VERSION).join('\n'), /linux-x64: it lists no mixdogd/);
  const escaping = { ...manifest, targets: { 'linux-x64': { ...entry, files: { ...entry.files, '../x': 1 } } } };
  assert.match(manifestProblems(escaping, VERSION).join('\n'), /"\.\.\/x" is not a relative path/);
  assert.match(manifestProblems({ ...manifest, targets: { 'linux-x64': { ...entry, sha256: 'xyz' } } }, VERSION).join('\n'), /is not a SHA-256/);
});

test('import recognizes the archive of this machine by its bytes, whatever its name, and refuses another', async (t) => {
  const dir = scratch(t);
  const { manifest, file } = await release(dir);
  const cacheRoot = runtimeCacheRoot(join(dir, 'data'));
  const renamed = join(dir, 'downloaded.bin');
  copyFileSync(file('win32-x64'), renamed);
  const folder = await importRuntime({ file: renamed, manifest, cacheRoot, platform: 'win32', arch: 'arm64' });
  assert.equal(folder, runtimeFolder(cacheRoot, 'win32-x64', manifest.targets['win32-x64']));
  assert.ok(existsSync(join(folder, READY_FILE)));
  await assert.rejects(
    importRuntime({ file: file('linux-x64'), manifest, cacheRoot, platform: 'win32', arch: 'x64' }),
    /mixdog-runtime-win32-x64\.tar\.gz of mixdog 7\.8\.9/
  );
  await assert.rejects(importRuntime({ file: renamed, manifest, cacheRoot, platform: 'linux', arch: 'arm64' }), /no runtime for linux-arm64/);
});

/** Output streams that keep what is written. */
const streams = () => {
  const out = { text: '', write: (chunk) => (out.text += chunk) };
  const err = { text: '', write: (chunk) => (err.text += chunk) };
  return { stdout: out, stderr: err };
};

/** A fetch of the release that copies the archives of `dir`, keeping the URLs asked for. */
const fromAssets = (archives, asked = []) => async ({ url, file, length }) => {
  asked.push(url);
  const archive = archives.find((candidate) => url.endsWith(`/${candidate.asset}`));
  copyFileSync(archive.file, file);
  assert.equal(statSync(file).size, length);
};
const unreachable = async () => {
  throw new Error('getaddrinfo ENOTFOUND github.com');
};

test('prefetch installs the runtime of this machine from the release once, and status then says it is installed', async (t) => {
  const dir = scratch(t);
  const { archives, manifest } = await release(dir);
  const packageRoot = writePackage(join(dir, 'node_modules', 'mixdog'), { version: VERSION, manifest });
  const data = join(dir, 'data');
  const asked = [];
  const options = { packageRoot, data, env: {}, platform: 'linux', arch: 'x64', fetchArchive: fromAssets(archives, asked) };
  assert.equal(await runCli(['status'], { ...options, ...streams() }), 1, 'not installed yet');
  const io = streams();
  assert.equal(await runCli(['prefetch'], { ...options, ...io }), 0, io.stderr.text);
  assert.deepEqual(asked, [assetUrl(manifest, manifest.targets['linux-x64'])]);
  assert.match(io.stderr.text, /fetching the native runtime of mixdog 7\.8\.9 for linux-x64/);
  assert.equal(await runCli(['prefetch'], { ...options, ...streams() }), 0);
  assert.equal(asked.length, 1, 'a ready runtime is not fetched again');
  const status = streams();
  assert.equal(await runCli(['status'], { ...options, ...status }), 0);
  assert.match(status.stdout.text, /\(installed\)/);
});

test('prefetch --out saves verified archives of any target for a machine without the network, and keeps no wrong bytes', async (t) => {
  const dir = scratch(t);
  const { archives, manifest } = await release(dir);
  const packageRoot = writePackage(join(dir, 'pkg'), { version: VERSION, manifest });
  const out = join(dir, 'carry');
  const options = { packageRoot, data: join(dir, 'data'), env: {}, platform: 'darwin', arch: 'arm64' };
  const io = streams();
  assert.equal(await runCli(['prefetch', '--out', out, '--target', 'win32-x64'], { ...options, ...io, fetchArchive: fromAssets(archives) }), 0, io.stderr.text);
  assert.deepEqual(readdirSync(out), ['mixdog-runtime-win32-x64.tar.gz']);
  assert.deepEqual(readFileSync(join(out, 'mixdog-runtime-win32-x64.tar.gz')), readFileSync(archives[1].file));
  const corrupt = async ({ file }) => writeFileSync(file, Buffer.alloc(archives[0].length));
  const bad = streams();
  assert.equal(await runCli(['prefetch', '--out', out, '--target', 'linux-x64'], { ...options, ...bad, fetchArchive: corrupt }), 1);
  assert.match(bad.stderr.text, /is not mixdog-runtime-linux-x64\.tar\.gz of mixdog 7\.8\.9/);
  assert.deepEqual(readdirSync(out), ['mixdog-runtime-win32-x64.tar.gz'], 'the wrong download is gone');
  const unknown = streams();
  assert.equal(await runCli(['prefetch', '--out', out, '--target', 'darwin-arm64'], { ...options, ...unknown }), 1);
  assert.match(unknown.stderr.text, /has no runtime for darwin-arm64 \(it has linux-x64, win32-x64\)/);
});

test('the postinstall of a user install never fails it: offline it names the exact asset and the import command', async (t) => {
  const dir = scratch(t);
  const { manifest } = await release(dir);
  const packageRoot = writePackage(join(dir, 'global', 'node_modules', 'mixdog'), { version: VERSION, manifest });
  const data = join(dir, 'data');
  const io = streams();
  const code = await runCli(['postinstall'], { packageRoot, data, env: {}, platform: 'linux', arch: 'x64', fetchArchive: unreachable, ...io });
  assert.equal(code, 0);
  const entry = manifest.targets['linux-x64'];
  assert.match(io.stderr.text, /the native runtime of mixdog 7\.8\.9 for linux-x64 is not installed, and fetching it failed: getaddrinfo ENOTFOUND github\.com/);
  assert.ok(io.stderr.text.includes(`mixdog-runtime-linux-x64.tar.gz (${entry.length} bytes, SHA-256 ${entry.sha256})`));
  assert.ok(io.stderr.text.includes(assetUrl(manifest, entry)));
  assert.match(io.stderr.text, /mixdog-runtime import <path to mixdog-runtime-linux-x64\.tar\.gz>/);
  assert.ok(io.stderr.text.includes(`node "${join(packageRoot, 'bin', 'mixdog-runtime.mjs')}" import`));
  assert.match(io.stderr.text, /the install goes on/);
  assert.equal(existsSync(join(runtimeCacheRoot(data), VERSION)) && readdirSync(join(runtimeCacheRoot(data), VERSION)).length > 0, false, 'nothing is left');
  // A source checkout has no manifest: nothing is fetched, nothing is said.
  const checkout = join(dir, 'checkout');
  mkdirSync(join(checkout, 'bin'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'mixdog', version: VERSION }));
  const quiet = streams();
  assert.equal(await runCli(['postinstall'], { packageRoot: checkout, data, env: {}, fetchArchive: () => assert.fail('no fetch'), ...quiet }), 0);
  assert.equal(quiet.stderr.text, '');
});

test('the postinstall of a staged update fails the update when its runtime is not ready, so the working version stays', async (t) => {
  const dir = scratch(t);
  const { archives, manifest } = await release(dir);
  const data = join(dir, 'data');
  const packageRoot = writePackage(join(data, 'staging', VERSION, 'install', 'node_modules', 'mixdog'), { version: VERSION, manifest });
  const env = { MIXDOG_DATA_DIR: data };
  assert.equal(isStagedInstall(packageRoot, env), true);
  assert.equal(isStagedInstall(packageRoot, { MIXDOG_DATA_DIR: join(dir, 'other') }), false);
  const io = streams();
  assert.equal(await runCli(['postinstall'], { packageRoot, env, platform: 'linux', arch: 'x64', fetchArchive: unreachable, ...io }), 1);
  assert.match(io.stderr.text, /this staged update is incomplete; the installed version keeps running/);
  assert.equal(await runCli(['postinstall'], { packageRoot, env, platform: 'linux', arch: 'x64', fetchArchive: fromAssets(archives), ...streams() }), 0);
  assert.ok(readyRuntime({ cacheRoot: runtimeCacheRoot(data), key: 'linux-x64', entry: manifest.targets['linux-x64'] }));
});

test('the postinstall of the core updater\'s staged install leaves the runtime to the updater: npm\'s proxy route need not reach GitHub', async (t) => {
  const dir = scratch(t);
  const { manifest } = await release(dir);
  const data = join(dir, 'data');
  const packageRoot = writePackage(join(data, 'staging', VERSION, 'install', 'node_modules', 'mixdog'), { version: VERSION, manifest });
  const env = { MIXDOG_DATA_DIR: data, MIXDOG_RUNTIME_PROVISION: 'updater' };
  const io = streams();
  assert.equal(await runCli(['postinstall'], { packageRoot, env, platform: 'linux', arch: 'x64', fetchArchive: unreachable, ...io }), 0);
  assert.equal(io.stderr.text, '');
});

test('the runtime is fetched only into a cache of the user who runs mixdog, never as root for another user', (t) => {
  const dir = scratch(t);
  const owner = statSync(dir).uid;
  const below = join(dir, 'not', 'there', 'yet');
  assert.equal(ownsLocation(below, { platform: 'linux', uid: owner, env: {} }), true, 'the nearest folder that exists is this user\'s');
  assert.equal(ownsLocation(below, { platform: 'linux', uid: owner + 1, env: {} }), false);
  assert.equal(ownsLocation(below, { platform: 'linux', uid: 0, env: { SUDO_UID: '1000' } }), false, 'sudo installing for its user');
  assert.equal(ownsLocation(below, { platform: 'win32', env: {} }), true);
});

test('the command an install made by 1.4.5 links to is written into the package beside the manifest', (t) => {
  const dir = scratch(t);
  const packageRoot = writePackage(join(dir, 'pkg'), { version: VERSION, targets: {} });
  assert.match(readFileSync(join(packageRoot, LEGACY_ENTRY), 'utf8'), /import \{ main \} from '\.\.\/bin\/mixdog\.mjs';\n\nawait main\(\);/);
  assert.ok(existsSync(join(packageRoot, 'bin', 'runtime-manifest.json')));
});