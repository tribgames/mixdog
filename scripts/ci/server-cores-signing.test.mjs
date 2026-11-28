// Apple's notary inspects the programs inside the macOS server bundles every macOS app carries, and every desktop
// package carries the same bundles: a release signs them once, with the app's Developer ID, before any package
// takes the run's `server-cores` artifact.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from 'yaml';

const load = (name) => parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'));
const build = load('server-cores-build.yml');
const SECRETS = ['MAC_CERTIFICATE_P12_BASE64', 'MAC_CERTIFICATE_PASSWORD'];

/** An expression of `inputs` only (`${{ }}` optional, as in `if:`), as GitHub evaluates it. */
function evaluate(text, inputs) {
  const expression = String(text)
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const js = expression.replace(/\binputs\.(\w+)/g, (_, name) => JSON.stringify(inputs[name] ?? null));
  const outsideStrings = js.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  assert.doesNotMatch(outsideStrings, /[^\w\s'&|!()=-]/, `unsupported expression: ${text}`);
  return new Function(`return (${js});`)();
}

const nameOf = (value, inputs) => (/^\$\{\{[\s\S]*\}\}$/.test(String(value)) ? evaluate(value, inputs) : value);

/** `with:` of a call of server-cores-build.yml over its input defaults. */
const inputsOf = (call) => ({
  ...Object.fromEntries(Object.entries(build.on.workflow_call.inputs).map(([name, input]) => [name, input.default])),
  ...call.with,
});

/** The jobs of server-cores-build.yml that run for `inputs` and upload the artifact `name`. */
function producersOf(name, inputs) {
  return Object.entries(build.jobs)
    .filter(([, job]) => job.if === undefined || evaluate(job.if, inputs))
    .filter(([, job]) =>
      (job.steps ?? []).some(
        (step) => step.uses?.startsWith('actions/upload-artifact@') && nameOf(step.with?.name, inputs) === name
      )
    )
    .map(([job]) => job);
}

test('a release packages the macOS server bundles only as signed by the Developer ID', () => {
  const call = load('release.yml').jobs['server-cores'];
  assert.equal(call.uses, './.github/workflows/server-cores-build.yml');
  for (const name of SECRETS) assert.equal(call.secrets?.[name], `\${{ secrets.${name} }}`);
  const inputs = inputsOf(call);
  const [producer, ...others] = producersOf('server-cores', inputs);
  assert.deepEqual(others, [], 'one job uploads the bundles the packages take');
  const steps = build.jobs[producer].steps;
  const signs = steps.findIndex((step) => /sign-server-cores\.mjs (?!--start)/.test(step.run ?? ''));
  const uploads = steps.findIndex((step) => nameOf(step.with?.name, inputs) === 'server-cores');
  assert.ok(signs >= 0 && signs < uploads, 'the uploaded bundles are the signed ones');
  // It signs what the build job made in this run.
  const takes = steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.deepEqual(producersOf(takes.with.name, inputs), ['server-cores']);
  assert.ok([build.jobs[producer].needs].flat().includes('server-cores'));
});

test('the Linux verification builds its bundles without the macOS signer', () => {
  const inputs = inputsOf(load('linux-desktop-verify.yml').jobs['server-cores']);
  assert.deepEqual(producersOf('server-cores', inputs), ['server-cores']);
  assert.equal(evaluate(build.jobs['sign-darwin'].if, inputs), false);
  assert.equal(evaluate(build.jobs['release-assets'].if, inputs), false, 'and uploads nothing to a release');
});

// The bundles leave the installers: the release's draft holds them, as the set every package took its manifest from, and
// publish refuses a draft that does not hold them with the bytes of that manifest.
test('a release uploads the signed set’s bundles to its draft after checking them, and publish holds the draft to their manifest', () => {
  const release = load('release.yml');
  const call = release.jobs['server-cores'];
  const inputs = inputsOf(call);
  assert.equal(call.with.release_id, '${{ needs.prepare-github-release.outputs.release_id }}');
  assert.ok([call.needs].flat().includes('prepare-github-release'));
  assert.equal(call.permissions.contents, 'write');
  const job = build.jobs['release-assets'];
  assert.equal(evaluate(job.if, inputs), true);
  assert.equal(job.permissions.contents, 'write');
  const [producer] = producersOf('server-cores', inputs);
  assert.ok([job.needs].flat().includes(producer), 'it takes the set once the job that uploads it (the signer) is done');
  const takes = job.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(takes.with.name, 'server-cores');
  const at = (pattern) => job.steps.findIndex((step) => pattern.test(step.run ?? ''));
  const checks = at(/verify-staged-package\.mjs --server-set=server-cores-in/);
  const uploads = at(/upload-release-assets\.sh server-cores-in\/mixdog-server-\*\.tgz/);
  assert.ok(job.steps.indexOf(takes) < checks && checks >= 0 && checks < uploads, 'the bundles are checked before they are uploaded');
  assert.equal(job.steps[uploads].env.RELEASE_ID, '${{ inputs.release_id }}');
  assert.equal(job.outputs.manifest, '${{ steps.manifest.outputs.manifest }}');
  assert.match(job.steps.find((step) => step.id === 'manifest').run, /server-cores-in\/servers\.json/);
  assert.equal(build.on.workflow_call.outputs.manifest.value, '${{ jobs.release-assets.outputs.manifest }}');
  // The packagers take the same set; the SSH install of the installers fetches what this job uploads.
  for (const name of ['desktop-windows', 'desktop-darwin-arm64', 'desktop-darwin-x64', 'desktop-linux-x64', 'desktop-linux-arm64'])
    assert.ok([release.jobs[name].needs].flat().includes('server-cores'), name);

  const publish = release.jobs.publish;
  assert.ok([publish.needs].flat().includes('server-cores'));
  for (const command of ['verify-desktop', 'publish-desktop']) {
    const step = publish.steps.find((candidate) => (candidate.run ?? '').includes(`release-assets.mjs ${command}`));
    assert.equal(step.env.SERVER_BUNDLES_MANIFEST, '${{ needs.server-cores.outputs.manifest }}', command);
  }
});

test('the Developer ID reaches only a GitHub-hosted macOS runner', () => {
  const holders = Object.entries(build.jobs).filter(([, job]) =>
    SECRETS.some((name) => JSON.stringify(job).includes(`secrets.${name}`))
  );
  assert.deepEqual(
    holders.map(([name]) => name),
    ['sign-darwin']
  );
  for (const [name, job] of holders) assert.match(String(job['runs-on']), /^macos-(\d+|latest)(-[a-z]+)?$/, name);
});

// mixdogd may come from the project's own build machines: a program of the bundles must never run beside the
// certificate, its password or the unlocked keychain they go into.
test('no step that runs a program of the bundles sees the Developer ID certificate or its keychain', () => {
  const job = build.jobs['sign-darwin'];
  const holds = (env) => SECRETS.some((name) => JSON.stringify(env ?? {}).includes(`secrets.${name}`));
  assert.equal(holds(job.env), false, 'the job environment holds no certificate secret');
  const importers = job.steps.filter((step) => holds(step.env));
  assert.equal(importers.length, 1, 'one step imports the certificate');
  // It touches no bundle and hands the secrets to no later step.
  assert.doesNotMatch(importers[0].run, /server-cores|apps\/|GITHUB_ENV/);
  const deletes = job.steps.find((step) => /security delete-keychain/.test(step.run ?? ''));
  const starts = job.steps.filter((step) => /sign-server-cores\.mjs --start/.test(step.run ?? ''));
  assert.equal(starts.length, 1, 'one step runs the signed core');
  const at = (step) => job.steps.indexOf(step);
  assert.ok(at(importers[0]) < at(deletes) && at(deletes) < at(starts[0]), 'the core starts once the keychain is gone');
  assert.equal(deletes.if, 'always()', 'the keychain is deleted whatever the earlier steps did, so whenever the core starts it is gone');
});
