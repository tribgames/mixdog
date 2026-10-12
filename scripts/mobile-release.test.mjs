import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

import {
  androidReleaseCandidates,
  latestMobileTag,
  mobilePathsChangedSince,
  nextMobileVersion,
  planMobileRelease,
  resolveAndroidLink,
} from './mobile-release.mjs';

const TAGS = ['mobile-v0.1.9', 'mobile-v0.1.12', 'mobile-v0.1.10', 'v1.1.1', 'mobile-v0.1.x', ''];

test('the next mobile version continues from the newest mobile-v* tag by semver', () => {
  assert.equal(latestMobileTag(TAGS), 'mobile-v0.1.12');
  assert.equal(latestMobileTag(['v1.0.0']), null);
  assert.equal(nextMobileVersion('mobile-v0.1.12'), '0.1.13');
  assert.equal(nextMobileVersion('mobile-v0.1.12', 'minor'), '0.2.0');
  assert.throws(() => nextMobileVersion('mobile-v0.1.12', 'major'), /invalid mobile version bump/);
  assert.throws(() => nextMobileVersion('v0.1.12'), /invalid mobile release tag/);
});

test('auto releases only when mobile sources changed; force and skip override', () => {
  const seen = [];
  const plan = (mode, changed, bump) =>
    planMobileRelease({
      mode,
      bump,
      tags: TAGS,
      changedSince: (tag) => {
        seen.push(tag);
        return changed;
      },
    });
  assert.deepEqual(plan('auto', true), {
    release: true,
    version: '0.1.13',
    tag: 'mobile-v0.1.13',
    base: 'mobile-v0.1.12',
    reason: 'mobile sources changed since mobile-v0.1.12',
  });
  assert.deepEqual(seen, ['mobile-v0.1.12']);
  assert.equal(plan('auto', false).release, false);
  assert.equal(plan('auto', false).version, '');
  assert.equal(plan('force', false).tag, 'mobile-v0.1.13');
  assert.equal(plan('force', false, 'minor').tag, 'mobile-v0.2.0');
  assert.equal(plan('skip', true).release, false);
  assert.throws(() => plan('sometimes', true), /invalid mobile mode/);
  // Without a tag to continue from, nothing is guessed (it could overwrite a
  // published release).
  assert.equal(planMobileRelease({ mode: 'force', tags: [], changedSince: () => true }).release, false);
});

test('change detection covers the app, its shared desktop import and the mobile workflows, not docs', () => {
  const repo = mkdtempSync(join(tmpdir(), 'mixdog-mobile-plan-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const write = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (path, text) => {
    write(path, text);
    git('add', '-A');
    git('commit', '-q', '-m', path);
  };
  try {
    git('init', '-q');
    commit('apps/mobile/src/main.ts', 'a');
    git('tag', 'mobile-v0.1.0');
    assert.equal(mobilePathsChangedSince('mobile-v0.1.0', { cwd: repo }), false);
    for (const path of ['apps/mobile/README.md', 'apps/mobile/docs/notes.md', 'apps/relay/server.mjs', 'src/x.mjs']) {
      commit(path, 'b');
    }
    assert.equal(mobilePathsChangedSince('mobile-v0.1.0', { cwd: repo }), false);
    for (const path of [
      'apps/mobile/src/main.ts',
      'apps/mobile/android/app/build.gradle',
      'apps/desktop/src/shared/native-app.ts',
      '.github/workflows/mobile-ios.yml',
    ]) {
      git('tag', '-f', 'mobile-v0.1.0');
      commit(path, `changed ${path}`);
      assert.equal(mobilePathsChangedSince('mobile-v0.1.0', { cwd: repo }), true, path);
    }
    assert.throws(() => mobilePathsChangedSince('mobile-v9.9.9', { cwd: repo }), /git diff failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

const release = (tag, { draft = false, apk = true } = {}) => ({
  tag_name: tag,
  draft,
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  assets: apk ? [{ name: `Mixdog-${tag}.apk`, browser_download_url: `https://dl/${tag}.apk` }] : [],
});

test('Android link candidates are published mobile releases with an APK, newest first', () => {
  assert.deepEqual(
    androidReleaseCandidates([
      release('mobile-v0.1.9'),
      release('mobile-v0.1.14', { draft: true }),
      release('mobile-v0.1.13', { apk: false }),
      release('v1.1.1'),
      release('mobile-v0.1.12'),
    ]).map((item) => item.tag),
    ['mobile-v0.1.12', 'mobile-v0.1.9']
  );
});

function fakeGitHub(releases, broken = new Set()) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push([options.method || 'GET', url]);
    if (url.startsWith('https://api.github.com/repos/o/r/releases?')) {
      const page = Number(new URL(url).searchParams.get('page'));
      return { ok: true, status: 200, json: async () => (page === 1 ? releases : []) };
    }
    const ok = !broken.has(url);
    return { ok, status: ok ? 200 : 404 };
  };
  return { fetchImpl, calls };
}

test('the relay links the newest release whose APK downloads, else the releases list', async () => {
  const releases = [release('mobile-v0.1.12'), release('mobile-v0.1.13'), release('mobile-v0.1.14', { draft: true })];
  const options = { repository: 'o/r', attempts: 2, delayMs: 0 };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await resolveAndroidLink({ ...options, ...fakeGitHub(releases) }), {
      url: 'https://github.com/o/r/releases/tag/mobile-v0.1.13',
      tag: 'mobile-v0.1.13',
    });
    const missing = fakeGitHub(releases, new Set(['https://dl/mobile-v0.1.13.apk']));
    assert.equal((await resolveAndroidLink({ ...options, ...missing })).tag, 'mobile-v0.1.12');
    assert.equal(missing.calls.filter(([, url]) => url === 'https://dl/mobile-v0.1.13.apk').length, 2);
    assert.deepEqual(await resolveAndroidLink({ ...options, ...fakeGitHub([release('v1.0.0')]) }), {
      url: 'https://github.com/o/r/releases',
      tag: '',
    });
    // The post-publish check accepts only the exact release it published.
    assert.equal(
      (await resolveAndroidLink({ ...options, requiredTag: 'mobile-v0.1.12', ...fakeGitHub(releases) })).tag,
      'mobile-v0.1.12'
    );
    await assert.rejects(
      resolveAndroidLink({ ...options, requiredTag: 'mobile-v0.1.14', ...fakeGitHub(releases) }),
      /mobile-v0\.1\.14 is not a published release with a downloadable APK/
    );
    await assert.rejects(resolveAndroidLink({ ...options, repository: 'o/r/../x', ...fakeGitHub(releases) }));
  } finally {
    console.warn = warn;
  }
});

const workflow = (name) => parseYaml(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));

