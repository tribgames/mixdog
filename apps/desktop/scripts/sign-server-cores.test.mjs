import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';

import { readTarball } from '../../../scripts/check-npm-packages.mjs';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { serverBundleAsset } from '../src/main/ssh/server-manifest.mjs';
import { remoteJsRuntimeManifest } from './core-layout.mjs';
import { signServerCores, startSignedCore } from './sign-server-cores.mjs';
import { HOST_TARGETS, stageCore } from './stage-core.mjs';
import { machO } from './test-macho.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const VERSION = '1.4.6';
const OURS = { authority: 'Developer ID Application: Example (TEAM000001)', team: 'TEAM000001' };
const NODE = {
  authority: 'Developer ID Application: Node.js Foundation (HX7739G8FX)',
  team: 'HX7739G8FX',
  timestamp: true,
  runtime: true,
};
const AD_HOC = { adhoc: true };

/**
 * A run of the producer and a codesign stand-in. Every Mach-O file is made by `program`, which remembers what it is
 * built of by content; a signature is a JSON state the stand-in prints the way `codesign --display` does, and signing
 * builds the same program with the stand-in's own state, as codesign changes nothing but the signature.
 */
async function produced({ ortTeam, timestamped = () => true, tampered = () => false } = {}) {
  const dir = makeTempDirSync('sign-server-cores');
  const parts = new Map();
  const program = (spec) => {
    const bytes = machO({ ...spec, signature: spec.signature && JSON.stringify(spec.signature) });
    parts.set(sha(bytes), spec);
    return bytes;
  };
  const targetDir = join(dir, 'target');
  for (const target of Object.values(HOST_TARGETS)) {
    const exe = target.includes('windows') ? '.exe' : '';
    mkdirSync(join(targetDir, target, 'release'), { recursive: true });
    const core = target.includes('apple')
      ? program({ code: `core for ${target}`, signature: target.startsWith('aarch64') ? AD_HOC : null })
      : `core for ${target}`;
    writeFileSync(join(targetDir, target, 'release', `mixdogd${exe}`), core);
    writeFileSync(join(targetDir, target, 'release', `mixdog-askpass${exe}`), `askpass for ${target}`);
  }
  const buildPayload = async ({ key, payloadDir }) => {
    const [platform, arch] = key.split('-');
    const write = (path, bytes) => {
      mkdirSync(dirname(join(payloadDir, path)), { recursive: true });
      writeFileSync(join(payloadDir, path), bytes);
    };
    const manifest = remoteJsRuntimeManifest(platform, arch);
    write('js-runtime.json', `${JSON.stringify(manifest)}\n`);
    write('js/pkg/node_modules/mixdog/package.json', '{}\n');
    if (platform !== 'darwin') return write('js/node', `node for ${key}`);
    write('js/node', program({ code: `node for ${key}`, signature: NODE }));
    write('js/pkg/node_modules/@img/sharp/sharp.node', program({ code: `sharp for ${key}`, signature: AD_HOC }));
    const vendor = ortTeam && { authority: `Developer ID Application: Other (${ortTeam})`, team: ortTeam };
    if (manifest.ortLibrary)
      write(
        manifest.ortLibrary,
        program({ code: `onnxruntime for ${key}`, signature: vendor && { ...vendor, timestamp: true, runtime: true } })
      );
  };
  await stageCore({
    targetDir,
    runtimeDir: join(dir, 'producer'),
    version: VERSION,
    host: { platform: 'linux', arch: 'x64' },
    buildPayload,
    verifyPayload: async () => {},
    serversOnly: true,
  });

  const signed = [];
  const stateOf = (file) => parts.get(sha(readFileSync(file)))?.signature ?? null;
  const unsigned = { status: 1, output: 'code object is not signed at all\n' };
  const codesign = (args) => {
    const file = args.at(-1);
    const state = stateOf(file);
    if (args[0] === '--verify') return state ? { status: 0, output: '' } : unsigned;
    if (args[0] === '--display') {
      if (!state) return unsigned;
      const lines = state.adhoc
        ? [
            'Signature=adhoc',
            'CodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0',
            'TeamIdentifier=not set',
          ]
        : [
            `CodeDirectory v=20500 size=1 flags=${state.runtime ? '0x10000(runtime)' : '0x0(none)'} hashes=1+7`,
            `Authority=${state.authority}`,
            'Authority=Developer ID Certification Authority',
            'Authority=Apple Root CA',
            state.timestamp ? 'Timestamp=Nov 28, 2026 at 5:20:51 AM' : 'Signed Time=Nov 28, 2026 at 5:20:51 AM',
            `TeamIdentifier=${state.team}`,
          ];
      return { status: 0, output: `Executable=${file}\n${lines.join('\n')}\n` };
    }
    const spec = parts.get(sha(readFileSync(file)));
    const at = args.indexOf('--entitlements');
    signed.push({
      path: relative(join(dir, 'signed.work'), file).replaceAll('\\', '/'),
      entitlements: at < 0 ? null : readFileSync(args[at + 1], 'utf8'),
    });
    const signature = {
      ...OURS,
      timestamp: args.includes('--timestamp') && timestamped(file),
      runtime: args.join(' ').includes('--options runtime'),
    };
    writeFileSync(file, program({ ...spec, code: tampered(file) ? `${spec.code}!` : spec.code, signature }));
    return { status: 0, output: '' };
  };
  const sign = () =>
    signServerCores({
      source: join(dir, 'producer', 'server-cores'),
      out: join(dir, 'signed'),
      identity: 'IDENTITY',
      codesign,
      verifyPayload: async () => {},
    });
  const start = (reportedVersion) =>
    startSignedCore({ serverCores: join(dir, 'signed'), host: { platform: 'darwin', arch: 'arm64' }, reportedVersion });
  const adopt = () =>
    stageCore({
      targetDir,
      runtimeDir: join(dir, 'packager'),
      version: VERSION,
      host: { platform: 'win32', arch: 'x64' },
      reportedVersion: () => VERSION,
      buildPayload: async () => assert.fail('nothing is rebuilt'),
      verifyPayload: async () => assert.fail('nothing is rebuilt'),
      prebuiltServerCores: join(dir, 'signed'),
    });
  const signatureIn = (bytes) => parts.get(sha(bytes))?.signature ?? null;
  return { dir, targetDir, program, signatureIn, signed, sign, start, adopt };
}

