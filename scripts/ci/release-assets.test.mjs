import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  manifestBuild,
  SERVER_PLATFORM_TARGETS,
  serverBundleAsset,
} from '../../apps/desktop/src/main/ssh/server-manifest.mjs';
import { DESKTOP_ASSET_NAMES, SERVER_BUNDLE_ASSET_NAMES, serverBundleRecords, verifyAssets } from './release-assets.mjs';

const hex = (text) => createHash('sha256').update(text).digest('hex');

/** The manifest of a 1.5.0 server set, as every installer of it carries. */
function manifest() {
  const binaries = Object.fromEntries(
    Object.entries(SERVER_PLATFORM_TARGETS).map(([key, target], at) => [
      key,
      {
        target,
        sha256: hex(`mixdogd ${key}`),
        size: 10 + at,
        bundle: { asset: serverBundleAsset(key), sha256: hex(`bundle ${key}`), size: 100 + at, content: hex(`content ${key}`) },
      },
    ])
  );
  return { version: '1.5.0', build: manifestBuild(binaries), binaries };
}

test('a completed draft asset with the same name and size must still match the verified bytes', () => {
  const expected = [{ name: 'package.zip', size: 27, digest: `sha256:${'a'.repeat(64)}` }];
  const uploaded = { ...expected[0], state: 'uploaded' };
  verifyAssets([uploaded], expected, ['package.zip']);
  assert.throws(
    () => verifyAssets([{ ...uploaded, digest: `sha256:${'b'.repeat(64)}` }], expected, ['package.zip']),
    /differs from the verified bytes/
  );
});

test('the release is published only with every server bundle on the draft as the bytes the manifest lists', () => {
  const carried = manifest();
  const records = serverBundleRecords(carried, '1.5.0');
  assert.deepEqual(
    records.map(({ name }) => name).sort(),
    ['mixdog-server-darwin-arm64.tgz', 'mixdog-server-darwin-x64.tgz', 'mixdog-server-linux-arm64.tgz', 'mixdog-server-linux-x64.tgz']
  );
  const linux = records.find(({ name }) => name === 'mixdog-server-linux-x64.tgz');
  assert.deepEqual(linux, {
    name: 'mixdog-server-linux-x64.tgz',
    size: carried.binaries['linux-x64'].bundle.size,
    digest: `sha256:${hex('bundle linux-x64')}`,
  });
  // The asset set publish checks names all four.
  for (const name of records.map((record) => record.name)) assert.ok(DESKTOP_ASSET_NAMES.includes(name), name);

  const draft = records.map((record) => ({ ...record, state: 'uploaded' }));
  verifyAssets(draft, records, SERVER_BUNDLE_ASSET_NAMES);
  assert.throws(
    () => verifyAssets(draft.slice(1), records, SERVER_BUNDLE_ASSET_NAMES),
    /must both cover the exact release asset set/,
    'a bundle missing from the draft'
  );
  const otherBytes = draft.map((asset) =>
    asset.name === 'mixdog-server-linux-x64.tgz' ? { ...asset, digest: `sha256:${hex('rebuilt')}` } : asset
  );
  assert.throws(
    () => verifyAssets(otherBytes, records, SERVER_BUNDLE_ASSET_NAMES),
    /mixdog-server-linux-x64\.tgz/,
    'a bundle of other bytes'
  );
});

// GitHub as `gh` answers this script, from a state file: the release, its assets and every command run. curl, which uploads,
// always fails: nothing may be uploaded to a public release.
const FAKE_GITHUB = `
import { readFileSync, writeFileSync } from 'node:fs';
const load = () => JSON.parse(readFileSync(process.env.FAKE_GITHUB_STATE, 'utf8'));
const save = (state) => writeFileSync(process.env.FAKE_GITHUB_STATE, JSON.stringify(state));
export function execFileSync(command, args) {
  const state = load();
  state.calls.push([command, ...args].join(' '));
  save(state);
  const [, path] = args;
  const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
  const release = 'repos/' + state.repo + '/releases/' + state.release.id;
  if (method === 'GET' && path === release) return JSON.stringify(state.release);
  if (method === 'GET' && path === release + '/assets?per_page=100') return JSON.stringify([state.assets]);
  const asset = /^repos\\/[^/]+\\/[^/]+\\/releases\\/assets\\/(\\d+)$/.exec(path);
  if (method === 'GET' && asset) return state.assets.find(({ id }) => String(id) === asset[1]).content;
  if (method === 'PATCH' && path === release) {
    state.release.draft = false;
    save(state);
    return JSON.stringify(state.release);
  }
  throw new Error('unexpected gh ' + args.join(' '));
}
export function execFile(command, args, callback) {
  const state = load();
  state.calls.push([command, ...args].join(' '));
  save(state);
  callback(new Error(command + ' must not run'));
}
`;

/** Runs release-assets.mjs `args` against a fake GitHub holding `release` and `assets`; the outcome, the calls and the state. */
function againstGithub(dir, { release, assets, env }, args) {
  const fake = join(dir, 'fake-github.mjs');
  const hooks = join(dir, 'hooks.mjs');
  const register = join(dir, 'register.mjs');
  const state = join(dir, 'state.json');
  writeFileSync(fake, FAKE_GITHUB);
  writeFileSync(
    hooks,
    `export async function resolve(specifier, context, next) {
      if (specifier === 'node:child_process' && context.parentURL?.endsWith('/scripts/ci/release-assets.mjs'))
        return { url: ${JSON.stringify(pathToFileURL(fake).href)}, shortCircuit: true };
      return next(specifier, context);
    }\n`
  );
  writeFileSync(register, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
  writeFileSync(state, JSON.stringify({ repo: 'o/r', release, assets, calls: [] }));
  const output = join(dir, 'output');
  writeFileSync(output, '');
  const script = fileURLToPath(new URL('./release-assets.mjs', import.meta.url));
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(register).href, script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, FAKE_GITHUB_STATE: state, GITHUB_OUTPUT: output },
  });
  return { ...run, output: readFileSync(output, 'utf8'), ...JSON.parse(readFileSync(state, 'utf8')) };
}

