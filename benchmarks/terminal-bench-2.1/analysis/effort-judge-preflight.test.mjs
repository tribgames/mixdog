import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = new URL('../run.ps1', import.meta.url);
const probe = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
const options = { skip: probe.error?.code === 'ENOENT' ? 'PowerShell 7 is not installed' : false };
const release = 'test-model-release';
const runtime = '1.25.2';
const payload = Buffer.from('small deterministic bundle fixture; never loaded as a model');
const digest = createHash('sha256').update(payload).digest('hex');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mixdog-judge-preflight-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bench = join(root, 'benchmarks', 'terminal-bench-2.1');
  const model = join(root, 'src', 'runtime', 'effort-judge');
  await mkdir(join(bench, 'harness'), { recursive: true });
  await mkdir(model, { recursive: true });
  await copyFile(source, join(bench, 'run.ps1'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0', dependencies: { 'onnxruntime-node': runtime } }));
  await writeFile(join(model, 'model-manifest.json'), JSON.stringify({ release }));
  const bundle = join(bench, 'bundle.tar');
  const env = {
    ...process.env,
    MIXDOG_TB_PREBAKE_TAR: join(root, 'absent-prebake.tar.gz'),
    MIXDOG_TB_EFFORT_JUDGE_BUNDLE: bundle,
    TEST_BENCH_ROOT: bench,
    TEST_RUNNER_RECEIPT: join(root, 'runner.json'),
  };
  return { root, bench, bundle, env };
}

function run(f, script, args = []) {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args], {
    env: f.env, encoding: 'utf8', timeout: 20_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

for (const mode of ['steps', 'on', 'off']) {
  test(`real preset dry run (${mode}) plans without a local judge bundle or creating jobs`, options, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.bench, 'presets.json'), JSON.stringify({
      schemaVersion: 1, dataset: 'fixture',
      presets: { small: { suite: 'tiny', routeProfile: 'local' } },
      suites: { tiny: ['one-task'] }, defaults: { concurrent: 1, attempts: 1, maxRetries: 0 },
    }));
    await writeFile(join(f.bench, 'harness', 'route_profiles.json'), JSON.stringify({
      schemaVersion: 1, profiles: { local: { routes: { lead: { provider: 'fixture', model: 'not-invoked', effort: 'high' } } } },
    }));
    // Only the downstream execution boundary is controlled. The actual preset
    // entry, manifest, fingerprint and dry-run decision execute unchanged.
    await writeFile(join(f.bench, 'harness', 'run-tb21.ps1'), `
param($JobsDir, $Include, $Concurrent, $Attempts, $MaxRetries, $RouteProfile, $EffortJudge, [switch]$DryRun, [switch]$FastSetup)
if (-not $DryRun) { throw 'a dry-run request reached execution' }
@{mode=$EffortJudge;dry=[bool]$DryRun;jobs=$JobsDir} | ConvertTo-Json | Set-Content -LiteralPath $env:TEST_RUNNER_RECEIPT
exit 0
`);
    const jobs = join(f.root, 'jobs-not-created');
    const result = run(f, join(f.bench, 'run.ps1'), ['-Preset', 'small', '-JobsDir', jobs, '-EffortJudge', mode, '-DryRun']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /fingerprint sha256:[a-f0-9]{64}/);
    if (mode !== 'off') assert.ok(result.stdout.includes(release));
    assert.deepEqual(JSON.parse(await readFile(f.env.TEST_RUNNER_RECEIPT, 'utf8')), { mode, dry: true, jobs });
    await assert.rejects(readFile(f.bundle), { code: 'ENOENT' });
    await assert.rejects(readFile(join(jobs, 'preset-run.json')), { code: 'ENOENT' });
  });
}

// Load the real PowerShell function ASTs, not a second implementation of the
// validator. Nothing below invokes Harbor, Docker, a provider or a model.
const validationDriver = `
$ErrorActionPreference = 'Stop'
$benchRoot = $env:TEST_BENCH_ROOT
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $benchRoot 'run.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($fn in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  Invoke-Expression $fn.Extent.Text
}
$release = [string]((Get-Content -Raw -LiteralPath (Join-Path $benchRoot '../../src/runtime/effort-judge/model-manifest.json') | ConvertFrom-Json).release)
$problem = Get-EffortJudgeBundleProblem 'steps' $env:MIXDOG_TB_EFFORT_JUDGE_BUNDLE $release
if ($null -ne $problem) { throw $problem }
$release
`;

