// Consolidated release gate: asset manifests, deploy workflow contract,
// and version discipline. Referenced by deploy.yml and test:release-assets.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GRAPH_PLATFORMS,
  PATCH_PLATFORMS,
  validateGraphManifest,
  validatePatchManifest,
  validateRuntimeManifest,
  verifyAssetDownloads,
  verifyReleaseAssets,
} from './verify-release-assets.mjs';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ==== from verify-release-assets-test.mjs ====
const VERSION = '1.2.3';
const APP_VERSION = '0.9.49';
const GRAPH_VERSION = '0.1.0';
const bytes = Buffer.from('local release fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');

function patchFixture() {
  return {
    version: VERSION,
    _comment: 'test fixture',
    assets: Object.fromEntries(Object.entries(PATCH_PLATFORMS).map(([platform, filename]) => [
      platform,
      {
        url: `https://github.com/tribgames/mixdog/releases/download/patch-v${VERSION}/${filename}`,
        sha256,
      },
    ])),
  };
}

function runtimeFixture() {
  return {
    release_tag: 'runtime-v1.2.3',
    assets: Object.fromEntries(Object.keys(PATCH_PLATFORMS).map((platform) => [
      platform,
      { url: `https://fixtures.invalid/${platform}`, sha256, size: bytes.length },
    ])),
  };
}

function graphFixture() {
  return {
    version: GRAPH_VERSION,
    _comment: 'test fixture',
    assets: Object.fromEntries(Object.entries(GRAPH_PLATFORMS).map(([platform, filename]) => [
      platform,
      {
        url: `https://github.com/tribgames/mixdog/releases/download/graph-v${GRAPH_VERSION}/${filename}`,
        sha256,
      },
    ])),
  };
}

test('accepts independent strict patch, runtime, app, and graph versions', () => {
  assert.equal(validatePatchManifest(patchFixture(), `[package]\nversion = "${VERSION}"\n`).version, VERSION);
  assert.equal(validateRuntimeManifest(runtimeFixture()).release_tag, 'runtime-v1.2.3');
  assert.equal(validateGraphManifest(graphFixture(), { version: APP_VERSION }).version, GRAPH_VERSION);
});

test('rejects stale Cargo version, partial schema, and wrong patch tag URL', () => {
  assert.throws(
    () => validatePatchManifest(patchFixture(), '[package]\nversion = "1.2.2"\n'),
    /does not match manifest version/,
  );

  const partial = patchFixture();
  delete partial.assets['linux-arm64'];
  assert.throws(
    () => validatePatchManifest(partial, `[package]\nversion = "${VERSION}"\n`),
    /keys must be exactly/,
  );

  const wrongTag = patchFixture();
  wrongTag.assets['linux-x64'].url = wrongTag.assets['linux-x64'].url.replace('patch-v1.2.3', 'patch-v1.2.2');
  assert.throws(
    () => validatePatchManifest(wrongTag, `[package]\nversion = "${VERSION}"\n`),
    /patch-v1\.2\.3/,
  );

  const extraPatch = patchFixture();
  extraPatch.assets['freebsd-x64'] = extraPatch.assets['linux-x64'];
  assert.throws(
    () => validatePatchManifest(extraPatch, `[package]\nversion = "${VERSION}"\n`),
    /keys must be exactly/,
  );

  const extraRuntime = runtimeFixture();
  extraRuntime.assets['freebsd-x64'] = extraRuntime.assets['linux-x64'];
  assert.throws(() => validateRuntimeManifest(extraRuntime), /keys must be exactly/);
});

