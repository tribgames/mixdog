import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listPackage, statFile } from '@electron/asar';

import { SETTINGS_ITEMS } from '../renderer/settings/settings-items.ts';

async function findRuntimeArchives(directory, depth = 0) {
  if (depth > 8) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const archives = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === 'runtime.asar') {
      archives.push(path);
    } else if (entry.isDirectory()) {
      archives.push(...await findRuntimeArchives(path, depth + 1));
    }
  }
  return archives;
}

test('packaged preload path matches electron-vite output', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const vite = await readFile(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8');
  assert.match(main, /preload:\s*join\(__dirname,\s*'\.\.\/preload\/index\.js'\)/);
  assert.match(vite, /format:\s*'cjs'/);
  assert.match(vite, /entryFileNames:\s*'index\.js'/);
  await access(new URL('../../out/preload/index.js', import.meta.url));
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

test('production engine host uses only the packaged daemon backend adapter', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const backend = await readFile(new URL('./desktop-backend.ts', import.meta.url), 'utf8');
  const ipc = await readFile(new URL('./ipc.ts', import.meta.url), 'utf8');
  const vite = await readFile(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8');
  const builder = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  const daemonBuild = await readFile(new URL('../../scripts/build-daemon-backend.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(vite, /'desktop-backend':/);
  assert.match(daemonBuild, /src['"],\s*['"]main['"],\s*['"]desktop-backend\.ts/);
  assert.match(main, /new DaemonEngineTransport\(/);
  assert.match(main, /desktop-backend-daemon\.cjs/);
  assert.match(main, /app\.asar\.unpacked/);
  assert.doesNotMatch(vite, /engine-worker/);
  assert.doesNotMatch(vite, /terminal-worker/);
  assert.doesNotMatch(main, /MIXDOG_ENGINE_PROCESS|Mixdog Engine/);
  assert.doesNotMatch(main, /startRemoteBridge|startRemoteRelay|rotateRemoteToken|rotateRemoteDevice/);
  assert.doesNotMatch(
    main.slice(main.indexOf('registerDesktopIpc('), main.indexOf("diagnostics?.write('window-created'")),
    /\bsettingsStore\b/,
    'product IPC settings use the daemon operation service',
  );
  assert.match(backend, /startRemoteBridge/);
  assert.match(backend, /startRemoteRelay/);
  assert.doesNotMatch(ipc, /import \* as .* from ['"]electron['"]/);
  assert.doesNotMatch(ipc, /from ['"]\.\/window-options['"];/);
  assert.match(builder, /files:\s+-\s*out\/\*\*/);
  assert.match(builder, /asarUnpack:[\s\S]*out\/main\/desktop-backend-daemon\.cjs/);
  assert.match(builder, /asarUnpack:[\s\S]*out\/renderer\/\*\*/);
});

test('plain Node can import the standalone daemon backend artifact', async () => {
  const backendUrl = new URL('../../out/main/desktop-backend-daemon.cjs', import.meta.url);
  const source = await readFile(backendUrl, 'utf8');
  assert.doesNotMatch(source, /(?:from\s+|import\s*\()\s*["']electron["']/);
  const backend = await import(`${backendUrl.href}?packaging-test=${Date.now()}`);
  assert.equal(typeof backend.createDesktopBackend, 'function');
});

test('closed-window cleanup never reacquires the destroyed BrowserWindow webContents getter', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const scheduler = main
    .slice(main.indexOf('function scheduleDeferredDesktopServices'))
    .slice(0, main.indexOf('function disposeDesktopResources')
      - main.indexOf('function scheduleDeferredDesktopServices'));
  assert.match(scheduler, /const webContents = window\.webContents/);
  const closedCleanup = scheduler.slice(scheduler.indexOf("window.once('closed'"));
  assert.doesNotMatch(closedCleanup, /window\.webContents/,
    'the BrowserWindow webContents getter throws after the closed event');
  assert.match(closedCleanup, /webContents\.isDestroyed\(\)/);
});

test('Windows installer is one-click, per-user, and registers Mixdog deep links', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const builder = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  const installer = await readFile(new URL('../../build/installer.nsh', import.meta.url), 'utf8');
  const progressDriver = await readFile(new URL('../../build/progress-driver.ps1', import.meta.url), 'utf8');
  const iconGenerator = await readFile(new URL('../../scripts/generate-brand-icons.mjs', import.meta.url), 'utf8');
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(builder, /protocols:\s+name:\s*Mixdog\s+schemes:\s+-\s*mixdog/);
  assert.match(packageJson.scripts['build:win'], /electron-builder --win --x64 --publish never$/);
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
  assert.doesNotMatch(iconGenerator, /mixdog\.png/);
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
  await assert.rejects(
    access(new URL('../../build/progress-overlay.ps1', import.meta.url)),
    (error) => error?.code === 'ENOENT',
  );
  const icon = await readFile(new URL('../../build/mixdog.ico', import.meta.url));
  assert.deepEqual([...icon.subarray(0, 4)], [0, 0, 1, 0]);
});

test('Windows acceptance checks the current canonical settings inventory', async () => {
  const acceptance = await readFile(new URL('../../scripts/acceptance-windows.ps1', import.meta.url), 'utf8');
  assert.match(
    acceptance,
    new RegExp(`\\$value\\.inventory\\.settingsItems -ne ${SETTINGS_ITEMS.length}`),
  );
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
  assert.match(capture, /class CaptureEngineHost extends EngineHost/);
  assert.match(capture, /SETTINGS_CATEGORIES/);
  assert.doesNotMatch(capture, /railButtonCount\s*!==\s*14|railButtonCount,\s*14/);
  assert.match(capture, /override async listSessions\(\): Promise<DesktopSessionSummary\[]>/);
  assert.match(capture, /new CaptureEngineHost/);
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
  assert.match(capture, /host:\s*'CaptureEngineHost'/);
  assert.match(capture, /sessionMode:\s*'empty-session'/);
  assert.match(capture, /removeIpc\(\)/);
  // Dispose is bounded: engine teardown may hang 30s+, so the capture exit
  // path races it against a short grace instead of awaiting it bare.
  assert.match(capture, /await Promise\.race\(\[\s*host\.dispose\(\),/);
  assert.match(options, /Object\.freeze/);
  assert.match(options, /DESKTOP_BACKGROUND_COLOR\s*=\s*'#0f0f0f'/);
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
  assert.match(preparation, /timed\('asar-create'/);
  assert.match(preparation, /finally\s*\{[\s\S]*rm\(stagingDir/);
  assert.match(preparation, /if\s*\(ownsNpmCache\)\s*\{[\s\S]*rm\(npmCacheDir/);
  assert.match(preparation, /if\s*\(!prepared\)\s*\{[\s\S]*rm\(runtimeDir/);
  assert.match(preparation, /pruneEmbeddingRuntime\(stagingDir,\s*embeddingTarget\)/);
  assert.doesNotMatch(preparation, /rm\(join\(stagingDir,\s*'node_modules',\s*'@huggingface'/);
  assert.match(preparation, /node,dll,dylib,so,so\.\*/);
});

test('packaged runtime verification bypasses only embedding load admission pressure', async () => {
  const verifier = await readFile(new URL('../../scripts/verify-packaged-runtime.mjs', import.meta.url), 'utf8');
  assert.match(verifier, /ELECTRON_RUN_AS_NODE:\s*'1'/);
  assert.match(verifier, /MIXDOG_EMBED_PRESSURE_MIN_FREE_MB:\s*'0'/);
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

test('built runtime archive metadata and emitted native sidecar agree', async () => {
  const runtimeArchive = fileURLToPath(new URL('../../.runtime/runtime.asar', import.meta.url));
  const stagedSidecar = fileURLToPath(new URL('../../.runtime/runtime.asar.unpacked', import.meta.url));
  await access(runtimeArchive);

  const targetBinding = `/bin/napi-v3/${process.platform}/${process.arch}/onnxruntime_binding.node`;
  const candidates = await findRuntimeArchives(
    fileURLToPath(new URL('../../dist', import.meta.url)),
  );
  const built = candidates
    .map((archive) => ({
      archive,
      entries: listPackage(archive, { isPack: false })
        .map((entry) => entry.replaceAll('\\', '/')),
    }))
    .find(({ entries }) => entries.some((entry) => entry.endsWith(targetBinding)));
  assert.ok(built, `dist is missing a packaged ${process.platform}-${process.arch} runtime.asar`);
  const builtArchive = built.archive;
  const builtResources = dirname(builtArchive);
  const entries = built.entries;
  for (const required of [
    '/package.json',
    '/node_modules/mixdog/package.json',
    '/node_modules/mixdog/src/tui/engine.mjs',
    '/node_modules/@huggingface/transformers/package.json',
    '/node_modules/@huggingface/transformers/dist/transformers.node.cjs',
    '/node_modules/@huggingface/transformers/dist/transformers.node.mjs',
  ]) {
    assert.ok(entries.includes(required), `runtime archive is missing ${required}`);
  }
  const ortPackage = entries.find((entry) => /\/onnxruntime-node\/package\.json$/.test(entry));
  assert.ok(ortPackage, 'runtime archive is missing onnxruntime-node');
  const ortRoot = ortPackage.slice(0, -'/package.json'.length);
  const embeddingNapiRoot = `${ortRoot}/bin/napi-v3`;
  const embeddingPlatformRoot = `${embeddingNapiRoot}/${process.platform}`;
  const embeddingBinaryRoot = `${embeddingPlatformRoot}/${process.arch}`;
  assert.ok(
    entries.includes(`${embeddingBinaryRoot}/onnxruntime_binding.node`),
    `runtime archive is missing ${process.platform}-${process.arch} ONNX binding`,
  );
  assert.equal(
    entries.some((entry) => entry.startsWith(`${embeddingNapiRoot}/`)
      && entry !== embeddingPlatformRoot
      && entry !== embeddingBinaryRoot
      && !entry.startsWith(`${embeddingBinaryRoot}/`)),
    false,
    'runtime archive contains foreign ONNX platform binaries',
  );
  assert.equal(
    entries.some((entry) => /\/onnxruntime-web\/(?:dist|lib)\//.test(entry)),
    false,
    'runtime archive contains unused ONNX web payloads',
  );

  const nativeBinaryEntries = entries.filter(
    (entry) => /\.(?:node|dll|dylib|so(?:\.\d+)*)$/i.test(entry),
  );
  assert.ok(nativeBinaryEntries.some((entry) => entry.endsWith('.node')), 'runtime archive contains no native addon');
  for (const entry of nativeBinaryEntries) {
    const archivePath = entry.replace(/^\/+/, '');
    assert.equal(
      statFile(builtArchive, archivePath.replaceAll('/', sep)).unpacked,
      true,
      `${entry} is not unpacked`,
    );
    const parts = archivePath.split('/');
    const stagedNative = join(stagedSidecar, ...parts);
    const builtNative = join(builtResources, 'runtime.asar.unpacked', ...parts);
    assert.deepEqual(
      await readFile(builtNative),
      await readFile(stagedNative),
      `${entry} was not emitted unchanged beside the built runtime.asar`,
    );
  }
});
