import assert from 'node:assert/strict';
import test from 'node:test';

import { compareSemver, currentLatestTag, selectLatestAppRelease } from './release-guard.mjs';
import { buildArgs, publishAssetRelease } from './publish-asset-release.mjs';

const release = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: false, ...extra });

test('compareSemver orders numerically, not lexically', () => {
  assert.ok(compareSemver('v0.10.0', 'v0.9.9') > 0);
  assert.ok(compareSemver('v1.0.0', 'v0.99.99') > 0);
  assert.ok(compareSemver('v1.2.3', 'v1.2.3') === 0);
  assert.ok(compareSemver('1.2.3', 'v1.2.4') < 0);
});

test('the newest published app release wins, whatever the list order', () => {
  const releases = [release('v0.9.0'), release('v0.10.0'), release('v0.2.0')];
  assert.equal(selectLatestAppRelease(releases).tag_name, 'v0.10.0');
  assert.equal(selectLatestAppRelease([...releases].reverse()).tag_name, 'v0.10.0');
});

test('drafts, prereleases and non-app tags are never selected', () => {
  const releases = [
    release('v0.11.0', { draft: true }),
    release('v0.12.0', { prerelease: true }),
    release('mobile-v9.0.0'),
    release('effort-judge-v6'),
    release('graph-v99.0.0'),
    release('v1.2.3-beta.1'),
    release('v1.2'),
    release('v0.9.0'),
  ];
  assert.equal(selectLatestAppRelease(releases).tag_name, 'v0.9.0');
  assert.equal(selectLatestAppRelease(releases.slice(0, 7)), null);
});

test('currentLatestTag maps a 404 to null and rethrows other failures', () => {
  assert.equal(
    currentLatestTag('o/r', () => 'v1.0.0\n'),
    'v1.0.0'
  );
  assert.equal(
    currentLatestTag('o/r', () => {
      throw Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)' });
    }),
    null
  );
  assert.throws(
    () =>
      currentLatestTag('o/r', () => {
        throw new Error('HTTP 500');
      }),
    /HTTP 500/
  );
  assert.throws(
    () =>
      currentLatestTag('o/r', () => {
        throw Object.assign(new Error('x'), { stderr: 'resource not found (HTTP 500)' });
      }),
    /x/
  );
});

test('asset releases are always created or published with --latest=false', () => {
  assert.deepEqual(buildArgs('create', 'mobile-v1.0.0', ['--draft', 'a.apk'], 'o/r'), [
    'release',
    'create',
    'mobile-v1.0.0',
    '--draft',
    'a.apk',
    '--repo',
    'o/r',
    '--latest=false',
  ]);
  assert.deepEqual(buildArgs('publish', 'spawn-v1.0.0', [], 'o/r'), [
    'release',
    'edit',
    'spawn-v1.0.0',
    '--repo',
    'o/r',
    '--draft=false',
    '--latest=false',
  ]);
  assert.throws(() => buildArgs('create', 'v1.0.0', [], 'o/r'), /app release tag/);
  assert.throws(() => buildArgs('create', 'spawn-v1.0.0', ['--latest'], 'o/r'), /do not pass it/);
  assert.throws(() => buildArgs('create', 'spawn-v1.0.0', ['--latest=true'], 'o/r'), /do not pass it/);
});

test('publishing an asset release fails when Latest moved', () => {
  const run = (latestAfter) => {
    const calls = [];
    let latest = 'v1.0.0';
    const fn = (args) => {
      calls.push(args);
      if (args[0] === 'api') return `${latest}\n`;
      latest = latestAfter;
      return '';
    };
    return { fn, calls };
  };
  const stable = run('v1.0.0');
  assert.equal(publishAssetRelease({ action: 'publish', tag: 'graph-v1.0.0', repo: 'o/r', run: stable.fn }), 'v1.0.0');
  assert.equal(stable.calls.filter((args) => args[0] === 'release').length, 1);
  const moved = run('graph-v1.0.0');
  assert.throws(
    () => publishAssetRelease({ action: 'publish', tag: 'graph-v1.0.0', repo: 'o/r', run: moved.fn }),
    /Latest moved from v1\.0\.0 to graph-v1\.0\.0/
  );
});

