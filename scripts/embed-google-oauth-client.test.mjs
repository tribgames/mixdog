import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { parse } from 'yaml';

import { GOOGLE_OAUTH_CLIENT_FILE, googleOAuthClient } from '../src/runtime/shared/google-oauth-client.mjs';
import { embedGoogleOAuthClient } from './embed-google-oauth-client.mjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET_ID = 'release.apps.googleusercontent.com';
const SECRET_VALUE = 'GOCSPX-release-secret';

async function scratchFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-embed-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'google-oauth-client.generated.json');
}

test('embedding writes the file googleOAuthClient reads, trimmed', async (t) => {
  const file = await scratchFile(t);
  const env = {
    MIXDOG_GOOGLE_OAUTH_CLIENT_ID: ` ${SECRET_ID}\n`,
    MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET: `${SECRET_VALUE} `,
  };
  assert.equal(embedGoogleOAuthClient({ env, file, required: true }), true);
  assert.deepEqual(googleOAuthClient({ env: {}, file }), { clientId: SECRET_ID, clientSecret: SECRET_VALUE });
});

test('a build without the secrets skips embedding and writes nothing', async (t) => {
  const file = await scratchFile(t);
  assert.equal(embedGoogleOAuthClient({ env: {}, file }), false);
  assert.equal(embedGoogleOAuthClient({ env: { MIXDOG_GOOGLE_OAUTH_CLIENT_ID: SECRET_ID }, file }), false);
  await assert.rejects(access(file), { code: 'ENOENT' });
});

test('a release build fails loudly when either secret is missing, without echoing the other', async (t) => {
  const file = await scratchFile(t);
  for (const env of [
    {},
    { MIXDOG_GOOGLE_OAUTH_CLIENT_ID: SECRET_ID },
    { MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET: SECRET_VALUE },
    { MIXDOG_GOOGLE_OAUTH_CLIENT_ID: ' ', MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET: SECRET_VALUE },
  ]) {
    assert.throws(
      () => embedGoogleOAuthClient({ env, file, required: true }),
      (error) => /must both be set/.test(error.message) && !error.message.includes(SECRET_VALUE)
    );
  }
  await assert.rejects(access(file), { code: 'ENOENT' });
});

test('the CLI fails with --require and an empty environment, and only skips without it', async () => {
  const script = join(ROOT, 'scripts', 'embed-google-oauth-client.mjs');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('MIXDOG_GOOGLE_OAUTH_'))
  );
  await assert.rejects(
    exec(process.execPath, [script, '--require'], { env }),
    (error) => error.code === 1 && /Google OAuth client missing/.test(error.stderr)
  );
  const { stdout } = await exec(process.execPath, [script], { env });
  assert.match(stdout, /No Google OAuth client configured/);
});

test('the generated file is gitignored so it can never be committed', async () => {
  const path = relative(ROOT, GOOGLE_OAUTH_CLIENT_FILE);
  await exec('git', ['check-ignore', '--quiet', path], { cwd: ROOT });
});

// Every shipped artifact must write the client before it packs: the npm package
// (release.yml validate) and each desktop runtime.asar (desktop-package.yml).
async function workflow(name) {
  return parse(await readFile(join(ROOT, '.github', 'workflows', name), 'utf8'));
}

const stepIndex = (job, name) => {
  const index = job.steps.findIndex((step) => step.name === name);
  assert.notEqual(index, -1, `missing step "${name}"`);
  return index;
};

function assertEmbedStep(step) {
  assert.match(step.run, /node scripts\/embed-google-oauth-client\.mjs --require/);
  assert.equal(step.env.MIXDOG_GOOGLE_OAUTH_CLIENT_ID, '${{ secrets.MIXDOG_GOOGLE_OAUTH_CLIENT_ID }}');
  assert.equal(step.env.MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET, '${{ secrets.MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET }}');
}

test('the release requires the secrets up front and embeds them before the npm pack', async () => {
  const release = await workflow('release.yml');
  for (const name of ['MIXDOG_GOOGLE_OAUTH_CLIENT_ID', 'MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET']) {
    assert.equal(release.on.workflow_call.secrets[name].required, true, name);
  }
  const { identity, validate } = release.jobs;
  assertEmbedStep(identity.steps[stepIndex(identity, 'Require the Google OAuth client secrets')]);
  const embed = stepIndex(validate, 'Embed the Google OAuth client');
  assertEmbedStep(validate.steps[embed]);
  const pack = stepIndex(validate, 'Pack staged npm release');
  assert.ok(embed < pack, 'the client is embedded before npm pack');
  assert.match(validate.steps[pack].run, /google-oauth-client\.generated\.json/, 'the tarball is checked for the file');
});

test('every desktop package job receives the secrets and embeds them before preparing the runtime', async () => {
  const [release, desktopPackage] = await Promise.all([workflow('release.yml'), workflow('desktop-package.yml')]);
  const callers = Object.entries(release.jobs).filter(
    ([, job]) => job.uses === './.github/workflows/desktop-package.yml'
  );
  assert.equal(callers.length, 5, 'windows, two macOS and two Linux packages');
  for (const [name, job] of callers) {
    for (const secret of ['MIXDOG_GOOGLE_OAUTH_CLIENT_ID', 'MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET']) {
      assert.equal(job.secrets[secret], `\${{ secrets.${secret} }}`, `${name} passes ${secret}`);
      assert.equal(desktopPackage.on.workflow_call.secrets[secret].required, true, secret);
    }
  }
  const job = desktopPackage.jobs.package;
  const embed = stepIndex(job, 'Embed the Google OAuth client');
  assertEmbedStep(job.steps[embed]);
  // Before the cache key (it hashes src/**) and before runtime preparation,
  // so a cached or freshly prepared runtime.asar embeds the current client.
  assert.ok(embed < stepIndex(job, 'Resolve package and runtime cache keys'));
  assert.ok(embed < stepIndex(job, 'Restore prepared runtime archive'));
  assert.ok(embed < stepIndex(job, 'Prepare platform runtime'));
  const verify = job.steps[stepIndex(job, "Verify this platform's packaged runtime layout")];
  assert.equal(verify.env.MIXDOG_GOOGLE_OAUTH_CLIENT_ID, '${{ secrets.MIXDOG_GOOGLE_OAUTH_CLIENT_ID }}');
});