test('every Mach-O file of the macOS bundles is notarizable, and each package takes them for its own builds', async () => {
  const run = await produced();
  await run.sign();
  // Every package adopts the signed set against the unsigned cores it built itself.
  await run.adopt();
  for (const key of ['linux-x64', 'linux-arm64'])
    assert.deepEqual(
      readFileSync(join(run.dir, 'signed', serverBundleAsset(key))),
      readFileSync(join(run.dir, 'producer', 'server-cores', serverBundleAsset(key)))
    );
  for (const key of ['darwin-x64', 'darwin-arm64']) {
    const files = readTarball(join(run.dir, 'signed', serverBundleAsset(key)));
    for (const { path, data } of files.filter((file) => run.signatureIn(file.data))) {
      const signature = run.signatureIn(data);
      assert.match(signature.authority, /^Developer ID Application: /, path);
      assert.ok(signature.timestamp && signature.runtime, path);
    }
    // The pinned Node keeps its vendor's signature, and with it the entitlements V8 needs.
    assert.deepEqual(run.signatureIn(files.find((file) => file.path === 'payload/js/node').data), NODE);
  }
  assert.deepEqual(run.signed.map(({ path }) => path).sort(), [
    'darwin-arm64/mixdogd',
    'darwin-arm64/payload/js/pkg/node_modules/@img/sharp/sharp.node',
    'darwin-arm64/payload/js/pkg/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib',
    'darwin-x64/mixdogd',
    'darwin-x64/payload/js/pkg/node_modules/@img/sharp/sharp.node',
  ]);
  // The core's PCRE2 search JIT-compiles patterns, which the hardened runtime allows only with this entitlement.
  for (const { path, entitlements } of run.signed)
    if (path.endsWith('/mixdogd')) assert.match(entitlements, /<key>com\.apple\.security\.cs\.allow-jit<\/key>/);
    else assert.equal(entitlements, null, path);
  // Apart from the signing, the core of the runner's platform starts as its bundle ships it.
  const started = [];
  const startedVersion = (file) => {
    started.push(run.signatureIn(readFileSync(file))?.team);
    return VERSION;
  };
  assert.equal(await run.start(startedVersion), 'darwin-arm64');
  assert.deepEqual(started, [OURS.team], 'the program started is the signed core');
  await assert.rejects(
    run.start(() => '1.4.5'),
    /darwin-arm64: the signed mixdogd reports version 1\.4\.5, the release is 1\.4\.6/
  );

  // A signed core is no proof of another build: the package built other code for the target.
  const otherBuild = run.program({ code: 'another core' });
  writeFileSync(join(run.targetDir, 'aarch64-apple-darwin', 'release', 'mixdogd'), otherBuild);
  await assert.rejects(
    run.adopt(),
    /darwin-arm64: the bundled mixdogd is not the mixdogd built for aarch64-apple-darwin/
  );
});

test('a bundle is refused when signing leaves a file unnotarizable, alters the core or its library unloadable', async () => {
  const untimed = await produced({ timestamped: (file) => !file.endsWith('sharp.node') });
  await assert.rejects(
    untimed.sign(),
    /darwin-x64: the signed bundle is refused:\n- payload\/js\/pkg\/node_modules\/@img\/sharp\/sharp\.node has no valid Developer ID signature/
  );
  const tampered = await produced({ tampered: (file) => file.endsWith('mixdogd') });
  await assert.rejects(tampered.sign(), /codesign changed more of mixdogd than its signature/);
  const foreign = await produced({ ortTeam: 'OTHER00001' });
  await assert.rejects(
    foreign.sign(),
    /darwin-arm64: [\s\S]*libonnxruntime\.1\.dylib, which mixdogd loads, is not signed by its team TEAM000001/
  );
});