test('rejects stale, noncanonical, partial, and malformed graph manifests', () => {
  const partial = graphFixture();
  delete partial.assets['darwin-arm64'];
  assert.throws(() => validateGraphManifest(partial, { version: APP_VERSION }), /keys must be exactly/);

  for (const replacement of [
    'https://github.com/tribgames/mixdog/releases/download/v0.7.18/mixdog-graph-linux-x64',
    'https://github.com/tribgames/mixdog/releases/download/graph-v0.1.1/mixdog-graph-linux-x64',
    'https://example.com/tribgames/mixdog/releases/download/graph-v0.1.0/mixdog-graph-linux-x64',
    'https://github.com/tribgames/mixdog/releases/download/graph-v0.1.0/mixdog-graph-wrong',
  ]) {
    const noncanonical = graphFixture();
    noncanonical.assets['linux-x64'].url = replacement;
    assert.throws(
      () => validateGraphManifest(noncanonical, { version: APP_VERSION }),
      /graph asset URL must be/,
    );
  }

  const malformedDigest = graphFixture();
  malformedDigest.assets['win32-x64'].sha256 = 'not-a-digest';
  assert.throws(
    () => validateGraphManifest(malformedDigest, { version: APP_VERSION }),
    /invalid graph asset sha256/,
  );

  const malformedVersion = graphFixture();
  malformedVersion.version = '0.1';
  assert.throws(
    () => validateGraphManifest(malformedVersion, { version: APP_VERSION }),
    /not strict MAJOR\.MINOR\.PATCH/,
  );
});

test('downloads local fixture responses, retries, and checks sha256 without network', async () => {
  let calls = 0;
  await verifyAssetDownloads(
    { fixture: { url: 'https://fixtures.invalid/asset', sha256, size: bytes.length } },
    {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('fixture transient failure');
        return new Response(bytes);
      },
      retryDelay: async () => {},
    },
  );
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    verifyAssetDownloads(
      { fixture: { url: 'https://fixtures.invalid/asset', sha256: '0'.repeat(64) } },
      {
        fetchImpl: async () => {
          calls += 1;
          return new Response(bytes);
        },
        retryDelay: async () => {},
      },
    ),
    /verification failed after 3 attempts: sha256 mismatch/,
  );
  assert.equal(calls, 3);
});

test('cancels an undeclared-size patch stream immediately at the absolute ceiling', async () => {
  let chunksProduced = 0;
  let cancellations = 0;
  let aborts = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        chunksProduced += 1;
        controller.enqueue(Buffer.from('abc'));
      },
      cancel() {
        cancellations += 1;
      },
    },
    { highWaterMark: 0 },
  );

  await assert.rejects(
    verifyAssetDownloads(
      { fixture: { url: 'https://fixtures.invalid/asset', sha256 } },
      {
        attempts: 1,
        maxAssetBytes: 5,
        fetchImpl: async (_url, { signal }) => {
          signal.addEventListener('abort', () => { aborts += 1; });
          return { ok: true, status: 200, body: stream };
        },
      },
    ),
    /byte ceiling exceeded \(5 bytes\)/,
  );
  assert.equal(chunksProduced, 2);
  assert.equal(cancellations, 1);
  assert.equal(aborts, 1);
});

test('cancels immediately when a stream exceeds its declared size below the absolute ceiling', async () => {
  let chunksProduced = 0;
  let cancellations = 0;
  let aborts = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        chunksProduced += 1;
        controller.enqueue(Buffer.from('abc'));
      },
      cancel() {
        cancellations += 1;
      },
    },
    { highWaterMark: 0 },
  );

  await assert.rejects(
    verifyAssetDownloads(
      { fixture: { url: 'https://fixtures.invalid/asset', sha256, size: 5 } },
      {
        attempts: 1,
        maxAssetBytes: 10,
        fetchImpl: async (_url, { signal }) => {
          signal.addEventListener('abort', () => { aborts += 1; });
          return { ok: true, status: 200, body: stream };
        },
      },
    ),
    /byte ceiling exceeded \(5 bytes\)/,
  );
  assert.equal(chunksProduced, 2);
  assert.equal(cancellations, 1);
  assert.equal(aborts, 1);
});