test('a re-run after the release went public goes on where it holds exactly the run\'s assets, and changes nothing on it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-assets-rerun-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ref = 'a'.repeat(40);
  const carried = manifest();
  const bundles = serverBundleRecords(carried, '1.5.0');
  const local = DESKTOP_ASSET_NAMES.filter((name) => !SERVER_BUNDLE_ASSET_NAMES.includes(name));
  const records = local.map((name) => {
    writeFileSync(join(dir, name), `bytes of ${name}`);
    return { name, size: Buffer.byteLength(`bytes of ${name}`), digest: `sha256:${hex(`bytes of ${name}`)}` };
  });
  const feed = 'files:\n  - url: mixdog-desktop-linux-x86_64.AppImage\n  - url: mixdog-desktop-linux-amd64.deb\npath: mixdog-desktop-linux-x86_64.AppImage\n';
  const assets = [...records, ...bundles].map((record, id) => ({
    ...record,
    id,
    state: 'uploaded',
    ...(record.name.startsWith('latest-linux') ? { content: feed } : {}),
  }));
  const release = { id: 42, tag_name: 'v1.5.0', target_commitish: ref, draft: false, prerelease: false, upload_url: 'https://uploads.github.com/repos/o/r/releases/42/assets{?name,label}' };
  const env = {
    GH_TOKEN: 'token',
    GITHUB_REPOSITORY: 'o/r',
    RELEASE_TAG: 'v1.5.0',
    RELEASE_REF: ref,
    RELEASE_ID: '42',
    SERVER_BUNDLES_MANIFEST: JSON.stringify(carried),
    WINDOWS_ASSETS: JSON.stringify(records),
    ...Object.fromEntries(
      ['MAC_ARM64_ASSETS', 'MAC_X64_ASSETS', 'LINUX_ARM64_ASSETS', 'LINUX_X64_ASSETS', 'MERGED_FEED', 'NPM_RUNTIME_ASSETS'].map((key) => [key, '[]'])
    ),
  };
  const runtimes = local.filter((name) => name.startsWith('mixdog-runtime-'));
  writeFileSync(join(dir, 'notes.md'), 'notes');
  const published = { release, assets, env };

  const upload = againstGithub(dir, published, ['upload', ...runtimes.map((name) => join(dir, name))]);
  assert.equal(upload.status, 0, upload.stderr);
  assert.deepEqual(JSON.parse(upload.output.replace(/^assets=/, '')), records.filter(({ name }) => runtimes.includes(name)));
  for (const command of [['verify-desktop'], ['publish-desktop', join(dir, 'notes.md')]]) {
    const run = againstGithub(dir, published, command);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.release.draft === false && run.calls.every((call) => call.startsWith('gh api ') && !call.includes('--method')), run.calls.join('\n'));
  }

  // Bytes the run did not make are never put on it, nor accepted from it.
  const rebuilt = { ...published, assets: assets.map((asset) => (asset.name === runtimes[0] ? { ...asset, digest: `sha256:${hex('rebuilt')}` } : asset)) };
  const refused = againstGithub(dir, rebuilt, ['upload', join(dir, runtimes[0])]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp(`v1\\.5\\.0 is public without ${runtimes[0].replaceAll('.', '\\.')} as these bytes, and a public release is never changed`));
  assert.ok(refused.calls.every((call) => !call.startsWith('curl')), 'nothing was uploaded');
  assert.match(againstGithub(dir, rebuilt, ['verify-desktop']).stderr, /differs from the verified bytes/);
  const extra = { ...published, assets: [...assets, { id: 99, name: 'stray.zip', state: 'uploaded', size: 1, digest: `sha256:${hex('stray')}` }] };
  assert.match(againstGithub(dir, extra, ['publish-desktop', join(dir, 'notes.md')]).stderr, /must both cover the exact release asset set/);
  const elsewhere = { ...published, release: { ...release, target_commitish: 'b'.repeat(40) } };
  assert.match(againstGithub(dir, elsewhere, ['verify-desktop']).stderr, /is not the expected release of v1\.5\.0/);

  // The first attempt publishes the draft.
  const draft = againstGithub(dir, { ...published, release: { ...release, draft: true } }, ['publish-desktop', join(dir, 'notes.md')]);
  assert.equal(draft.status, 0, draft.stderr);
  assert.equal(draft.release.draft, false);
  assert.ok(draft.calls.some((call) => call.includes('--method PATCH')));
});

test("no draft is published against a manifest that is missing, of another release or not a release's", () => {
  assert.throws(() => serverBundleRecords(null, '1.5.0'), /not one of release 1\.5\.0/);
  assert.throws(() => serverBundleRecords(manifest(), '1.5.1'), /it is version 1\.5\.0, the release is 1\.5\.1/);
  const short = manifest();
  delete short.binaries['darwin-x64'];
  short.build = manifestBuild(short.binaries);
  assert.throws(() => serverBundleRecords(short, '1.5.0'), /it lists darwin-arm64, linux-arm64, linux-x64, not/);
});
