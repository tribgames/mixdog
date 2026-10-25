import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { childEnvironment } from './child-environment.ts';
import { nativeBrowserImporterPath, resolvePackagedBrowserImporter } from './browser/profile-import-native.ts';

test('daemon-owned desktop children never inherit service identity', () => {
  const source = {
    PATH: 'C:\\Windows',
    NODE_ENV: 'production',
    MIXDOG_ROOT: 'C:\\runtime.asar',
    MIXDOG_DAEMON_HOST: '1',
    MIXDOG_WORKER_MODE: '1',
    MIXDOG_DAEMON_SPAWNED_FOR: 'session',
    MIXDOG_SUPERVISOR_PID: '1234',
  };
  const env = childEnvironment({ CUSTOM_CHILD_VALUE: 'kept' }, source);
  assert.equal(env.PATH, source.PATH);
  assert.equal(env.CUSTOM_CHILD_VALUE, 'kept');
  for (const key of Object.keys(source).filter((key) => key !== 'PATH')) {
    assert.equal(env[key], undefined, `${key} must not cross the service child boundary`);
  }
  assert.equal(source.MIXDOG_DAEMON_HOST, '1', 'the source environment is immutable');
});

test('browser password import trusts only the packaged native-tools importer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-browser-import-trust-'));
  try {
    const resourcesPath = join(root, 'resources');
    const nativeTools = join(resourcesPath, 'native-tools');
    const expected = nativeBrowserImporterPath({
      isPackaged: true,
      platform: 'win32',
      resourcesPath,
      cwd: join(root, 'source'),
    });
    const foreign = join(root, 'foreign', 'mixdog-browser-import.exe');
    const environment = {
      isPackaged: true,
      platform: 'win32',
      resourcesPath,
      requestedPath: expected,
    };
    assert.equal(
      await resolvePackagedBrowserImporter({
        ...environment,
        isPackaged: false,
      }),
      undefined
    );
    assert.equal(
      await resolvePackagedBrowserImporter({
        ...environment,
        platform: 'linux',
      }),
      undefined
    );
    assert.equal(
      await resolvePackagedBrowserImporter({
        ...environment,
        requestedPath: foreign,
      }),
      undefined
    );
    assert.equal(await resolvePackagedBrowserImporter(environment), undefined);

    await mkdir(nativeTools, { recursive: true });
    const unsignedFixture = Buffer.from('unsigned browser importer fixture');
    await writeFile(expected, unsignedFixture);
    assert.equal(await resolvePackagedBrowserImporter(environment), undefined);
    await writeFile(join(nativeTools, 'bitwarden_chromium_import_helper.exe'), 'unsigned helper fixture');

    const accepted = await resolvePackagedBrowserImporter(environment);
    assert.deepEqual(accepted, {
      executable: expected,
      sha256: createHash('sha256').update(unsignedFixture).digest('hex'),
    });
    assert.equal(
      nativeBrowserImporterPath({
        isPackaged: false,
        platform: 'win32',
        resourcesPath,
        cwd: join(root, 'source'),
      }),
      join(root, 'source', 'native', 'mixdog-browser-import', 'target', 'release', 'mixdog-browser-import.exe')
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The policy strings live inline in the window bootstrap, so this is the one place
// that guards the injection boundary: dev tooling never loosens the packaged policy.
test('development CSP supports Vite refresh without weakening production scripts', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const policies = [...main.matchAll(/`(default-src [^`]+)`/g)].map((match) => match[1]);
  const development = policies.find((policy) => policy.includes("'unsafe-eval'"));
  const production = policies.find((policy) => !policy.includes("'unsafe-eval'"));
  assert.match(development || '', /script-src 'self' 'unsafe-eval' 'unsafe-inline'/);
  assert.equal(production?.match(/script-src[^;]*/)?.[0], "script-src 'self'");
});

// Packaging wiring has no runtime test short of building the installer (the live artifact
// test only checks that out/preload/index.js exists), so each contract keeps its key line.
const text = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('packaged preload path matches electron-vite output', async () => {
  assert.match(await text('./index.ts'), /preload:\s*join\(import\.meta\.dirname,\s*'\.\.\/preload\/index\.js'\)/);
  assert.match(await text('../../electron.vite.config.ts'), /format:\s*'cjs'/);
});

test('renderer bridge cannot dispose the singleton service client', async () => {
  assert.doesNotMatch(await text('../preload/index.ts'), /DESKTOP_IPC\.dispose/);
});

test('packaged Markdown worker resolves DOM-dependent parsers through worker-safe entries', async () => {
  assert.ok((await text('../../electron.vite.config.ts')).includes('find: /^hast-util-from-html-isomorphic$/'));
});

test('a closed stdio pipe cannot crash the main process', async () => {
  assert.match(await text('./index.ts'), /\[process\.stdout, process\.stderr\][\s\S]{0,120}?on\?\.\('error'/);
});

test('Windows Crashpad starts locally, before the single-instance lock', async () => {
  const main = await text('./index.ts');
  const profile = main.indexOf('const PACKAGED_USER_DATA_DIRECTORY');
  const reporter = main.indexOf('crashReporter.start(');
  const lock = main.indexOf('app.requestSingleInstanceLock()');
  assert.ok(profile >= 0 && profile < reporter, 'the user-data directory is configured before Crashpad starts');
  assert.ok(reporter > 0 && reporter < lock);
  assert.match(main.slice(reporter, lock), /uploadToServer:\s*false/);
});

test('production desktop attaches through the packaged daemon, unpacked from the archive', async () => {
  assert.match(await text('./index.ts'), /daemon\.cjs/);
  assert.match(await text('../../electron-builder.yml'), /asarUnpack:[\s\S]*out\/main\/daemon\.cjs/);
});

test('FastDirect staging ships the PTY package unpacked beside the archive', async () => {
  assert.match(
    await text('../../scripts/dev-fast-direct.mjs'),
    /const ptyPackageSegments = \['node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'\];/
  );
});

test('Windows installer is one-click, per-user, and registers the mixdog deep link', async () => {
  const builder = await text('../../electron-builder.yml');
  assert.match(builder, /oneClick:\s*true/);
  assert.match(builder, /perMachine:\s*false/);
  assert.match(builder, /protocols:\s+name:\s*Mixdog\s+schemes:\s+-\s*mixdog/);
});

test('the capture harness stays out of the production entry and the package', async () => {
  assert.doesNotMatch(await text('./index.ts'), /desktopCapturer|captureProductionWindow|MIXDOG_DESKTOP_CAPTURE_PATH/);
  assert.match(await text('../../electron-builder.yml'), /!out\/main\/capture-window\.js/);
});

test('runtime preparation reads back the architecture of every native artifact it packages', async () => {
  const preparation = await text('../../scripts/prepare-runtime.mjs');
  assert.match(preparation, /assertTargetArchitecture\(destination,\s*`Native tool \$\{kind\}`\)/);
  assert.match(preparation, /assertTreeTargetArchitecture\(\s*await desktopPtyNativeRoot\(\)/);
  assert.match(preparation, /assertTargetArchitecture\(source,\s*`Runtime addon \$\{entry\}`\)/);
});

test('packaged runtime verification runs the app binary as Node with the caller environment', async () => {
  const verifier = await text('../../scripts/verify-packaged-runtime.mjs');
  assert.match(verifier, /ELECTRON_RUN_AS_NODE:\s*'1'/);
  assert.match(verifier, /env:\s*\{\s*\.\.\.process\.env,/);
});

test('desktop package does not declare the repository as a dependency', async () => {
  const packageJson = JSON.parse(await text('../../package.json'));
  assert.equal(packageJson.dependencies.mixdog, undefined);
});

test('production shell persists window state through the main process', async () => {
  assert.match(await text('./index.ts'), /persistWindowState\(window,\s*statePath\)/);
});
