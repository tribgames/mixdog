// The Computer Use helper (native/mixdog-computer) in the Windows package: prepare-runtime builds it for the
// target and stages it as native-tools/mixdog-computer.exe, electron-builder signs it with the other native-tools
// executables, and the desktop hands its path to the core it starts as MIXDOG_COMPUTER_BIN (the core's own resolver
// is tested in mixdog-core run_host/native_tools.rs). The prepared-runtime check runs only where a Windows runtime
// was prepared (npm run prepare:runtime) and starts the helper with --version alone, which touches no desktop.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { nativeBinaryRunsOn } from '../../../scripts/native-binary-arch.mjs';

const execFileAsync = promisify(execFile);
const text = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/** The source of one top-level statement, which the tests below read or run. */
function statement(source, pattern, label) {
  const found = pattern.exec(source)?.[0];
  assert.ok(found, `${label} is no longer a top-level statement of its file`);
  return found;
}

/** prepare-runtime's helper file name and cargo targets, evaluated for one embedding target. */
async function computerNativeNaming(embeddingTarget) {
  const preparation = await text('./prepare-runtime.mjs');
  const name = statement(preparation, /^const computerNativeFileName = .+;$/m, 'computerNativeFileName');
  const targets = statement(
    preparation,
    /^const computerRustTargets = Object\.freeze\(\{$[\s\S]+?^\}\);$/m,
    'computerRustTargets'
  );
  const evaluate = new Function(
    'embeddingTarget',
    `${name}\n${targets}\nreturn { computerNativeFileName, computerRustTargets };`
  );
  return evaluate(embeddingTarget);
}

/** index.ts's MIXDOG_COMPUTER_BIN selection and the executableSuffix it reads, run with a fake app and process. */
async function selectedComputerBin({ platform, packaged, existing, env = {} }) {
  const main = await text('../src/main/index.ts');
  const suffix = statement(main, /^const executableSuffix = .+;$/m, 'executableSuffix');
  const selection = statement(
    main,
    /^if \(!process\.env\.MIXDOG_COMPUTER_BIN\) \{$[\s\S]+?^\}$/m,
    'The MIXDOG_COMPUTER_BIN selection'
  );
  const fakeProcess = {
    platform,
    env: { ...env },
    resourcesPath: platform === 'win32' ? 'C:\\Programs\\Mixdog\\resources' : '/opt/Mixdog/resources',
  };
  const app = {
    isPackaged: packaged,
    getAppPath: () => (platform === 'win32' ? 'C:\\src\\mixdog\\apps\\desktop' : '/src/mixdog/apps/desktop'),
  };
  new Function('app', 'process', 'existsSync', 'join', `${suffix}\n${selection}`)(
    app,
    fakeProcess,
    (path) => existing.includes(path),
    platform === 'win32' ? win32.join : posix.join
  );
  return fakeProcess.env.MIXDOG_COMPUTER_BIN;
}

test('runtime preparation builds the Windows helper and stages it under the name cargo writes', async () => {
  const windows = await computerNativeNaming({ platform: 'win32', arch: 'x64', key: 'win32-x64' });
  assert.equal(windows.computerNativeFileName, 'mixdog-computer.exe');
  assert.equal(windows.computerRustTargets['win32-x64'], 'x86_64-pc-windows-msvc');
  assert.equal(windows.computerRustTargets['win32-arm64'], 'aarch64-pc-windows-msvc');
  const linux = await computerNativeNaming({ platform: 'linux', arch: 'x64', key: 'linux-x64' });
  assert.equal(linux.computerNativeFileName, 'mixdog-computer');

  const preparation = await text('./prepare-runtime.mjs');
  const prepare = statement(
    preparation,
    /^async function prepareComputerNative\(\) \{$[\s\S]+?^\}$/m,
    'prepareComputerNative'
  );
  assert.doesNotMatch(prepare, /binary: ''/, 'every target with a cargo triple gets the helper');
  assert.match(prepare, /cp\(join\(targetRoot, triple, 'release', computerNativeFileName\), output\)/);
  assert.match(preparation, /const destination = join\(desktopNativeToolsDir, computerNativeFileName\);/);
  assert.match(preparation, /if \(embeddingTarget\.platform !== 'win32'\) await chmod\(destination, 0o755\);/);
});

test('the desktop points MIXDOG_COMPUTER_BIN at the helper on Windows, packaged and in development', async () => {
  const packaged = 'C:\\Programs\\Mixdog\\resources\\native-tools\\mixdog-computer.exe';
  const built = 'C:\\src\\mixdog\\native\\mixdog-computer\\target\\release\\mixdog-computer.exe';
  assert.equal(await selectedComputerBin({ platform: 'win32', packaged: true, existing: [packaged] }), packaged);
  assert.equal(await selectedComputerBin({ platform: 'win32', packaged: false, existing: [built] }), built);
  assert.equal(
    await selectedComputerBin({ platform: 'win32', packaged: true, existing: [packaged.replace(/\.exe$/, '')] }),
    undefined,
    'an extensionless file is not the Windows helper'
  );
  assert.equal(
    await selectedComputerBin({
      platform: 'win32',
      packaged: true,
      existing: [packaged],
      env: { MIXDOG_COMPUTER_BIN: 'D:\\own.exe' },
    }),
    'D:\\own.exe',
    'a variable the user set is kept'
  );
  const linux = '/opt/Mixdog/resources/native-tools/mixdog-computer';
  assert.equal(await selectedComputerBin({ platform: 'linux', packaged: true, existing: [linux] }), linux);
});

test('electron-builder copies native-tools into the package and signs its executables', async () => {
  const builder = await text('../electron-builder.yml');
  assert.match(builder, /- from: \.runtime\/native-tools\r?\n\s+to: native-tools\r?\n/);
  // electron-builder signs every extra resource ending in .exe unless win.signExts negates it ("!.exe").
  const signExts = statement(builder, /^ {2}signExts:\r?\n(?: {4}- .*\r?\n)+/m, 'win.signExts');
  assert.doesNotMatch(signExts, /!/);
});

async function preparedRuntimeTarget() {
  try {
    return JSON.parse(await text('../.runtime/manifest.json')).target;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

test('a prepared Windows runtime ships the helper for its architecture, which answers --version', async (t) => {
  const target = await preparedRuntimeTarget();
  if (!target?.startsWith('win32-')) {
    return t.skip(`no Windows runtime is prepared in this checkout (${target ?? 'none'})`);
  }
  const helper = fileURLToPath(new URL('../.runtime/native-tools/mixdog-computer.exe', import.meta.url));
  const image = await readFile(helper).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    assert.fail(`the prepared ${target} runtime has no ${helper}; prepare it again (npm run prepare:runtime)`);
  });
  const arch = target.slice('win32-'.length);
  assert.ok(nativeBinaryRunsOn(image, arch), `${helper} does not run on ${target}`);
  if (process.platform !== 'win32' || !nativeBinaryRunsOn(image, process.arch)) {
    return t.skip(`a ${arch} helper does not run on ${process.platform}-${process.arch}`);
  }
  const version = /^version\s*=\s*"([^"]+)"/m.exec(await text('../../../native/mixdog-computer/Cargo.toml'))?.[1];
  const { stdout } = await execFileAsync(helper, ['--version'], { timeout: 10_000, windowsHide: true });
  assert.equal(stdout.trim(), `mixdog-computer ${version}`);
});