for (const [name, change, expected] of [
  ['matching stamp', () => {}, null],
  ['stale runtime', stamp => { stamp.onnxruntime = '0.0.1'; }, /ONNX Runtime/],
  ['missing runtime', stamp => { delete stamp.onnxruntime; }, /ONNX Runtime/],
  ['empty runtime', stamp => { stamp.onnxruntime = ''; }, /ONNX Runtime/],
  ['different model release', stamp => { stamp.release = 'old-model'; }, /manifest names/],
  ['non-step model', stamp => { stamp.steps = false; }, /not step-trained/],
  ['wrong digest', stamp => { stamp.sha256 = '0'.repeat(64); }, /digest differs/],
  ['missing bundle', () => {}, /bundle or its stamp missing/],
  ['missing stamp', () => {}, /bundle or its stamp missing/],
]) {
  test(`real judge preflight: ${name}`, options, async (t) => {
    const f = await fixture(t);
    const stamp = { release, onnxruntime: runtime, steps: true, sha256: digest };
    change(stamp);
    if (name !== 'missing bundle') await writeFile(f.bundle, payload);
    if (name !== 'missing stamp') await writeFile(`${f.bundle}.json`, JSON.stringify(stamp));
    const driver = join(f.root, 'validate.ps1');
    await writeFile(driver, validationDriver);
    const result = run(f, driver);
    if (expected) {
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, expected);
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout.trim(), release);
    }
  });
}

for (const scenario of ['missing bundle', 'stale runtime', 'invalid rebuilt runtime', 'builder failure', 'current bundle']) {
  test(`real judge auto-build: ${scenario}`, options, async (t) => {
    const f = await fixture(t);
    const stamp = { release, onnxruntime: runtime, steps: true, sha256: digest };
    if (scenario !== 'missing bundle') {
      await writeFile(f.bundle, payload);
      await writeFile(`${f.bundle}.json`, JSON.stringify({ ...stamp, onnxruntime: scenario === 'current bundle' ? runtime : 'old-runtime' }));
    }
    // Substitute only the expensive bundle builder. The real preflight must
    // decide whether to build and revalidate the produced bytes and stamp.
    f.env.TEST_BUILD_RECEIPT = join(f.root, 'built.txt');
    f.env.TEST_REBUILT_STAMP = JSON.stringify({ ...stamp, onnxruntime: scenario === 'invalid rebuilt runtime' ? 'still-old' : runtime });
    f.env.TEST_BUNDLE_BYTES = payload.toString('base64');
    f.env.TEST_BUILD_FAIL = scenario === 'builder failure' ? '1' : '0';
    await writeFile(join(f.bench, 'harness', 'build-effort-judge-bundle.ps1'), `
param([string]$Out)
if (Test-Path -LiteralPath $env:TEST_BUILD_RECEIPT) { throw 'builder called more than once' }
Set-Content -LiteralPath $env:TEST_BUILD_RECEIPT -Value 'built'
if ($env:TEST_BUILD_FAIL -eq '1') { throw 'fixture build failed' }
[IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String($env:TEST_BUNDLE_BYTES))
Set-Content -LiteralPath "$Out.json" -Value $env:TEST_REBUILT_STAMP
`);
    const driver = join(f.root, 'automatic.ps1');
    await writeFile(driver, validationDriver.slice(0, validationDriver.indexOf('\n$release =')) + "\n$DryRun = $false\nAssert-EffortJudgeBundle 'steps'\n");
    const result = run(f, driver);
    const expected = scenario === 'invalid rebuilt runtime' ? /ONNX Runtime.*after the automatic build/ :
      scenario === 'builder failure' ? /bundle build failed: fixture build failed/ : null;
    assert.equal(result.status, expected ? 1 : 0, result.stdout + result.stderr);
    if (expected) assert.match(result.stdout + result.stderr, expected);
    else assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), release);
    if (scenario === 'current bundle') await assert.rejects(readFile(f.env.TEST_BUILD_RECEIPT), { code: 'ENOENT' });
    else assert.equal((await readFile(f.env.TEST_BUILD_RECEIPT, 'utf8')).trim(), 'built');
  });
}
