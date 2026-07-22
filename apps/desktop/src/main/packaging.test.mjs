import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listPackage, statFile } from '@electron/asar';

import { SETTINGS_ITEMS } from '../renderer/settings/settings-items.ts';

test('packaged preload path matches electron-vite output', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const vite = await readFile(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8');
  assert.match(main, /preload:\s*join\(__dirname,\s*'\.\.\/preload\/index\.js'\)/);
  assert.match(vite, /format:\s*'cjs'/);
  assert.match(vite, /entryFileNames:\s*'index\.js'/);
  await access(new URL('../../out/preload/index.js', import.meta.url));
});

test('Windows installer is one-click, per-user, and registers Mixdog deep links', async () => {
  const builder = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  const installer = await readFile(new URL('../../build/installer.nsh', import.meta.url), 'utf8');
  const progressDriver = await readFile(new URL('../../build/progress-driver.ps1', import.meta.url), 'utf8');
  const iconGenerator = await readFile(new URL('../../scripts/generate-brand-icons.mjs', import.meta.url), 'utf8');
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(builder, /protocols:\s+name:\s*Mixdog\s+schemes:\s+-\s*mixdog/);
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
  assert.match(installer, /progress-driver\.ps1[\s\S]*-ProgressHwnd \$MixdogProgressBar/);
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
  const capture = await readFile(new URL('./capture-window.ts', import.meta.url), 'utf8');
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
  assert.match(options, /DESKTOP_BACKGROUND_COLOR\s*=\s*'#201e1c'/);
  assert.match(options, /DESKTOP_LIGHT_BACKGROUND_COLOR\s*=\s*'#f1efec'/);
  assert.match(options, /DESKTOP_TITLEBAR_HEIGHT\s*=\s*40/);
  assert.match(options, /color:\s*'#00000000'/);
  assert.match(options, /backgroundColor:\s*DESKTOP_BACKGROUND_COLOR/);
  assert.match(options, /symbolColor:\s*light\s*\?\s*'black'\s*:\s*'white'/);
  assert.match(options, /Math\.max\(DESKTOP_TITLEBAR_HEIGHT,\s*Math\.round\(DESKTOP_TITLEBAR_HEIGHT \* zoom\)\)/);
  assert.match(options, /titleBarStyle:\s*'hidden'/);
  assert.match(options, /frame:\s*false/);
  assert.match(adapter, /out\/main\/capture-window\.js/);
  assert.doesNotMatch(adapter, /out\/main\/index\.js|MIXDOG_DESKTOP_CAPTURE_PATH/);
  assert.match(adapter, /rm\(windowOutput,\s*\{\s*force:\s*true\s*\}\)/);
  assert.match(adapter, /Capture timed out/);
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
  assert.match(capture, /liveDesktop\.sidebarGap !== 8/);
  assert.match(capture, /liveDesktop\.rects\.sidebar\.left !== 8/);
  assert.match(capture, /liveDesktop\.rects\.sidebar\.top !== 40/);
  assert.match(capture, /liveDesktop\.rects\.sidebar\.width !== 260/);
  assert.match(capture, /liveDesktop\.viewport\.height - liveDesktop\.rects\.sidebar\.bottom !== 8/);
  assert.match(capture, /liveDesktop\.rects\.main\.left !== 276/);
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
  assert.match(adapter, /mainLeft:\s*276/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.left,\s*metadata\.domSidebarGeometry\.left/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.right,\s*metadata\.domSidebarGeometry\.right - 1/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.width,\s*metadata\.domSidebarGeometry\.width/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.rightGap\.left,\s*metadata\.domSidebarGeometry\.right/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.rightGap\.right,\s*metadata\.domSidebarGeometry\.mainLeft - 1/);
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.rightGap\.width,\s*metadata\.domSidebarGeometry\.gap/);
  assert.equal(packageJson.scripts['capture:ui'], 'npm run build && node src/renderer/capture-ui.mjs');
  assert.match(builder, /!out\/main\/capture-window\.js/);
});

test('development CSP supports Vite refresh without weakening production scripts', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const policies = [...main.matchAll(/"default-src [^"]+"/g)].map((match) => match[0].slice(1, -1));
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
  assert.match(menu, /CmdOrCtrl\+Q/);
  assert.match(menu, /CmdOrCtrl\+0/);
  assert.match(menu, /togglefullscreen/);
  assert.doesNotMatch(menu, /openExternal|loadURL/);
});

test('built runtime archive metadata and emitted native sidecar agree', async () => {
  const runtimeArchive = fileURLToPath(new URL('../../.runtime/runtime.asar', import.meta.url));
  const stagedSidecar = fileURLToPath(new URL('../../.runtime/runtime.asar.unpacked', import.meta.url));
  const builtResources = fileURLToPath(new URL('../../dist/win-unpacked/resources', import.meta.url));
  const builtArchive = join(builtResources, 'runtime.asar');
  await access(runtimeArchive);
  await access(builtArchive);

  const entries = listPackage(builtArchive, { isPack: false })
    .map((entry) => entry.replaceAll('\\', '/'));
  for (const required of [
    '/package.json',
    '/node_modules/mixdog/package.json',
    '/node_modules/mixdog/src/tui/engine.mjs',
  ]) {
    assert.ok(entries.includes(required), `runtime archive is missing ${required}`);
  }

  const nativeBinaryEntries = entries.filter((entry) => /\.(?:node|dll)$/i.test(entry));
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