test('Deploy ships mobile with the release and the relay waits for the Android release', () => {
  const deploy = workflow('deploy.yml');
  const release = workflow('release.yml');
  const android = workflow('mobile-android.yml');
  const ios = workflow('mobile-ios.yml');

  const inputs = deploy.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.mobile.options, ['auto', 'force', 'skip']);
  assert.equal(inputs.mobile.default, 'auto');
  assert.deepEqual(inputs.mobile_bump.options, ['patch', 'minor']);
  const planStep = deploy.jobs.plan.steps.find((step) => step.id === 'mobile');
  assert.equal(planStep.run, 'node scripts/mobile-release.mjs plan');
  assert.equal(deploy.jobs.plan.outputs.mobile_version, '${{ steps.mobile.outputs.mobile_version }}');

  // iOS runs beside the release: its failure never blocks publish or relay.
  const iosJob = deploy.jobs['mobile-ios'];
  assert.equal(iosJob.uses, './.github/workflows/mobile-ios.yml');
  assert.equal(iosJob.with.ref, '${{ needs.prepare-app.outputs.sha }}');
  assert.deepEqual(Object.keys(iosJob.secrets).sort(), [
    'APPLE_API_ISSUER',
    'APPLE_API_KEY_ID',
    'APPLE_API_KEY_P8',
    'IOS_DIST_P12_BASE64',
    'IOS_DIST_P12_PASSWORD',
    'TESTFLIGHT_EXTERNAL_GROUP_ID',
  ]);
  assert.equal(deploy.jobs.release.with.mobile_version, '${{ needs.plan.outputs.mobile_version }}');
  assert.ok(!(deploy.jobs.release.needs || []).includes('mobile-ios'));

  const androidJob = release.jobs['mobile-android'];
  assert.equal(androidJob.uses, './.github/workflows/mobile-android.yml');
  assert.equal(androidJob.if, "${{ inputs.mobile_version != '' }}");
  assert.equal(androidJob.with.ref, '${{ inputs.ref }}');
  assert.deepEqual(Object.keys(androidJob.secrets).sort(), [
    'ANDROID_KEYSTORE_B64',
    'ANDROID_KEYSTORE_PASSWORD',
    'ANDROID_KEY_ALIAS',
    'ANDROID_KEY_PASSWORD',
    'FIREBASE_GOOGLE_SERVICES_JSON_B64',
  ]);
  assert.deepEqual(release.jobs['android-link'].needs, ['mobile-android']);
  assert.ok(!release.jobs.publish.needs.includes('mobile-android'), 'the desktop publish never waits for Android');
  const relay = release.jobs['deploy-relay'];
  assert.deepEqual(relay.needs, ['publish', 'stage-relay', 'android-link']);
  assert.match(relay.if, /needs\.android-link\.result == 'success'/);
  const deployStep = relay.steps.find((step) => step.name === 'Atomically deploy and verify production');
  assert.equal(deployStep.env.ANDROID_URL, '${{ needs.android-link.outputs.url }}');
  assert.match(
    deployStep.run,
    /deploy-release\.sh' '\$RELAY_DOMAIN' '\$RELEASE_TAG' '\$DESKTOP_VERSION' '\$ANDROID_URL'/
  );

  // Both mobile workflows keep their tag and manual triggers.
  for (const mobile of [android, ios]) {
    assert.deepEqual(mobile.on.push.tags, ['mobile-v*']);
    assert.ok(mobile.on.workflow_dispatch);
    assert.equal(mobile.on.workflow_call.inputs.ref.required, true);
  }
  assert.equal(android.on.workflow_call.inputs.draft.default, false, "Deploy's Android release is published");
  assert.equal(android.on.workflow_dispatch.inputs.draft.default, true);
  const publish = android.jobs.apk.steps.find((step) => step.name === 'Attach to GitHub Release').run;
  assert.match(publish, /node scripts\/publish-asset-release\.mjs create "\$TAG"/);
  assert.doesNotMatch(publish, /gh release create/, 'every create goes through the Latest guard');
  assert.equal(ios.on.workflow_call.inputs.submit_review.default, true);
});