test('full guard reads deterministic fixtures and downloads every declared asset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-release-assets-'));
  const patch = patchFixture();
  const runtime = runtimeFixture();
  const graph = graphFixture();
  const expectedUrls = new Set(
    [...Object.values(patch.assets), ...Object.values(runtime.assets), ...Object.values(graph.assets)]
      .map(({ url }) => url),
  );
  const paths = {
    patchManifestPath: join(dir, 'patch.json'),
    cargoPath: join(dir, 'Cargo.toml'),
    runtimeManifestPath: join(dir, 'runtime.json'),
    graphManifestPath: join(dir, 'graph.json'),
    packagePath: join(dir, 'package.json'),
  };
  await Promise.all([
    writeFile(paths.patchManifestPath, JSON.stringify(patch)),
    writeFile(paths.cargoPath, `[package]\nversion = "${VERSION}"\n`),
    writeFile(paths.runtimeManifestPath, JSON.stringify(runtime)),
    writeFile(paths.graphManifestPath, JSON.stringify(graph)),
    writeFile(paths.packagePath, JSON.stringify({ version: APP_VERSION })),
  ]);
  let downloads = 0;
  const requestedUrls = [];
  try {
    await verifyReleaseAssets({
      ...paths,
      downloadOptions: {
        attempts: 1,
        timeoutMs: 1000,
        fetchImpl: async (url) => {
          downloads += 1;
          requestedUrls.push(url);
          return new Response(bytes);
        },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(downloads, 15);
  assert.deepEqual(new Set(requestedUrls), expectedUrls);
});

// ==== from deploy-workflow-test.mjs ====
const workflow = name => readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

test('Deploy is the one-click release entry with incremental native workers', async () => {
  const deploy = await workflow('deploy.yml');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(deploy, /workflow_dispatch:/);
  assert.match(deploy, /id-token:\s*write/);
  assert.match(deploy, /git fetch --tags --force origin[\s\S]*node --test scripts\/release-gate-test\.mjs/);
  assert.match(deploy, /options:\s*\[auto,\s*force,\s*skip\]/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/build-runtime\.yml/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/patch-release\.yml/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/graph-release\.yml/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/release\.yml/);
  assert.match(deploy, /changedSince\(`\$\{tagPrefix\}\$\{manifestVersion\}`/);
  assert.match(deploy, /const preBumped = !currentTagExists && !currentReleaseExists/);
  assert.match(deploy, /const appVersion = resume \|\| preBumped/);
  assert.match(deploy, /needs\.runtime\.result == 'success' \|\| needs\.runtime\.result == 'skipped'/);
  assert.match(deploy,
    /always\(\) && needs\.plan\.result == 'success' && needs\.prepare-app\.result == 'success'/);
  assert.match(deploy,
    /IS_DRAFT=\$\(gh release view "\$TAG" --json isDraft --jq '\.isDraft' 2>\/dev\/null \|\| true\)[\s\S]*if \[\[ "\$IS_DRAFT" == "false" \]\][\s\S]*Published tag \$\{TAG\} is immutable/,
    'only a published release may make its tag immutable; a hidden draft must remain recoverable');
  assert.match(deploy,
    /'isDraft', '--jq', '\.isDraft'[\s\S]*result\.stdout\.trim\(\) === 'false'/,
    'a hidden draft must remain resumable instead of consuming a release version');
  assert.match(deploy, /Moving unpublished recovery tag \$\{TAG\}/);
  assert.match(deploy,
    /const unreleasedPattern = \/\^## Unreleased[\s\S]*else if \(unreleasedBody\)[\s\S]*text\.replace\(versionHeading/,
    'an unpublished same-version recovery must fold its notes into that release');
  for (const bump of ['patch', 'minor', 'major']) {
    assert.equal(
      packageJson.scripts[`release:${bump}`],
      `gh workflow run deploy.yml --ref main -f bump=${bump} -f native=auto`,
    );
  }
});

test('application release overlaps gates and publishes one exact hidden draft', async () => {
  const [release, uploadScript] = await Promise.all([
    workflow('release.yml'),
    readFile(new URL('../.github/scripts/upload-release-assets.sh', import.meta.url), 'utf8'),
  ]);
  assert.match(release, /validate:[\s\S]*fetch-depth:\s*0/);
  assert.match(release,
    /release-regressions:[\s\S]*npm run test:release-critical/,
    'the deploy gate runs only the critical release lane');
  assert.doesNotMatch(release, /test:release-focused:\$\{\{ matrix\.group \}\}/,
    'the four focused groups stay out of the deploy gate');
  assert.match(release, /desktop-build:[\s\S]*name:\s*build-desktop-once/);
  assert.doesNotMatch(release, /desktop-build:\s*\n(?:[^\n]*\n){0,3}\s*needs:/);
  assert.doesNotMatch(release, /name:\s*Execute code graph from a clean cache/);
  assert.match(release, /Restore unchanged desktop output[\s\S]*desktop-out-v1-\$\{\{ hashFiles/);
  assert.match(release, /name:\s*Stage common desktop output[\s\S]*actions\/upload-artifact@v7/);
  assert.match(release,
    /prepare-github-release:[\s\S]*needs:\s*\[validate,\s*release-regressions\][\s\S]*draft:\s*true/);
  assert.match(release,
    /desktop-windows:[\s\S]*needs:\s*\[validate,\s*release-regressions,\s*desktop-build,\s*prepare-github-release\]/);
  assert.match(release,
    /desktop-unix:[\s\S]*needs:\s*\[validate,\s*release-regressions,\s*desktop-build,\s*prepare-github-release\]/);
  assert.match(release, /name:\s*Download common desktop output[\s\S]*actions\/download-artifact@v8/);
  assert.match(release, /name:\s*Restore Electron downloads[\s\S]*ELECTRON_BUILDER_CACHE/);
  assert.equal((release.match(/name:\s*Resolve runtime dependency cache key/g) || []).length, 2);
  assert.equal((release.match(/name:\s*Restore pruned runtime dependencies/g) || []).length, 2);
  assert.equal((release.match(/name:\s*Restore prepared runtime archive/g) || []).length, 2);
  assert.equal((release.match(/desktop-prepared-runtime-v1-/g) || []).length, 2);
  assert.equal((release.match(/name:\s*Restore stable desktop npm downloads/g) || []).length, 2);
  assert.equal((release.match(/dependency-lock-cache-key\.mjs/g) || []).length, 2);
  assert.equal((release.match(/desktop-npm-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}/g) || []).length, 2);
  assert.match(release, /runtime-dependency-cache-key\.mjs[\s\S]*--platform=win32 --arch=x64/);
  assert.match(release, /MIXDOG_RUNTIME_DEPENDENCY_CACHE/);
  assert.match(release, /key:\s*desktop-\$\{\{ steps\.runtime-dependencies\.outputs\.key \}\}/);
  assert.match(release, /MIXDOG_RUNTIME_NPM_CACHE="?\$\(npm config get cache\)"?/);
  assert.equal((release.match(/npm run build --prefix apps\/desktop/g) || []).length, 1);
  assert.doesNotMatch(release, /name:\s*Verify platform embedding runtime/);
  assert.doesNotMatch(release, /name:\s*Install runtime dependencies/);
  assert.match(release, /npm ci --prefix apps\/desktop --prefer-offline --no-audit --no-fund/);
  assert.match(release,
    /platform:\s*darwin,\s*arch:\s*x64,\s*artifact_arch:\s*x64,\s*runner:\s*macos-15-intel/);
  assert.match(release, /name:\s*Stage npm package[\s\S]*actions\/upload-artifact/);
  assert.doesNotMatch(release, /name:\s*Stage (?:Windows|macOS|Linux)/);
  assert.doesNotMatch(release, /name:\s*Download staged desktop packages/);
  assert.equal((release.match(/^\s*gh release upload/gm) || []).length, 3);
  assert.match(release,
    /matrix\.arch \}\}" == x64[\s\S]*upload-release-assets\.sh[\s\S]*gh release upload/);
  assert.match(release, /RELEASE_ID:\s*\$\{\{ needs\.prepare-github-release\.outputs\.release_id \}\}/);
  assert.match(uploadScript, /--http1\.1/);
  assert.match(uploadScript, /--max-time 150/);
  assert.match(uploadScript, /--header "Expect:"/);
  assert.match(uploadScript, /for attempt in 1 2/);
  assert.match(uploadScript, /remote_asset_is_complete/);
  assert.match(release, /name:\s*Verify complete hidden release/);
  assert.match(release, /Hidden release asset set is not exact/);
  assert.ok(
    release.indexOf('name: Publish staged npm package') > release.indexOf('name: Verify complete hidden release'),
  );
  assert.ok(
    release.indexOf('name: Publish one complete GitHub release') > release.indexOf('name: Publish staged npm package'),
  );
  assert.match(release, /npm publish \.\/staged-npm\/\*\.tgz --provenance --access public/);
  assert.match(release, /-F draft=false -f make_latest=true/);
  assert.doesNotMatch(release, /actions\/(?:upload|download)-artifact@v4/);
});

test('desktop production dependencies contain only main-process runtime externals', async () => {
  const desktop = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(desktop.dependencies).sort(), [
    '@homebridge/node-pty-prebuilt-multiarch',
    'electron-updater',
    'qrcode',
    'vscode-jsonrpc',
    'ws',
  ]);
  for (const bundled of [
    '@fontsource-variable/inter',
    '@git-diff-view/react',
    '@monaco-editor/react',
    'monaco-editor',
    'pretendard',
    'react',
    'react-dom',
  ]) {
    assert.ok(desktop.devDependencies[bundled], `${bundled} must stay build-only`);
  }
});

test('native release workflows are reusable and unchanged runtime platforms stay skipped', async () => {
  const [runtime, patch, graph] = await Promise.all([
    workflow('build-runtime.yml'),
    workflow('patch-release.yml'),
    workflow('graph-release.yml'),
  ]);
  for (const worker of [runtime, patch, graph]) assert.match(worker, /workflow_call:/);
  assert.match(runtime, /needs\.build\.result == 'skipped' && inputs\.refresh_manifest/);
  assert.doesNotMatch(runtime,
    /needs\.build\.result == 'success' \|\| needs\.build\.result == 'skipped'\)\s*\}\}/);
  assert.match(patch, /ref:\s*refs\/tags\/\$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(patch,
    /test:[\s\S]*cargo build --release --locked --target x86_64-unknown-linux-gnu/);
  assert.match(patch, /build:[\s\S]*needs:\s*gate/);
  assert.match(patch, /manifest:[\s\S]*needs:\s*\[test,\s*build\]/);
  assert.match(patch, /pattern:\s*patch-\*-\$\{\{ github\.run_attempt \}\}/);
  assert.match(graph, /workflow_dispatch\|workflow_call/);
  assert.equal((graph.match(/cargo test --locked --manifest-path native\/mixdog-graph\/Cargo\.toml/g) || []).length, 1);
  assert.match(graph, /prepare:[\s\S]*needs:\s*\[gate,\s*test,\s*build\]/);
  assert.match(graph, /^concurrency:\s*\n\s*group:\s*graph-release-\$\{\{ inputs\.tag \|\| github\.ref_name \}\}/m);
  assert.match(graph, /sync:[\s\S]*group:\s*graph-release-finalize/);
  assert.doesNotMatch(graph, /^  publish:/m);
});

