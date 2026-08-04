import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = name => readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

test('Deploy is the one-click release entry with incremental native workers', async () => {
  const deploy = await workflow('deploy.yml');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(deploy, /workflow_dispatch:/);
  assert.match(deploy, /id-token:\s*write/);
  assert.match(deploy, /options:\s*\[auto,\s*force,\s*skip\]/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/build-runtime\.yml/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/patch-release\.yml/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/graph-release\.yml/);
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/release\.yml/);
  assert.match(deploy, /changedSince\(`\$\{tagPrefix\}\$\{manifestVersion\}`/);
  assert.match(deploy, /needs\.runtime\.result == 'success' \|\| needs\.runtime\.result == 'skipped'/);
  assert.match(deploy,
    /always\(\) && needs\.plan\.result == 'success' && needs\.prepare-app\.result == 'success'/);
  assert.match(deploy, /if gh release view "\$TAG"[\s\S]*Published tag \$\{TAG\} is immutable/);
  assert.match(deploy, /Moving unpublished recovery tag \$\{TAG\}/);
  for (const bump of ['patch', 'minor', 'major']) {
    assert.equal(
      packageJson.scripts[`release:${bump}`],
      `gh workflow run deploy.yml --ref main -f bump=${bump} -f native=auto`,
    );
  }
});

test('application release stages every platform before publishing', async () => {
  const release = await workflow('release.yml');
  assert.match(release, /publish:[\s\S]*needs:\s*\[validate,\s*desktop-windows,\s*desktop-unix\]/);
  assert.match(release, /desktop-build:[\s\S]*name:\s*build-desktop-once/);
  assert.match(release, /Restore unchanged desktop output[\s\S]*desktop-out-v1-\$\{\{ hashFiles/);
  assert.match(release, /name:\s*Stage common desktop output[\s\S]*actions\/upload-artifact@v7/);
  assert.match(release, /desktop-windows:[\s\S]*needs:\s*desktop-build/);
  assert.match(release, /desktop-unix:[\s\S]*needs:\s*desktop-build/);
  assert.match(release, /name:\s*Download common desktop output[\s\S]*actions\/download-artifact@v8/);
  assert.match(release, /name:\s*Restore Electron downloads[\s\S]*ELECTRON_BUILDER_CACHE/);
  assert.equal((release.match(/name:\s*Resolve runtime dependency cache key/g) || []).length, 2);
  assert.equal((release.match(/name:\s*Restore pruned runtime dependencies/g) || []).length, 2);
  assert.match(release, /runtime-dependency-cache-key\.mjs[\s\S]*--platform=win32 --arch=x64/);
  assert.match(release, /MIXDOG_RUNTIME_DEPENDENCY_CACHE/);
  assert.match(release, /key:\s*desktop-\$\{\{ steps\.runtime-dependencies\.outputs\.key \}\}/);
  assert.match(release, /MIXDOG_RUNTIME_NPM_CACHE="?\$\(npm config get cache\)"?/);
  assert.equal((release.match(/npm run build --prefix apps\/desktop/g) || []).length, 1);
  assert.doesNotMatch(release, /name:\s*Verify platform embedding runtime/);
  assert.doesNotMatch(release, /name:\s*Install runtime dependencies/);
  assert.match(release, /npm ci --prefix apps\/desktop --prefer-offline --no-audit --no-fund/);
  assert.match(release, /platform:\s*darwin,\s*arch:\s*x64,\s*runner:\s*macos-15-intel/);
  assert.match(release, /name:\s*Stage npm package[\s\S]*actions\/upload-artifact/);
  assert.match(release, /name:\s*Stage Windows installer and update feed[\s\S]*actions\/upload-artifact/);
  assert.match(release, /name:\s*Download staged desktop packages[\s\S]*actions\/download-artifact/);
  assert.match(release, /name:\s*Verify complete staged release/);
  assert.ok(
    release.indexOf('name: Publish staged npm package') > release.indexOf('name: Verify complete staged release'),
  );
  assert.ok(
    release.indexOf('name: Publish one complete GitHub release') > release.indexOf('name: Publish staged npm package'),
  );
  assert.match(release, /npm publish \.\/staged-npm\/\*\.tgz --provenance --access public/);
  assert.doesNotMatch(release, /actions\/(?:upload|download)-artifact@v4/);
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
