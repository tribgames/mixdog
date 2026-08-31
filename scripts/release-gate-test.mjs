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
  SPAWN_PLATFORMS,
  validateGraphManifest,
  validatePatchManifest,
  validateRuntimeManifest,
  validateSpawnManifest,
  verifyAssetDownloads,
  verifyReleaseAssets,
} from './verify-release-assets.mjs';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseTimingReport } from './release-timing-report.mjs';

// Product/workflow shape is intentionally non-blocking. Opt in from the
// advisory runner when reviewing a deliberate specification change.
const advisoryTest = process.env.MIXDOG_TEST_ADVISORY === '1' ? test : test.skip;

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
    schema_version: 1,
    generated_at: '2026-01-01T00:00:00.000Z',
    release_tag: 'runtime-v1.2.3',
    pg: { major: 16, minor: 4 },
    pgvector: { version: '0.8.2' },
    assets: Object.fromEntries(Object.keys(PATCH_PLATFORMS).map((platform) => [
      platform,
      {
        url: `https://github.com/tribgames/mixdog/releases/download/runtime-v1.2.3/mixdog-runtime-${platform}-pg16.4-pgvector0.8.2.tar.gz`,
        sha256,
        size: bytes.length,
      },
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

function spawnFixture() {
  return {
    version: VERSION,
    _comment: 'test fixture',
    assets: Object.fromEntries(Object.entries(SPAWN_PLATFORMS).map(([platform, filename]) => [
      platform,
      {
        url: `https://github.com/tribgames/mixdog/releases/download/spawn-v${VERSION}/${filename}`,
        sha256,
      },
    ])),
  };
}

test('accepts independent strict patch, runtime, app, and graph versions', () => {
  assert.equal(validatePatchManifest(patchFixture(), `[package]\nversion = "${VERSION}"\n`).version, VERSION);
  assert.equal(validateRuntimeManifest(runtimeFixture()).release_tag, 'runtime-v1.2.3');
  assert.equal(validateGraphManifest(graphFixture(), { version: APP_VERSION }).version, GRAPH_VERSION);
  assert.equal(validateSpawnManifest(spawnFixture(), `[package]\nversion = "${VERSION}"\n`).version, VERSION);
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

  const noncanonicalRuntime = runtimeFixture();
  noncanonicalRuntime.assets['linux-x64'].url = 'https://example.com/runtime.tar.gz';
  assert.throws(() => validateRuntimeManifest(noncanonicalRuntime), /runtime asset URL must be/);

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
  const spawn = spawnFixture();
  const expectedUrls = new Set(
    [...Object.values(patch.assets), ...Object.values(runtime.assets), ...Object.values(graph.assets), ...Object.values(spawn.assets)]
      .map(({ url }) => url),
  );
  const paths = {
    patchManifestPath: join(dir, 'patch.json'),
    cargoPath: join(dir, 'Cargo.toml'),
    runtimeManifestPath: join(dir, 'runtime.json'),
    graphManifestPath: join(dir, 'graph.json'),
    spawnManifestPath: join(dir, 'spawn.json'),
    spawnCargoPath: join(dir, 'spawn-Cargo.toml'),
    packagePath: join(dir, 'package.json'),
  };
  await Promise.all([
    writeFile(paths.patchManifestPath, JSON.stringify(patch)),
    writeFile(paths.cargoPath, `[package]\nversion = "${VERSION}"\n`),
    writeFile(paths.runtimeManifestPath, JSON.stringify(runtime)),
    writeFile(paths.graphManifestPath, JSON.stringify(graph)),
    writeFile(paths.spawnManifestPath, JSON.stringify(spawn)),
    writeFile(paths.spawnCargoPath, `[package]\nversion = "${VERSION}"\n`),
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
  assert.equal(downloads, 20);
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
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/build-voice-runtime\.yml/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/patch-release\.yml/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/graph-release\.yml/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/spawn-release\.yml/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/release\.yml/);
  assert.match(deploy, /changedSince\(`\$\{tagPrefix\}\$\{manifestVersion\}`/);
  assert.match(deploy, /const preBumped = !currentTagExists && !currentReleaseExists/);
  assert.match(deploy, /const appVersion = resume \|\| preBumped/);
  assert.match(deploy, /needs\.runtime\.result == 'success' \|\| needs\.runtime\.result == 'skipped'/);
  assert.match(deploy, /needs\.voice\.result == 'success' \|\| needs\.voice\.result == 'skipped'/);
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
  const [release, automaticGate, desktopPackage, relayDeploy, uploadScript] = await Promise.all([
    workflow('release.yml'),
    workflow('release-gate.yml'),
    workflow('desktop-package.yml'),
    readFile(new URL('../apps/relay/deploy/deploy-release.sh', import.meta.url), 'utf8'),
    readFile(new URL('../.github/scripts/upload-release-assets.sh', import.meta.url), 'utf8'),
  ]);
  assert.match(automaticGate, /pull_request:[\s\S]*push:[\s\S]*branches:\s*\[main\]/);
  assert.match(automaticGate, /name:\s*Select incremental gates/);
  assert.match(automaticGate, /\^\(apps\/desktop\/\|src\/\|vendor\//);
  assert.match(
    automaticGate,
    /scripts\/\(prune-embedding-runtime\|native-binary-arch\|native-tool-download\|runtime-dependency-cache-key\)/,
  );
  assert.match(
    automaticGate,
    /cursor-provider-test\|prune-embedding-runtime\|native-binary-arch/,
  );
  assert.match(automaticGate, /needs\.changes\.outputs\.desktop == 'true'/);
  assert.match(automaticGate, /needs\.changes\.outputs\.graph == 'true'/);
  assert.match(release,
    /identity:[\s\S]*Verify release tag matches package version/);
  assert.match(release, /validate:[\s\S]*needs:\s*identity[\s\S]*fetch-depth:\s*0/);
  assert.match(release,
    /validate:[\s\S]*Verify bundled release assets[\s\S]*Verify changed source-critical release invariants[\s\S]*npm run test:release-critical/,
    'the deploy gate runs only the critical release lane');
  assert.doesNotMatch(release, /Install ripgrep|apt-get[^\n]*ripgrep/,
    'the native search backend must not pay for a system ripgrep install');
  assert.doesNotMatch(release, /\n  release-invariants:/);
  assert.doesNotMatch(release, /test:release-focused:\$\{\{ matrix\.group \}\}/,
    'the four focused groups stay out of the deploy gate');
  assert.match(release, /desktop-build:[\s\S]*name:\s*build-desktop-once/);
  assert.doesNotMatch(release, /desktop-build:\s*\n(?:[^\n]*\n){0,3}\s*needs:/);
  assert.doesNotMatch(release, /name:\s*Execute code graph from a clean cache/);
  // Version-neutral keys: Deploy rewrites the manifest version one job before
  // these caches are read, so a raw hashFiles() key can never hit on the run
  // that needs it. The gate warms the identical key on every main push.
  // The key's version prefix is deliberately bumpable: what must hold is the
  // version-neutral manifest digest and the absence of the lock file, not a
  // particular generation number.
  assert.match(release,
    /Restore unchanged desktop output[\s\S]*desktop-out-v\d+-\$\{\{ steps\.desktop-key\.outputs\.manifest \}\}/);
  const desktopOutKey = release.match(/desktop-out-v\d+-[\s\S]*?\) \}\}/)?.[0] || '';
  assert.ok(desktopOutKey, 'the desktop output cache key must be present');
  assert.doesNotMatch(desktopOutKey, /package-lock\.json/,
    'the lock file reaches this key only through the version-neutral digest');
  assert.match(automaticGate,
    /name:\s*Reuse or warm the release desktop output cache[\s\S]*desktop-out-v\d+-\$\{\{ steps\.desktop-key\.outputs\.manifest \}\}/);
  assert.match(automaticGate, /name:\s*Build desktop[\s\S]*steps\.desktop-out\.outputs\.cache-hit != 'true'/,
    'an unchanged desktop bundle must not be rebuilt by the gate');
  assert.match(automaticGate, /manifest-cache-key\.mjs/);
  assert.match(desktopPackage, /manifest-cache-key\.mjs/);
  // Actions are SHA-pinned with the release as a trailing comment, so the
  // major version is asserted through that comment. Matching a bare `@v7` tag
  // could never succeed here and left the check permanently red.
  assert.match(release,
    /name:\s*Stage common desktop output[\s\S]*actions\/upload-artifact@[0-9a-f]{40} # v7/);
  assert.doesNotMatch(release, /desktop-runtime\.yml|desktop-runtime-(?:win32|darwin|linux)/);
  assert.equal((release.match(/uses:\s*\.\/\.github\/workflows\/desktop-package\.yml/g) || []).length, 4);
  for (const packageJob of ['windows', 'darwin-arm64', 'linux-x64', 'linux-arm64']) {
    assert.match(release, new RegExp(
      `desktop-${packageJob}:[\\s\\S]*?needs:\\s*\\[desktop-build, prepare-github-release\\][\\s\\S]*?uses:\\s*\\.\\/\\.github\\/workflows\\/desktop-package\\.yml`,
    ));
  }
  assert.match(release,
    /prepare-github-release:[\s\S]*needs:\s*\[identity\][\s\S]*draft:\s*true/);
  assert.match(desktopPackage,
    /name:\s*Download common desktop output[\s\S]*actions\/download-artifact@[0-9a-f]{40} # v8/);
  assert.doesNotMatch(desktopPackage, /Download prepared platform runtime|desktop-runtime-\$\{\{ inputs\.platform/);
  assert.match(desktopPackage, /name:\s*Restore Electron downloads[\s\S]*ELECTRON_BUILDER_CACHE/);
  assert.match(desktopPackage, /name:\s*Resolve package and runtime cache keys/);
  assert.match(desktopPackage, /name:\s*Restore pruned runtime dependencies/);
  assert.match(desktopPackage, /name:\s*Restore prepared runtime archive/);
  assert.match(desktopPackage,
    /name:\s*Restore prepared runtime archive[\s\S]*id:\s*prepared-runtime/);
  assert.equal((desktopPackage.match(
    /if:\s*steps\.prepared-runtime\.outputs\.cache-hit != 'true'/g,
  ) || []).length, 2);
  const preparedRuntimeKey = desktopPackage.match(/desktop-prepared-runtime-v\d+-[^\n]*/)?.[0] || '';
  assert.ok(preparedRuntimeKey, 'the prepared runtime cache key must be present');
  assert.doesNotMatch(preparedRuntimeKey, /hashFiles\([^)]*package(?:-lock)?\.json/,
    'the manifests reach this key only through the version-neutral digest');
  assert.match(desktopPackage, /name:\s*Restore stable desktop npm downloads/);
  assert.match(desktopPackage, /dependency-lock-cache-key\.mjs/);
  assert.match(desktopPackage, /runtime-dependency-cache-key\.mjs[\s\S]*--platform=\$\{\{ inputs\.platform \}\} --arch=\$\{\{ inputs\.arch \}\}/);
  assert.match(desktopPackage, /MIXDOG_RUNTIME_DEPENDENCY_CACHE/);
  assert.match(desktopPackage, /key:\s*desktop-\$\{\{ steps\.runtime-dependencies\.outputs\.key \}\}/);
  assert.match(desktopPackage, /MIXDOG_RUNTIME_NPM_CACHE="?\$\(npm config get cache\)"?/);
  assert.equal((release.match(/npm run build --prefix apps\/desktop/g) || []).length, 1);
  assert.doesNotMatch(desktopPackage, /name:\s*Verify platform embedding runtime/);
  assert.doesNotMatch(desktopPackage, /name:\s*Install runtime dependencies/);
  assert.match(release, /npm ci --prefix apps\/desktop --prefer-offline --no-audit --no-fund/);
  assert.match(release, /name:\s*Stage npm package[\s\S]*actions\/upload-artifact/);
  assert.doesNotMatch(desktopPackage, /name:\s*Stage (?:Windows|macOS|Linux)/);
  assert.doesNotMatch(release, /name:\s*Download staged desktop packages/);
  assert.equal((desktopPackage.match(/^\s*gh release upload/gm) || []).length, 2);
  assert.match(desktopPackage,
    /name:\s*Smoke and upload verified Windows assets in parallel[\s\S]*upload-release-assets\.sh "\$\{assets\[@\]\}" &[\s\S]*npm run verify:packaged-runtime[\s\S]*wait "\$upload_pid"/);
  assert.match(desktopPackage,
    /inputs\.arch \}\}" == x64[\s\S]*upload-release-assets\.sh[\s\S]*gh release upload/);
  assert.match(desktopPackage, /RELEASE_ID:\s*\$\{\{ inputs\.release_id \}\}/);
  assert.match(uploadScript, /--http1\.1/);
  assert.match(uploadScript, /--max-time 150/);
  assert.match(uploadScript, /--speed-limit 1024 --speed-time 20/);
  assert.match(uploadScript, /--header "Expect:"/);
  assert.match(uploadScript, /for attempt in 1 2/);
  assert.match(uploadScript, /remote_asset_is_complete/);
  assert.match(uploadScript, /upload_asset "\$asset" &/);
  assert.match(uploadScript, /if ! wait "\$pid"/);
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
  assert.match(release,
    /stage-relay:[\s\S]*needs:\s*\[identity,\s*desktop-build\][\s\S]*Restore renderer precompression cache[\s\S]*Stage production relay artifact/);
  assert.match(release,
    /deploy-relay:[\s\S]*needs:\s*\[publish,\s*stage-relay\][\s\S]*Download staged production relay/);
  assert.match(release, /publish:[\s\S]*Publish staged npm package[\s\S]*Publish one complete GitHub release[\s\S]*deploy-relay:/);
  assert.match(release, /name:\s*Atomically deploy and verify production/);
  assert.ok(release.includes("awk '{print \\$1}'"),
    'the remote hash command must preserve awk $1 without expanding a shell positional parameter');
  assert.equal(release.includes("awk '{print \\\\$1}'"), false);
  assert.match(release, /secrets\.RELAY_SSH_KEY/);
  assert.match(release, /vars\.RELAY_DOMAIN/);
  assert.match(release, /release-timings:[\s\S]*Record timing and warn on material regressions/);
  assert.match(release, /release-timing-report\.mjs/);
  assert.match(relayDeploy, /mv "\$INSTALL_DIR" "\$BACKUP_DIR"/);
  assert.match(relayDeploy, /trap rollback ERR/);
  assert.match(relayDeploy, /sha256sum "\$INSTALL_DIR\/renderer\/index\.html"/);
  assert.match(relayDeploy, /package-lock\.json/);
  assert.match(relayDeploy, /npm ci --omit=dev/);
  assert.match(relayDeploy, /--hardlink-base/);
  assert.match(relayDeploy, /cp -al "\$INSTALL_DIR\/renderer"/);
  for (const worker of [release, desktopPackage]) {
    assert.doesNotMatch(worker, /actions\/(?:upload|download)-artifact@v4/);
  }
});

test('release timing report flags material regressions and renders the slowest steps', () => {
  const jobs = (seconds) => ({
    jobs: [{
      name: 'release / desktop-darwin-x64',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: `2026-01-01T00:01:${String(seconds).padStart(2, '0')}Z`,
      steps: [{
        name: 'Build desktop package',
        started_at: '2026-01-01T00:00:00Z',
        completed_at: `2026-01-01T00:00:${String(seconds).padStart(2, '0')}Z`,
      }],
    }],
  });
  const report = buildReleaseTimingReport(jobs(40), jobs(20));
  assert.equal(report.regressions.length, 1);
  assert.equal(report.regressions[0].percent, 100);
  assert.match(report.markdown, /Build desktop package/);
  assert.match(report.markdown, /\+100%/);
});

advisoryTest('desktop production dependencies contain only main-process runtime externals', async () => {
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
  const voiceConfig = JSON.parse(
    await readFile(new URL('./voice-runtime-config.json', import.meta.url), 'utf8'),
  );
  const [runtime, voice, patch, graph, spawn] = await Promise.all([
    workflow('build-runtime.yml'),
    workflow('build-voice-runtime.yml'),
    workflow('patch-release.yml'),
    workflow('graph-release.yml'),
    workflow('spawn-release.yml'),
  ]);
  for (const worker of [runtime, voice, patch, graph, spawn]) assert.match(worker, /workflow_call:/);
  assert.match(runtime, /needs\.build\.result == 'skipped' && inputs\.refresh_manifest/);
  assert.doesNotMatch(runtime,
    /needs\.build\.result == 'success' \|\| needs\.build\.result == 'skipped'\)\s*\}\}/);
  assert.ok(voiceConfig.platforms.some(platform => platform.key === 'linux-arm64'));
  assert.match(voice, /draft:\s*true[\s\S]*Verify complete hidden release[\s\S]*draft:\s*false/);
  assert.match(voice, /make_latest:\s*false/);
  assert.match(patch, /ref:\s*refs\/tags\/\$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(patch,
    /test:[\s\S]*cargo build --release --locked --target x86_64-unknown-linux-gnu/);
  assert.match(patch, /build:[\s\S]*needs:\s*gate/);
  assert.doesNotMatch(patch, /max-parallel:/);
  assert.match(patch, /manifest:[\s\S]*needs:\s*\[test,\s*build\]/);
  assert.match(patch, /pattern:\s*patch-\*-\$\{\{ github\.run_attempt \}\}/);
  assert.match(graph, /workflow_dispatch\|workflow_call/);
  assert.doesNotMatch(graph, /max-parallel:/);
  assert.equal((graph.match(/cargo test --locked --manifest-path native\/mixdog-graph\/Cargo\.toml/g) || []).length, 1);
  assert.equal((graph.match(/mozilla-actions\/sccache-action@fc920bf0ec8de6ee65d409111f7ec508035751ba/g) || []).length, 2);
  assert.match(graph, /SCCACHE_GHA_VERSION:\s*graph-primary-v1-\$\{\{ matrix\.pkey \}\}/);
  assert.match(graph, /SCCACHE_GHA_VERSION:\s*graph-comparison-v1-\$\{\{ matrix\.pkey \}\}/);
  for (const [name, worker] of [['graph', graph], ['spawn', spawn]]) {
    assert.match(worker, /rebuild:[\s\S]*name:\s*build-\$\{\{ matrix\.pkey \}\}-comparison/);
    assert.match(worker, /prepare:[\s\S]*needs:\s*\[gate,\s*test,\s*build,\s*rebuild\]/);
    assert.match(worker,
      new RegExp(`pattern:\\s*rebuild-${name}-\\*-\\$\\{\\{ github\\.run_attempt \\}\\}`));
    assert.match(worker, /cmp "_release\/\$asset" "_repro\/\$asset"/);
    assert.match(worker,
      new RegExp(`^concurrency:\\s*\\n\\s*group:\\s*${name}-release-\\$\\{\\{ inputs\\.tag \\|\\| github\\.ref_name \\}\\}`, 'm'));
    assert.match(worker, new RegExp(`sync:[\\s\\S]*group:\\s*${name}-release-finalize`));
  }
  assert.doesNotMatch(graph, /^  publish:/m);
});

advisoryTest('runtime platform smoke restores npm downloads on every runner', async () => {
  const smoke = await workflow('runtime-platform-smoke.yml');
  assert.match(smoke, /actions\/setup-node@[0-9a-f]{40} # v6[\s\S]*cache:\s*npm/);
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

test('project versions stay synchronized and the development protocol is valid', () => {
  const manifests = [
    'package.json',
    'package-lock.json',
    'apps/desktop/package.json',
    'apps/desktop/package-lock.json',
    'apps/relay/package.json',
    'apps/relay/package-lock.json',
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
  assert.ok(currentProtocol > 0);
});

test('npm package declares the published native platform families', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.os, ['darwin', 'linux', 'win32']);
  assert.deepEqual(pkg.cpu, ['x64', 'arm64']);
});

test('the checked-in runtime manifest satisfies the release schema', async () => {
  const runtimeSource = await readFile(
    new URL('../src/runtime/memory/data/runtime-manifest.json', import.meta.url),
    'utf8',
  );
  const runtime = JSON.parse(runtimeSource);
  assert.equal(validateRuntimeManifest(runtime).release_tag, runtime.release_tag);
});
