import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listPackage, statFile } from '@electron/asar';

const execFileAsync = promisify(execFile);

test('packaged preload path matches electron-vite output', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const vite = await readFile(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8');
  assert.match(main, /preload:\s*join\(__dirname,\s*'\.\.\/preload\/index\.js'\)/);
  assert.match(vite, /format:\s*'cjs'/);
  assert.match(vite, /entryFileNames:\s*'index\.js'/);
  await access(new URL('../../out/preload/index.js', import.meta.url));
});

test('Windows installer is an assisted per-user wizard', async () => {
  const builder = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  assert.match(builder, /oneClick:\s*false/);
  assert.match(builder, /perMachine:\s*false/);
  assert.match(builder, /allowToChangeInstallationDirectory:\s*true/);
  assert.match(builder, /runAfterFinish:\s*true/);
  assert.match(builder, /include:\s*build\/installer\.nsh/);
  assert.match(builder, /win:[\s\S]*icon:\s*build\/mixdog\.ico/);
  assert.match(builder, /installerIcon:\s*build\/mixdog\.ico/);
  assert.match(builder, /uninstallerIcon:\s*build\/mixdog\.ico/);
  assert.match(builder, /installerHeaderIcon:\s*build\/mixdog\.ico/);
  const icon = await readFile(new URL('../../build/mixdog.ico', import.meta.url));
  assert.deepEqual([...icon.subarray(0, 4)], [0, 0, 1, 0]);
});

test('legacy all-users migration is explicit, elevated, verified, and scoped', async () => {
  const installer = await readFile(new URL('../../build/installer.nsh', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../../build/migrate-legacy.ps1', import.meta.url), 'utf8');
  assert.match(installer, /5343bdcc-87a7-52f8-80e7-87b62e476a38/);
  assert.match(installer, /File \/oname=\$PLUGINSDIR\\elevate\.exe "\$\{NSISDIR\}\\elevate\.exe"/);
  assert.match(installer, /elevate\.exe" -wait[\s\S]*migrate-legacy\.ps1" -LogPath/);
  assert.match(installer, /\$SYSDIR\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.doesNotMatch(installer, /Start-Process[\s\S]*-Verb RunAs/);
  assert.match(installer, /acceptLegacyMigration/);
  assert.match(installer, /Legacy Mixdog removal could not be verified/);
  assert.match(migration, /ExecutablePath -ieq \$legacyExe/);
  assert.match(migration, /Official legacy uninstaller failed/);
  assert.match(migration, /\[string\]\$LogPath/);
  assert.match(migration, /RegistryView\]::Registry64/);
  assert.match(migration, /Get-ChildItem -LiteralPath \$legacyDir/);
  assert.doesNotMatch(`${installer}\n${migration}`, /Remove-Item[^\n]*\\\.mixdog/i);

  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('../../scripts/test-migration.ps1', import.meta.url))],
      { windowsHide: true },
    );
    assert.match(stdout, /MIGRATION_SIMULATION=passed; LEGACY_REMNANTS=0; USER_DATA=preserved/);
  }
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
  assert.match(capture, /desktopCapturer\.getSources/);
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
  assert.match(capture, /registerDesktopIpc\(window,\s*host,\s*\{\s*ipcMain,\s*dialog,\s*shell\s*\}\)/);
  assert.match(capture, /console-message/);
  assert.match(capture, /Capture renderer preload bridge is missing/);
  assert.match(capture, /\.inline-error,\s*\[role="alert"\]/);
  assert.ok(
    capture.indexOf('desktopCapturer.getSources') < capture.indexOf('const rendererState ='),
    'renderer validation must follow the desktopCapturer capture.',
  );
  const validationBoundaryStart = capture.indexOf('function validateAndDestroyRenderer');
  const validationBoundaryEnd = capture.indexOf('function imageReader');
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
  assert.match(capture, /await host\.dispose\(\)/);
  assert.match(options, /Object\.freeze/);
  assert.match(options, /DESKTOP_BACKGROUND_COLOR\s*=\s*'#080808'/);
  assert.match(options, /color:\s*'#00000000'/);
  assert.match(options, /backgroundColor:\s*DESKTOP_BACKGROUND_COLOR/);
  assert.match(options, /symbolColor:\s*'#e5e5e5'/);
  assert.match(options, /titleBarStyle:\s*'hidden'/);
  assert.doesNotMatch(options, /frame:\s*(?:false|process\.platform)/);
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
  assert.match(capture, /liveDesktop\.rects\.sidebar\.top !== 36/);
  assert.match(capture, /liveDesktop\.rects\.sidebar\.width !== 286/);
  assert.match(capture, /liveDesktop\.viewport\.height - liveDesktop\.rects\.sidebar\.bottom !== 8/);
  assert.match(capture, /liveDesktop\.rects\.main\.left !== 302/);
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
  assert.match(adapter, /metadata\.imageMeasuredSidebar\.width,\s*286/);
  assert.match(adapter, /mainLeft:\s*302/);
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