test('workflow contracts: strict gate, Latest guard triggers, post-release job, asset releases stay off Latest', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parse } = (await import('node:module')).createRequire(import.meta.url)('yaml');
  const read = (name) => readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  // Source-text on purpose: workflow YAML runs only on GitHub runners.
  const { jobs } = parse(await read('deploy.yml'));
  assert.equal(jobs['coverage-gate'].uses, './.github/workflows/release-gate.yml');
  for (const name of ['runtime', 'voice', 'graph']) {
    assert.ok(jobs[name].needs.includes('coverage-gate'), `${name} needs the full native gate`);
    assert.equal(jobs[name].with.sha, jobs['coverage-gate'].with.ref);
  }
  const releaseJobs = parse(await read('release.yml')).jobs;
  assert.equal(releaseJobs['coverage-gate'].uses, './.github/workflows/release-gate.yml');
  assert.equal(releaseJobs['coverage-gate'].with.ref, '${{ inputs.ref }}');
  assert.ok(releaseJobs.publish.needs.includes('coverage-gate'));
  assert.deepEqual(jobs['post-release-check'].needs, ['plan', 'prepare-app', 'release']);
  // Runs even when mobile/relay turn `release` red after the desktop publish,
  // but not when the release call was cancelled or never ran.
  const condition = jobs['post-release-check'].if;
  assert.match(condition, /always\(\)/);
  assert.match(condition, /needs\.release\.result != 'cancelled'/);
  assert.doesNotMatch(condition, /needs\.release\.result == 'success'/);
  const steps = jobs['post-release-check'].steps;
  // The probe lives in scripts/post-release-check.mjs (404 skips; other API
  // errors retry, then fail the job) and needs the checkout + node before it.
  const probe = steps.findIndex((step) => step.id === 'published');
  assert.ok(probe > 0);
  assert.equal(steps[probe].run, 'node scripts/post-release-check.mjs detect-published');
  for (const step of steps.slice(0, probe)) assert.equal(step.if, undefined);
  for (const step of steps.slice(probe + 1)) assert.match(step.if, /steps\.published\.outputs\.published == 'true'/);
  assert.equal(steps.at(-1).env.MOBILE_VERSION, '${{ needs.plan.outputs.mobile_version }}');
  const guard = parse(await read('latest-guard.yml'));
  assert.deepEqual(guard.on.release.types, ['published', 'edited', 'released']);
  assert.ok('workflow_dispatch' in guard.on && guard.on.schedule.length === 1);
  assert.deepEqual(guard.permissions, { contents: 'read', issues: 'write' });
  assert.equal(guard.jobs.guard.permissions, undefined, 'the guard must inherit read-only release access');
  // The one native tool still released on its own publishes without taking Latest.
  assert.match(await read('graph-release.yml'), /-F draft=false -f make_latest=false/);
});

test('standalone runtime dispatch forwards both options and hands off the gated worker’s exact manifest', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parse } = (await import('node:module')).createRequire(import.meta.url)('yaml');
  const workflow = parse(await readFile(new URL('../.github/workflows/refresh-runtime-manifest.yml', import.meta.url), 'utf8'));
  const { inputs } = workflow.on.workflow_dispatch;
  const { refresh, handoff } = workflow.jobs;
  for (const option of ['force_rebuild', 'refresh_manifest']) {
    assert.equal(inputs[option].type, 'boolean');
    assert.equal(refresh.with[option], `\${{ inputs.${option} }}`);
  }
  assert.deepEqual(handoff.permissions, { contents: 'read' });
  assert.ok([handoff.needs].flat().includes('refresh'));
  const download = handoff.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download?.with['artifact-ids'], '${{ needs.refresh.outputs.manifest_id }}');
  assert.equal(download?.with['digest-mismatch'], 'error');
});
