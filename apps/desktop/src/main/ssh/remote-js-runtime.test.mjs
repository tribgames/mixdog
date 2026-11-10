// The server's JS runtime from the bundle, end to end under a real POSIX sh: the bundle built by
// scripts/stage-js-bundle.mjs is uploaded through `remoteProgramScript`, installed into a version
// directory, its `js-runtime.json` resolves (the rule of mixdogd's js_runtime::resolve), and an
// ext-host worker and a skill launcher start from it. Differences from a real server: the Node is
// this machine's, and `mixdogd server-ensure` is a stand-in that moves `payload/` into the version
// directory like install.rs (whose own test covers that move).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';
import { FrameDecoder, Kind, encodeFrame, encodeJsonFrame } from '../../../../../src/ext-host/frame.mjs';
import { deriveRemoteRoots } from '../../../scripts/remote-js-roots.mjs';
import { buildJsPayload, createBundleArchive } from '../../../scripts/stage-js-bundle.mjs';
import { shellPath } from './remote-fixture.mjs';
import { remoteProgramScript } from './remote-install-program.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const sh = [process.env.MIXDOG_TEST_SH, 'sh', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'].find(
  (candidate) => candidate && spawnSync(candidate, ['-c', 'exit 0']).status === 0
);
const toPosix = (path) => path.replaceAll('\\', '/');

// Stands in for `mixdogd server-ensure`: publish the binary and `payload/` as the version directory.
const serverEnsureStandIn = `#!/bin/sh
here=$(dirname "$0")
dir="$HOME/.mixdog-remote/versions/1.4.6-abc"
mkdir -p "$dir" && cp "$0" "$dir/mixdogd" && mv "$here"/payload/* "$dir"/ || exit 1
printf 'MIXDOG_RESULT {"versionDir":"%s"}\\n' "$dir"
`;

/** What mixdogd's js_runtime::resolve does with the manifest next to the binary. */
function resolveManifest(exe) {
  const dir = dirname(exe);
  const manifest = JSON.parse(readFileSync(join(dir, 'js-runtime.json'), 'utf8'));
  const program = join(dir, manifest.program);
  const packageRoot = join(dir, manifest.packageRoot);
  assert.ok(existsSync(program), program);
  assert.ok(existsSync(join(packageRoot, 'src', 'skill-script-entry.mjs')), packageRoot);
  return { program, packageRoot, electron: manifest.electron };
}

/** Runs `program` through sh, as a launcher would: a file named `node` is not a Windows executable name. */
const run = (program, args, options = {}) =>
  spawn(sh, ['-c', 'exec "$0" "$@"', toPosix(program), ...args.map(toPosix)], options);

test('the bundle installs under a real sh and its js-runtime.json starts an ext-host worker and a skill launcher', { skip: !sh && 'no POSIX sh', timeout: 240_000 }, async () => {
  const work = makeTempDirSync('remote-js-runtime');
  const payloadDir = join(work, 'payload');
  await buildJsPayload({
    key: 'linux-x64',
    payloadDir,
    cacheDir: join(work, 'cache'),
    fetchNode: async () => ({ node: process.execPath, license: join(repoRoot, 'LICENSE'), version: process.version }),
    installModules: async (pkgDir) => mkdirSync(join(pkgDir, 'node_modules'), { recursive: true }),
    // No npm install ran, so no package of the closure is there to record; the two entries started below
    // load none at startup.
    recordClosure: (modulesDir) =>
      writeFileSync(join(modulesDir, 'mixdog-core-closure.json'), `${JSON.stringify({ skippedOptional: [] }, null, 2)}\n`),
    // Only what the two entries started below can load: `npm pack` over the whole package is a real npm run
    // and some 3000 files copied one at a time, which a loaded machine cannot finish within the lane's budget.
    listPackageFiles: async () => [
      'package.json',
      ...deriveRemoteRoots({ packageRootDir: repoRoot, entries: ['src/ext-host/worker.mjs', 'src/skill-script-entry.mjs'] }).reached,
    ],
    packageRootDir: repoRoot,
  });
  const binary = join(work, 'mixdogd');
  writeFileSync(binary, serverEnsureStandIn);
  const out = join(work, 'bundle.tgz');
  const bundle = await createBundleArchive({ binary, payloadDir, out });

  // Upload and install on a throwaway HOME.
  const home = makeTempDirSync('remote-js-runtime-home');
  const script = join(makeTempDirSync('remote-js-runtime-script'), 'script.sh');
  writeFileSync(
    script,
    remoteProgramScript({
      mode: 'ensure',
      installId: '1.4.6-abc',
      version: '1.4.6',
      build: 'abc',
      upload: true,
      sha256: createHash('sha256').update(serverEnsureStandIn).digest('hex'),
      bundleSha256: bundle.sha256,
    })
  );
  const path = shellPath(sh);
  const installed = spawnSync(sh, [toPosix(script)], {
    env: { ...process.env, PATH: path, HOME: toPosix(home) },
    input: readFileSync(out),
    encoding: 'utf8',
  });
  assert.match(installed.stdout, /MIXDOG_RESULT \{"versionDir":"[^"]+1\.4\.6-abc"\}/, installed.stderr);
  const versionDir = join(home, '.mixdog-remote', 'versions', '1.4.6-abc');

  const js = resolveManifest(join(versionDir, 'mixdogd'));
  assert.equal(js.electron, false);

  // The extension-host worker announces itself and answers a call, from the bundled node and package.
  const worker = run(js.program, [join(js.packageRoot, 'src', 'ext-host', 'worker.mjs')], {
    env: { ...process.env, PATH: path },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const decoder = new FrameDecoder();
  const frames = [];
  worker.stdout.on('data', (chunk) => frames.push(...decoder.push(chunk)));
  const until = async (done) => {
    for (let i = 0; i < 400 && !done(); i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.ok(done(), 'timed out waiting for the worker');
  };
  await until(() => frames.some((f) => f.kind === Kind.READY));
  worker.stdin.write(encodeJsonFrame(Kind.CALL, 1, { method: 'no.such.method', params: null, paths: [], thread: 't' }));
  await until(() => frames.some((f) => f.kind === Kind.RESULT && f.id === 1));
  assert.ok(JSON.parse(frames.find((f) => f.kind === Kind.RESULT).body.toString()).err);
  const exited = new Promise((r) => worker.on('exit', r));
  worker.stdin.write(encodeFrame(Kind.BYE, 0));
  assert.equal(await exited, 0);

  // The skill launcher's entry runs a script under the bundled node.
  const skill = join(makeTempDirSync('remote-js-runtime-skill'), 'hello.mjs');
  writeFileSync(skill, `console.log('skill ran', process.argv.slice(2).join(','));\n`);
  const launched = run(js.program, [join(js.packageRoot, 'src', 'skill-script-entry.mjs'), skill, 'a', 'b'], {
    env: { ...process.env, PATH: path },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  launched.stdout.on('data', (chunk) => (stdout += chunk));
  launched.stderr.on('data', (chunk) => (stderr += chunk));
  assert.equal(await new Promise((r) => launched.on('exit', r)), 0, stderr);
  assert.match(stdout, /skill ran a,b/);
});
