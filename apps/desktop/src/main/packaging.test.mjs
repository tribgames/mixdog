import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { childEnvironment } from './child-environment.ts';
import {
  nativeBrowserImporterPath,
  resolvePackagedBrowserImporter,
} from './browser/profile-import-native.ts';

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

test('packaged preload path matches electron-vite output', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const vite = await readFile(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8');
  assert.match(main, /preload:\s*join\(__dirname,\s*'\.\.\/preload\/index\.js'\)/);
  assert.match(vite, /format:\s*'cjs'/);
  assert.match(vite, /entryFileNames:\s*'index\.js'/);
});

test('renderer bridge cannot dispose the singleton service client', async () => {
  const [contract, preload, ipc, remote] = await Promise.all([
    readFile(new URL('../shared/contract.ts', import.meta.url), 'utf8'),
    readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('./ipc.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/remote-shim.ts', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(contract, /dispose:\s*'mixdog:dispose'/);
  assert.doesNotMatch(preload, /DESKTOP_IPC\.dispose/);
  assert.doesNotMatch(ipc, /DESKTOP_IPC\.dispose/);
  assert.doesNotMatch(remote, /\bdispose:\s*\(\)\s*=>\s*Promise\.resolve/);
});

test('packaged Markdown worker resolves DOM-dependent parsers through worker-safe entries', async () => {
  const vite = await readFile(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8');
  const client = await readFile(new URL('../renderer/markdown-worker-client.ts', import.meta.url), 'utf8');
  assert.ok(vite.includes('find: /^hast-util-from-html-isomorphic$/'));
  assert.ok(vite.includes("'node_modules/hast-util-from-html-isomorphic/index.js'"));
  assert.match(client, /event\.preventDefault\?\.\(\)/,
    'fatal worker startup errors must not also surface as repeating window errors');
  assert.match(client, /markdownWorkerFailure/,
    'a fatal worker startup error must not recreate the same broken worker every publication');
});

test('a closed stdio pipe cannot crash the main process', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  // EPIPE from a launcher that already exited must never reach Electron's
  // fatal main-process dialog.
  assert.match(main, /\[process\.stdout, process\.stderr\][\s\S]{0,120}?on\?\.\('error'/);
});

test('Windows Crashpad starts locally before any renderer can be created', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const profileConfiguredAt = main.indexOf('const PACKAGED_USER_DATA_DIRECTORY');
  const reporterStartedAt = main.indexOf('crashReporter.start(');
  const instanceLockAt = main.indexOf('app.requestSingleInstanceLock()');
  assert.ok(profileConfiguredAt >= 0 && profileConfiguredAt < reporterStartedAt);
  assert.ok(reporterStartedAt < instanceLockAt);
  assert.match(main.slice(reporterStartedAt, instanceLockAt), /uploadToServer:\s*false/);
});

test('production desktop uses only the packaged daemon service adapter', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const service = await readFile(new URL('./desktop-service.ts', import.meta.url), 'utf8');
  const ipc = await readFile(new URL('./ipc.ts', import.meta.url), 'utf8');
  const vite = await readFile(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8');
  const builder = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  const daemonBuild = await readFile(new URL('../../scripts/build-daemon.mjs', import.meta.url), 'utf8');
  const runtimePreparation = await readFile(
    new URL('../../scripts/prepare-runtime.mjs', import.meta.url),
    'utf8',
  );
  assert.equal(packageJson.scripts.start, 'npm run build && electron-vite preview --skipBuild');
  assert.doesNotMatch(vite, /'desktop-service':/);
  assert.match(daemonBuild, /src['"],\s*['"]main['"],\s*['"]desktop-service\.ts/);
  assert.match(main, /new SessionTransport\(/);
  assert.match(main, /daemon\.cjs/);
  assert.match(main, /app\.asar\.unpacked/);
  assert.match(main, /moduleUrl\.searchParams\.set\('build', artifact\)/);
  assert.doesNotMatch(vite, /engine-worker/);
  assert.doesNotMatch(vite, /terminal-worker/);
  assert.doesNotMatch(main, /startRemoteRelay|rotatePairingToken|rotateRemoteDevice/);
  assert.doesNotMatch(
    main.slice(main.indexOf('registerDesktopIpc('), main.indexOf("diagnostics?.write('window-created'")),
    /\bsettingsStore\b/,
    'product IPC settings use the daemon operation service',
  );
  assert.doesNotMatch(service, /startRemoteBridge|resolveRemoteBridgePort|remoteBridge/);
  assert.match(service, /startRemoteRelay/);
  assert.doesNotMatch(ipc, /import \* as .* from ['"]electron['"]/);
  assert.doesNotMatch(ipc, /from ['"]\.\/window-options['"];/);
  assert.match(builder, /files:\s+-\s*out\/\*\*/);
  assert.match(builder, /asarUnpack:[\s\S]*out\/main\/daemon\.cjs/);
  assert.match(builder, /asarUnpack:[\s\S]*out\/renderer\/\*\*/);
  assert.match(
    builder,
    /asarUnpack:[\s\S]*node_modules\/@homebridge\/node-pty-prebuilt-multiarch\/\*\*/,
  );
  assert.match(
    builder,
    /from:\s*\.runtime\/desktop-node-pty\s+to:\s*app\.asar\.unpacked\/node_modules\/@homebridge\/node-pty-prebuilt-multiarch/,
  );
  assert.match(runtimePreparation, /desktop-node-pty/);
  assert.match(
    runtimePreparation,
    /join\(\s*builderDesktopPtyDir,\s*'prebuilds',\s*`\$\{embeddingTarget\.platform\}-\$\{embeddingTarget\.arch\}`/,
    'Linux PTY validation must follow the package loader into its target prebuild directory',
  );
  assert.match(
    runtimePreparation,
    /join\(builderDesktopPtyDir, 'build', 'Release'\)/,
    'compiled PTY targets must retain their active build/Release fallback',
  );
  assert.match(builder, /from:\s*\.runtime\/native-tools\s+to:\s*native-tools/);
  assert.match(main, /kind:\s*'graph',\s*names:\s*\['MIXDOG_GRAPH_BIN',\s*'MIXDOG_SEARCH_SERVER_BIN'\]/);
  assert.match(main, /kind:\s*'spawn',\s*names:\s*\['MIXDOG_SPAWN_SERVER_BIN'\]/);
});

test('FastDirect staging ships the PTY package unpacked beside the archive', async () => {
  const fastDirect = await readFile(
    new URL('../../scripts/dev-fast-direct.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    fastDirect,
    /const ptyPackageSegments = \['node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'\];/,
  );
  assert.match(fastDirect, /rm\(join\(stagingRoot, \.\.\.ptyPackageSegments\)/);
  assert.match(
    fastDirect,
    /join\(artifactResources, 'app\.asar\.unpacked', \.\.\.ptyPackageSegments\)/,
  );
  assert.match(fastDirect, /'build', 'Release', 'pty\.node'/);
});

test('plain Node can import the standalone daemon service artifact', async () => {
  const serviceUrl = new URL('../../out/main/daemon.cjs', import.meta.url);
  const source = await readFile(serviceUrl, 'utf8');
  assert.doesNotMatch(source, /(?:from\s+|import\s*\()\s*["']electron["']/);
  const service = await import(`${serviceUrl.href}?packaging-test=${Date.now()}`);
  assert.equal(typeof service.createDesktopService, 'function');
});

test('browser password import uses only packaged native-tools without a certificate dependency', async () => {
  const importer = await readFile(new URL('./browser/profile-import.ts', import.meta.url), 'utf8');
  const builder = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  const runtimePreparation = await readFile(
    new URL('../../scripts/prepare-runtime.mjs', import.meta.url),
    'utf8',
  );
  const nativeBuild = await readFile(
    new URL('../../../../native/mixdog-browser-import/build.ps1', import.meta.url),
    'utf8',
  );
  const chromeClose = importer
    .slice(importer.indexOf('export async function prepareChromeForImport('))
    .split('async function sha256File')[0];
  const nativeTransport = importer
    .slice(importer.indexOf('async function readEncryptedChildJson('))
    .split('export class BrowserProfileImportService')[0];
  assert.match(builder, /from:\s*\.runtime\/native-tools\s+to:\s*native-tools/);
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
    assert.equal(await resolvePackagedBrowserImporter({
      ...environment,
      isPackaged: false,
    }), undefined);
    assert.equal(await resolvePackagedBrowserImporter({
      ...environment,
      platform: 'linux',
    }), undefined);
    assert.equal(await resolvePackagedBrowserImporter({
      ...environment,
      requestedPath: foreign,
    }), undefined);
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
      join(
        root,
        'source',
        'native',
        'mixdog-browser-import',
        'target',
        'release',
        'mixdog-browser-import.exe',
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.match(nativeTransport, /stdio:\s*\['pipe',\s*'pipe',\s*'pipe'\]/);
  assert.ok(
    nativeTransport.indexOf('const exitCodePromise = new Promise<number>')
      < nativeTransport.indexOf("child.stdin?.end(transportKey.toString('base64'))"),
    'the native child exit listener must be attached before stdin can trigger a fast exit',
  );
  assert.match(nativeTransport, /const exitCode = await exitCodePromise/);
  assert.match(nativeTransport, /createDecipheriv\('aes-256-gcm'/);
  assert.match(nativeTransport, /transportKey\.fill\(0\)/);
  assert.doesNotMatch(nativeTransport, /return JSON\.parse\(Buffer\.concat\(stdout\)/);
  assert.match(chromeClose, /PostMessage\(hwnd,\s*0x0010/);
  assert.doesNotMatch(chromeClose, /taskkill|\/F/);
  assert.match(runtimePreparation, /MIXDOG_BROWSER_IMPORT_NATIVE_DIR/);
  assert.match(runtimePreparation, /prepareBrowserImportNativeSource/);
  assert.match(runtimePreparation, /'Release'/);
  assert.doesNotMatch(
    runtimePreparation,
    /MIXDOG_BROWSER_IMPORT_SIGNER_SHA256|assertBrowserImportAuthenticode|Get-AuthenticodeSignature/,
  );
  assert.match(
    nativeBuild,
    /\$signatureValidationEnabled = 'pub const ENABLE_SIGNATURE_VALIDATION: bool = true;'[\s\S]*\$signatureValidationDisabled = 'pub const ENABLE_SIGNATURE_VALIDATION: bool = false;'[\s\S]*\$config\.Replace\(\s*\$signatureValidationEnabled,\s*\$signatureValidationDisabled\s*\)/,
  );
  assert.doesNotMatch(
    nativeBuild,
    /\.Replace\(\s*'pub const ENABLE_SIGNATURE_VALIDATION: bool = false;',\s*'pub const ENABLE_SIGNATURE_VALIDATION: bool = false;'/,
  );
  assert.doesNotMatch(
    nativeBuild,
    /MIXDOG_BROWSER_IMPORT_SIGNER_SHA256|MIXDOG_CODE_SIGN|Get-AuthenticodeSignature|signtool/,
  );
  assert.match(nativeBuild, /LICENSE_GPL\.txt/);
});

test('Windows installer is one-click, per-user, and registers Mixdog deep links', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const builder = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  const installer = await readFile(new URL('../../build/installer.nsh', import.meta.url), 'utf8');
  const progressDriver = await readFile(new URL('../../build/progress-driver.ps1', import.meta.url), 'utf8');
  const iconGenerator = await readFile(new URL('../../scripts/generate-brand-icons.mjs', import.meta.url), 'utf8');
  const devUpdate = await readFile(new URL('../../scripts/dev-update-windows.ps1', import.meta.url), 'utf8');
  const fastSnapshot = await readFile(new URL('../../scripts/dev-fast-snapshot.ps1', import.meta.url), 'utf8');
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(builder, /protocols:\s+name:\s*Mixdog\s+schemes:\s+-\s*mixdog/);
  assert.match(packageJson.scripts['build:win'],
    /electron-builder --win --x64 --publish never && npm run verify:update-metadata$/);
  assert.match(packageJson.scripts['update:dev'], /dev-update-windows\.ps1 -ViaUpdater$/);
  // The local deploy goes through the snapshot wrapper so a concurrent edit
  // cannot invalidate the build, and the wrapper still runs the same FastDirect
  // install from the frozen worktree.
  assert.match(packageJson.scripts['update:dev:fast'], /dev-fast-snapshot\.ps1$/);
  assert.match(fastSnapshot, /'apps\\desktop\\scripts\\dev-update-windows\.ps1'/);
  assert.match(fastSnapshot, /\$arguments = @\(\s*'-FastDirect',/);
  assert.match(fastSnapshot, /sparse-checkout set --cone/);
  assert.match(fastSnapshot, /MIXDOG_RUNTIME_DEPENDENCY_CACHE/);
  assert.match(fastSnapshot, /MIXDOG_FASTDIRECT_SNAPSHOT_TIMINGS/);
  assert.match(packageJson.scripts['update:dev:reinstall'], /dev-update-windows\.ps1$/);
  assert.match(packageJson.scripts['update:dev:plan'], /dev-update-windows\.ps1 -ViaUpdater -DryRun$/);
  assert.match(
    devUpdate,
    /Start-Process -FilePath \$npx[\s\S]*'electron-builder', '--dir', '--win', '--x64', '--publish', 'never'/,
  );
  assert.match(devUpdate,
    /installedUpdateMetadata[\s\S]*Copy-Item[\s\S]*verify-update-metadata\.mjs/);
  assert.match(devUpdate, /fast deploy failed; restoring the previous installation/);
  assert.match(
    devUpdate,
    /Prepared FastDirect runtime is missing:[\s\S]*Backup-InstalledArtifact \$installedFastRuntime 'fast-runtime'[\s\S]*Install-PreparedArtifact \$fastRuntime \$installedFastRuntime/,
  );
  assert.match(
    devUpdate,
    /if \(\$Plan\.full\)[\s\S]*preparing production runtime\.asar for the complete fallback[\s\S]*--mode=fast-full/,
  );
  assert.match(devUpdate, /FastDirectWorker/);
  assert.match(devUpdate, /elapsedMs[\s\S]*timeline/);
  assert.match(devUpdate, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(devUpdate, /-WindowStyle Hidden/);
  assert.match(devUpdate, /function Start-DetachedMixdogApp/);
  assert.match(devUpdate, /explorer\.exe/);
  assert.doesNotMatch(devUpdate, /mixdog-graph\.node|Install-LocalGraphAddon|build-graph-addon/);
  assert.doesNotMatch(main, /MIXDOG_SEARCH_SERVER_ADDON/);
  assert.match(devUpdate, /Wait-ForFreshDaemon[\s\S]*DetachedRelaunch/);
  assert.match(devUpdate, /fast deploy handed to detached worker/);
  assert.match(devUpdate, /Stop-InstalledMixdogProcess/);
  assert.match(devUpdate, /Leaving the\s+# installation directory itself in place/);
  assert.match(builder, /oneClick:\s*true/);
  assert.match(builder, /perMachine:\s*false/);
  assert.match(builder, /createDesktopShortcut:\s*always/);
  // Prebuilt natives are mirrored by prepare-runtime.mjs; a node-gyp rebuild
  // against Electron headers is both unnecessary and toolchain-fragile.
  assert.match(builder, /npmRebuild:\s*false/);
  assert.match(builder, /nodeGypRebuild:\s*false/);
  assert.doesNotMatch(
    builder,
    /(?:allowToChangeInstallationDirectory|runAfterFinish|shortcutName|uninstallDisplayName|createStartMenuShortcut|uninstallerIcon|include):/,
  );
  assert.match(builder, /win:[\s\S]*icon:\s*build\/mixdog\.ico/);
  assert.match(builder, /extraResources:[\s\S]*from:\s*build\/mixdog\.ico\s+to:\s*mixdog\.ico/);
  assert.match(builder, /installerIcon:\s*build\/mixdog\.ico/);
  assert.match(builder, /installerHeaderIcon:\s*build\/mixdog\.ico/);
  assert.match(main, /app\.isPackaged \? \[join\(process\.resourcesPath,\s*'mixdog\.ico'\)\]/);
  assert.doesNotMatch(builder, /script:/);
  assert.match(iconGenerator, /writeFile\(`\$\{buildDir\}\/mixdog\.ico`/);
  assert.match(iconGenerator, /writeFile\(`\$\{buildDir\}\/mixdog\.png`/);
  assert.match(installer, /CreateWindowExW[\s\S]*msctls_progress32/);
  assert.match(installer,
    /wscript\.exe[\s\S]*progress-driver\.vbs[\s\S]*progress-driver\.ps1[\s\S]*"\$MixdogProgressParent" "\$MixdogProgressStock" "\$MixdogProgressBar"/);
  assert.match(installer, /Function MixdogInstFilesPre[\s\S]*SetLayeredWindowAttributes[\s\S]*ShowWindow \$HWNDPARENT 0/);
  assert.match(installer, /!macro customInstall\s+Call MixdogProgressComplete/);
  assert.match(installer, /GetDlgItem \$MixdogProgressStock \$0 1004/);
  assert.match(installer, /SetWindowPos[\s\S]*-32000[\s\S]*-32000/);
  assert.doesNotMatch(installer, /progress-overlay|System\.Windows\.Forms|MixdogInstallerProgressOverlay/);
  assert.match(progressDriver, /FindProgress\(\$installer,\s*1001\)/);
  assert.match(progressDriver, /GetWindowRect\(\$source/);
  assert.match(progressDriver, /SetLayeredWindowAttributes\(\$installer,\s*0,\s*255,\s*2\)/);
  assert.match(progressDriver, /GetProp\(\$progress,\s*'MixdogProgressComplete'\)/);
  assert.doesNotMatch(progressDriver, /System\.Windows\.Forms|CreateWindowEx|SetParent/);
  assert.match(devUpdate, /function Wait-ForVisibleAppWindow[\s\S]*MainWindowHandle/);
  assert.match(devUpdate, /activating the installed app window[\s\S]*Wait-ForVisibleAppWindow -TimeoutSeconds 30/);
  await assert.rejects(
    access(new URL('../../build/progress-overlay.ps1', import.meta.url)),
    (error) => error?.code === 'ENOENT',
  );
  const icon = await readFile(new URL('../../build/mixdog.ico', import.meta.url));
  assert.deepEqual([...icon.subarray(0, 4)], [0, 0, 1, 0]);
});

test('production entry has no capture side effects and capture harness is excluded', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const capture = (await Promise.all(['./capture-assertions.ts', './capture-host.ts', './capture-window.ts'].map((path) => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
  const adapter = await readFile(new URL('../renderer/capture-ui.mjs', import.meta.url), 'utf8');
  const options = await readFile(new URL('./window-options.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const builder = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /desktopCapturer|captureProductionWindow|MIXDOG_DESKTOP_CAPTURE_PATH|app\.exit/);
  assert.match(main, /DESKTOP_WINDOW_OPTIONS/);
  assert.match(capture, /DESKTOP_WINDOW_OPTIONS/);
  assert.match(capture, /webContents\.capturePage/);
  assert.doesNotMatch(capture, /desktopCapturer\.getSources/);
  assert.doesNotMatch(capture, /disableHardwareAcceleration/);
  assert.match(capture, /schemaVersion\s*=\s*1/);
  assert.match(capture, /Capture ID is required/);
  assert.match(capture, /refusing to resize evidence/);
  assert.doesNotMatch(capture, /thumbnail\.resize/);
  assert.match(capture, /measureSidebarGeometry/);
  assert.match(capture, /method:\s*'horizontal-pixel-scan'/);
  assert.match(capture, /class CaptureService implements DesktopService/);
  assert.match(capture, /SETTINGS_CATEGORIES/);
  assert.doesNotMatch(capture, /railButtonCount\s*!==\s*14|railButtonCount,\s*14/);
  assert.match(capture, /async listSessions\(\): Promise<DesktopSessionSummary\[]>/);
  assert.match(capture, /new CaptureService/);
  assert.match(capture, /registerDesktopIpc\(window,\s*host,\s*\{[\s\S]*?app,[\s\S]*?ipcMain,[\s\S]*?dialog,[\s\S]*?shell,[\s\S]*?updater:/);
  assert.match(capture, /console-message/);
  assert.match(capture, /Capture renderer preload bridge is missing/);
  assert.match(capture, /\.inline-error,\s*\[role="alert"\]/);
  assert.ok(
    capture.indexOf('desktopCapturer.getSources') < capture.indexOf('const rendererState ='),
    'renderer validation must follow the desktopCapturer capture.',
  );
  const validationBoundaryStart = capture.indexOf('function validateAndDestroyRenderer');
  const validationBoundaryEnd = capture.indexOf('const CAPTURE_SETTINGS_VALUES');
  const validationBoundary = capture.slice(validationBoundaryStart, validationBoundaryEnd);
  const validationCall = capture.indexOf('const rendererValidation = validateAndDestroyRenderer');
  const pixelWork = capture.indexOf('const pixel = imageReader', validationCall);
  const pngEncoding = capture.indexOf('const png = image.toPNG()', validationCall);
  const metadataWork = capture.indexOf('const metadata =', validationCall);
  const artifactWrite = capture.indexOf('mkdirSync', validationCall);
  assert.ok(
    capture.indexOf('const nativeWindow = {') < capture.indexOf('const rendererState ='),
    'BrowserWindow metadata must be collected before final renderer validation.',
  );
  assert.ok(
    validationCall < pixelWork && pixelWork < pngEncoding && pngEncoding < metadataWork
      && metadataWork < artifactWrite,
    'encoding, metadata, and artifact writes must follow renderer validation and destruction.',
  );
  assert.doesNotMatch(validationBoundary, /\bawait\b/);
  assert.ok(
    validationBoundary.indexOf('destroyCaptureWindow(window);') < validationBoundary.indexOf('return {'),
    'the validation boundary must destroy the renderer before returning zero-error metadata.',
  );
  assert.match(capture, /Capture renderer window is still live before artifact writes/);
  assert.match(capture, /if \(!window\.isDestroyed\(\)\) window\.destroy\(\);/);
  assert.doesNotMatch(capture, /productionEquivalent/);
  assert.match(capture, /rendererAssets:\s*'built'/);
  assert.match(capture, /packaged:\s*app\.isPackaged/);
  assert.match(capture, /host:\s*'CaptureService'/);
  assert.match(capture, /sessionMode:\s*'empty-session'/);
  assert.match(capture, /removeIpc\(\)/);
  // Dispose is bounded: engine teardown may hang 30s+, so the capture exit
  // path races it against a short grace instead of awaiting it bare.
  assert.match(capture, /await Promise\.race\(\[\s*host\.dispose\(\),/);
  assert.match(options, /Object\.freeze/);
  assert.match(options, /DESKTOP_BACKGROUND_COLOR\s*=\s*'#151518'/);
  assert.match(options, /DESKTOP_LIGHT_BACKGROUND_COLOR\s*=\s*'#f0f0f0'/);
  assert.match(options, /DESKTOP_TITLEBAR_HEIGHT\s*=\s*35/);
  assert.match(options, /color:\s*'#00000000'/);
  assert.match(options, /backgroundColor:\s*DESKTOP_BACKGROUND_COLOR/);
  assert.match(options, /symbolColor:\s*light\s*\?\s*'black'\s*:\s*'white'/);
  assert.match(options, /Math\.max\(DESKTOP_TITLEBAR_HEIGHT,\s*Math\.round\(DESKTOP_TITLEBAR_HEIGHT \* zoom\)\)/);
  assert.match(options, /titleBarStyle:\s*'hidden'/);
  assert.match(options, /frame:\s*true/);
  assert.match(adapter, /out\/main\/capture-window\.js/);
  assert.doesNotMatch(adapter, /out\/main\/index\.js|MIXDOG_DESKTOP_CAPTURE_PATH/);
  assert.match(adapter, /rm\(windowOutput,\s*\{\s*force:\s*true\s*\}\)/);
  assert.match(adapter, /Capture timed out/);
  assert.match(adapter, /sweepStaleCaptureProfiles/);
  assert.match(adapter, /capture-owner\.json/);
  assert.match(adapter, /stopCapturePostgresSync\(userData\)/);
  assert.match(adapter, /await killCaptureTree\(child\)/);
  assert.ok(
    adapter.indexOf('stopCapturePostgresSync(userData);', adapter.indexOf('} finally {'))
      < adapter.indexOf('await rm(userData', adapter.indexOf('} finally {')),
    'capture PostgreSQL must stop before its isolated profile is removed.',
  );
  assert.match(adapter, /randomUUID\(\)/);
  assert.match(adapter, /metadata\.captureId,\s*captureId/);
  assert.match(adapter, /capturedAt >= startedAt && capturedAt <= completedAt/);
  assert.match(adapter, /output mtimes are outside the current run window/);
  assert.match(adapter, /metadata\.sourceDimensions/);
  assert.match(adapter, /metadata\.nativeWindow\.finalBounds/);
  assert.match(adapter, /metadata\.outputDimensions/);
  assert.match(adapter, /metadata\.resizeApplied,\s*false/);
  assert.match(adapter, /metadata\.rendererValidation/);
  assert.match(adapter, /metadata\.captureEnvironment/);
  assert.match(adapter, /packaged:\s*false/);
  assert.match(capture, /liveDesktop\.sidebarGap !== 0/);
  assert.match(capture, /liveDesktop\.rects\.sidebar\.left !== 0/);
  assert.match(capture, /liveDesktop\.rects\.sidebar\.top !== 41/);
  assert.match(capture, /liveDesktop\.rects\.sidebar\.width !== 260/);
  assert.match(capture, /liveDesktop\.viewport\.height - liveDesktop\.rects\.sidebar\.bottom !== 0/);
  assert.match(capture, /liveDesktop\.rects\.main\.left !== 260/);
  assert.match(capture, /breakpointActive:\s*mobileViewport\.width <= 760/);
  assert.match(adapter, /mobile\.viewport\.width <= 760/);
  assert.match(capture, /const domSidebarGeometry = \{/);
  assert.match(capture, /left:\s*liveDesktop\.rects\.sidebar\.left/);
  assert.match(capture, /top:\s*liveDesktop\.rects\.sidebar\.top/);
  assert.match(capture, /right:\s*liveDesktop\.rects\.sidebar\.right/);
  assert.match(capture, /bottom:\s*liveDesktop\.rects\.sidebar\.bottom/);
  assert.match(capture, /width:\s*liveDesktop\.rects\.sidebar\.width/);
  assert.match(capture, /bottomInset:\s*liveDesktop\.viewport\.height - liveDesktop\.rects\.sidebar\.bottom/);
  assert.match(capture, /mainLeft:\s*liveDesktop\.rects\.main\.left/);
  assert.match(capture, /gap:\s*liveDesktop\.sidebarGap/);
  assert.match(capture, /imageMeasuredSidebar\.left !== domSidebarGeometry\.left/);
  assert.match(capture, /imageMeasuredSidebar\.right !== domSidebarGeometry\.right - 1/);
  assert.match(capture, /imageMeasuredSidebar\.width !== domSidebarGeometry\.width/);
  assert.match(capture, /imageMeasuredSidebar\.rightGap\.left !== domSidebarGeometry\.right/);
  assert.match(capture, /imageMeasuredSidebar\.rightGap\.right !== domSidebarGeometry\.mainLeft - 1/);
  assert.match(capture, /imageMeasuredSidebar\.rightGap\.width !== domSidebarGeometry\.gap/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.width,\s*260/);
  assert.match(adapter, /mainLeft:\s*260/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.left,\s*metadata\.domSidebarGeometry\.left/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.right,\s*metadata\.domSidebarGeometry\.right - 1/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.width,\s*metadata\.domSidebarGeometry\.width/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.rightGap\.left,\s*metadata\.domSidebarGeometry\.right/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.rightGap\.right,\s*metadata\.domSidebarGeometry\.mainLeft - 1/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.rightGap\.width,\s*metadata\.domSidebarGeometry\.gap/);
  assert.equal(packageJson.scripts['capture:ui'], 'npm run build && node src/renderer/capture-ui.mjs');
  assert.match(builder, /!out\/main\/capture-window\.js/);
});

test('desktop source has no legacy host implementation or local fallback entry', async () => {
  const sourceFiles = [
    './desktop-service-contract.ts',
    './session-host.ts',
    './desktop-support.ts',
    './desktop-service.ts',
    './desktop-service-client.ts',
    './session-transport.ts',
    './index.ts',
  ];
  const source = (await Promise.all(
    sourceFiles.map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
  )).join('\n');
  const legacyHostPattern = new RegExp(`\\b${['Engine', 'Host'].join('')}\\b|engine-host|engine-lifecycle|session-live-lanes`);
  assert.doesNotMatch(source, legacyHostPattern);
  assert.doesNotMatch(source, /session\.invoke|callDaemonSession/);
});

test('runtime preparation reuses prepared output and persistent validated dependency caches', async () => {
  const preparation = await readFile(new URL('../../scripts/prepare-runtime.mjs', import.meta.url), 'utf8');
  const ignore = await readFile(new URL('../../../../.gitignore', import.meta.url), 'utf8');
  assert.match(preparation, /process\.env\.MIXDOG_RUNTIME_NPM_CACHE/);
  assert.match(preparation, /const ownsNpmCache = !configuredNpmCacheDir/);
  assert.match(preparation, /MIXDOG_RUNTIME_NPM_CACHE must point outside the disposable \.runtime directory/);
  assert.match(preparation, /mergedEnv\.npm_config_cache\s*=\s*npmCacheDir/);
  assert.match(preparation, /process\.env\.MIXDOG_RUNTIME_DEPENDENCY_CACHE/);
  assert.match(preparation, /join\(desktopDir,\s*'\.cache',\s*'runtime-dependencies',\s*embeddingTarget\.key\)/);
  assert.match(ignore, /apps\/desktop\/\.cache\//);
  assert.match(preparation, /MIXDOG_RUNTIME_DEPENDENCY_CACHE must point outside the disposable \.runtime directory/);
  assert.match(preparation, /runtimeDependencyCacheIdentity\(rootDir,\s*embeddingTarget\)/);
  assert.match(preparation, /runtimeInputFingerprint\(manifest\)/);
  assert.match(preparation, /canReusePreparedRuntime\(fingerprint\)/);
  assert.match(preparation, /Reused prepared \$\{embeddingTarget\.key\} runtime\.asar/);
  assert.match(preparation, /restoreRuntimeDependencies\(\)/);
  assert.match(preparation, /Reused cached \$\{embeddingTarget\.key\} runtime dependencies/);
  assert.match(preparation, /Cached runtime dependencies failed validation/);
  assert.match(preparation, /await rename\(temporaryCacheDir,\s*dependencyCacheDir\)/);
  assert.match(preparation, /timed\('npm-ci'/);
  assert.match(preparation, /timed\('native-tools'/);
  // Native tools resolve for the TARGET rather than the build host: the runtime
  // fetchers answer for whatever machine they run on, which is right for an
  // installed app and wrong for preparing another platform's runtime.
  assert.match(preparation, /downloadNativeTool\(kind,\s*embeddingTarget,\s*downloadDataDir\)/);
  assert.doesNotMatch(preparation, /require a matching build runner/);
  // Architecture is read back from every compiled artifact that reaches the
  // package. A foreign binary otherwise publishes cleanly and fails only when
  // the user launches the app.
  assert.match(preparation, /assertTargetArchitecture\(destination,\s*`Native tool \$\{kind\}`\)/);
  assert.match(
    preparation,
    /assertTreeTargetArchitecture\(\s*await desktopPtyNativeRoot\(\)/,
  );
  assert.match(preparation, /assertTargetArchitecture\(source,\s*`Runtime addon \$\{entry\}`\)/);
  assert.match(preparation, /timed\('asar-create'/);
  assert.match(preparation, /finally\s*\{[\s\S]*rm\(stagingDir/);
  assert.match(preparation, /if\s*\(ownsNpmCache\)\s*\{[\s\S]*rm\(npmCacheDir/);
  assert.match(preparation, /if\s*\(!prepared\)\s*\{[\s\S]*rm\(runtimeDir/);
  assert.match(preparation, /pruneEmbeddingRuntime\(stagingDir,\s*embeddingTarget\)/);
  assert.doesNotMatch(preparation, /rm\(join\(stagingDir,\s*'node_modules',\s*'@huggingface'/);
  assert.match(preparation, /node,dll,dylib,so,so\.\*/);
});

test('packaged runtime verification has no memory-pressure bypass', async () => {
  const verifier = await readFile(new URL('../../scripts/verify-packaged-runtime.mjs', import.meta.url), 'utf8');
  assert.match(verifier, /ELECTRON_RUN_AS_NODE:\s*'1'/);
  assert.doesNotMatch(verifier, /MIXDOG_EMBED_PRESSURE_MIN_FREE_MB/);
  assert.match(verifier, /env:\s*\{\s*\.\.\.process\.env,/);
});

test('development CSP supports Vite refresh without weakening production scripts', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const policies = [...main.matchAll(/`(default-src [^`]+)`/g)].map((match) => match[1]);
  const development = policies.find((policy) => policy.includes("'unsafe-eval'"));
  const production = policies.find((policy) => !policy.includes("'unsafe-eval'"));
  assert.match(development || '', /script-src 'self' 'unsafe-eval' 'unsafe-inline'/);
  assert.equal(production?.match(/script-src[^;]*/)?.[0], "script-src 'self'");
});

test('desktop package does not declare the repository as a dependency', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.dependencies.mixdog, undefined);
  const builder = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  assert.match(builder, /from:\s*\.runtime\/runtime\.asar\s+to:\s*runtime\.asar/);
  assert.match(builder, /from:\s*\.runtime\/native-modules\s+to:\s*runtime\.asar\.unpacked\/node_modules/);
  assert.doesNotMatch(builder, /to:\s*runtime\/node_modules/);
});

test('production shell persists safe window state and installs native shortcuts', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const state = await readFile(new URL('./window-state.ts', import.meta.url), 'utf8');
  const menu = await readFile(new URL('./menu.ts', import.meta.url), 'utf8');
  assert.match(main, /readWindowState\(statePath,\s*screen\.getAllDisplays\(\)\)/);
  assert.match(main, /persistWindowState\(window,\s*statePath\)/);
  assert.match(main, /installNativeMenu/);
  assert.match(state, /MIN_VISIBLE_PIXELS/);
  assert.match(state, /writeFile\(temporaryPath/);
  assert.match(state, /rename\(temporaryPath,\s*filePath\)/);
  assert.match(menu, /role:\s*'quit',\s*registerAccelerator:\s*false/);
  assert.match(menu, /CmdOrCtrl\+0/);
  assert.match(menu, /togglefullscreen/);
  assert.doesNotMatch(menu, /openExternal|loadURL/);
});