test('runtime platform smoke restores npm downloads on every runner', async () => {
  const smoke = await workflow('runtime-platform-smoke.yml');
  assert.match(smoke, /actions\/setup-node@v6[\s\S]*cache:\s*npm/);
  assert.match(smoke, /cache-dependency-path:\s*package-lock\.json/);
  assert.match(smoke, /npm ci --prefer-offline --no-audit --no-fund/);
});

// ==== from release-version-discipline-test.mjs ====
const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const STRICT_VERSION = /^\d+\.\d+\.\d+$/;

function protocolFromSource(source, label) {
  const value = Number(
    source.match(/SESSION_PROTOCOL\s*=\s*(\d+)/)?.[1],
  );
  assert.ok(Number.isInteger(value) && value > 0, `${label} has no valid session protocol`);
  return value;
}

test('workspace versions stay synchronized and the development protocol stays at 1', () => {
  const manifests = [
    'package.json',
    'package-lock.json',
    'apps/desktop/package.json',
    'apps/desktop/package-lock.json',
    'apps/relay/package.json',
  ].map((relativePath) => ({
    relativePath,
    value: JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8')),
  }));
  const currentVersion = manifests[0].value.version;
  assert.match(currentVersion, STRICT_VERSION);
  for (const { relativePath, value } of manifests) {
    assert.equal(value.version, currentVersion, `${relativePath} version is not synchronized`);
    if (value.packages?.['']) {
      assert.equal(
        value.packages[''].version,
        currentVersion,
        `${relativePath} root lock package version is not synchronized`,
      );
    }
  }

  const protocolPath = 'src/standalone/session-wire.mjs';
  const currentProtocol = protocolFromSource(
    readFileSync(join(ROOT, protocolPath), 'utf8'),
    protocolPath,
  );
  assert.equal(currentProtocol, 1);
});
