import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { planShellInvocation } from '../agent/orchestrator/tools/builtin/bash-tool/invocation-plan.mjs';
import { buildShellSpawnEnv } from '../agent/orchestrator/tools/builtin/bash-tool/spawn-env.mjs';
import { resolveShellFor } from '../agent/orchestrator/tools/builtin/shell-runtime.mjs';
import { displayShellCommand, POWERSHELL_UTF8_PREFIX } from './shell-display.mjs';
import {
  archiveRootOf,
  canonicalSkillScriptPath,
  decodeSkillArgv,
  ensureSkillLauncherDir,
  renderPowerShellSkillFunction,
  renderPosixSkillLauncher,
  renderWindowsSkillLauncher,
  skillLauncherDir,
  skillScriptRuntime,
  withSkillLauncherPath,
} from './skill-script-runtime.mjs';

const ENTRY = fileURLToPath(new URL('../../skill-script-entry.mjs', import.meta.url));
const identity = (value) => value;
const SCRIPT = 'src/defaults/skills/pptx/scripts/qc-pages.mjs';

test('a built-in script under the sidecar maps back into the archive that holds the package (Windows)', () => {
  const packageRoot = 'C:\\Program Files\\Mixdog\\resources\\runtime.asar\\node_modules\\mixdog';
  const options = { packageRoot, platform: 'win32', cwd: 'C:\\Work', realpath: identity };
  const expected = `C:\\Program Files\\Mixdog\\resources\\runtime.asar\\node_modules\\mixdog\\${SCRIPT.replaceAll('/', '\\')}`;
  assert.equal(
    canonicalSkillScriptPath(
      `C:/Program Files/Mixdog/resources/runtime.asar.unpacked/node_modules/mixdog/${SCRIPT}`,
      options
    ),
    expected
  );
  // Drive and folder case differ between what the model typed and the package.
  assert.equal(
    canonicalSkillScriptPath(
      `c:\\program files\\mixdog\\resources\\runtime.asar.unpacked\\node_modules\\mixdog\\${SCRIPT}`,
      options
    ),
    expected
  );
  // Already canonical, or not under this archive's sidecar: unchanged.
  assert.equal(canonicalSkillScriptPath(expected, options), expected);
  assert.equal(
    canonicalSkillScriptPath('D:\\Other\\runtime.asar.unpacked\\x.mjs', options),
    'D:\\Other\\runtime.asar.unpacked\\x.mjs'
  );
  assert.equal(canonicalSkillScriptPath('scripts\\x.mjs', options), 'C:\\Work\\scripts\\x.mjs');
});

test('a built-in script under the sidecar maps back into the archive (POSIX)', () => {
  const packageRoot = '/Applications/Mixdog.app/Contents/Resources/runtime.asar/node_modules/mixdog';
  const options = { packageRoot, platform: 'darwin', cwd: '/work', realpath: identity };
  assert.equal(
    canonicalSkillScriptPath(
      `/Applications/Mixdog.app/Contents/Resources/runtime.asar.unpacked/node_modules/mixdog/${SCRIPT}`,
      options
    ),
    `${packageRoot}/${SCRIPT}`
  );
  // POSIX paths are case-sensitive: a different case is a different file.
  const other = `/applications/Mixdog.app/Contents/Resources/runtime.asar.unpacked/node_modules/mixdog/${SCRIPT}`;
  assert.equal(canonicalSkillScriptPath(other, options), other);
});

test('source trees and npm installs keep the real script path', () => {
  assert.equal(
    canonicalSkillScriptPath(SCRIPT, {
      packageRoot: 'C:\\Project\\mixdog',
      platform: 'win32',
      cwd: 'C:\\Project\\mixdog',
      realpath: identity,
    }),
    `C:\\Project\\mixdog\\${SCRIPT.replaceAll('/', '\\')}`
  );
  const npmRoot = '/usr/lib/node_modules/mixdog';
  // Even a path that looks like some other app's sidecar is left alone.
  const lookalike = `/opt/Other/resources/runtime.asar.unpacked/node_modules/mixdog/${SCRIPT}`;
  assert.equal(
    canonicalSkillScriptPath(lookalike, { packageRoot: npmRoot, platform: 'linux', cwd: '/', realpath: identity }),
    lookalike
  );
  // Symlinks resolve, as the ESM loader resolves them for import.meta.url.
  const linked = canonicalSkillScriptPath('/usr/bin/mixdog-link/x.mjs', {
    packageRoot: npmRoot,
    platform: 'linux',
    cwd: '/',
    realpath: (value) => value.replace('/usr/bin/mixdog-link', npmRoot),
  });
  assert.equal(linked, `${npmRoot}/x.mjs`);
  assert.equal(archiveRootOf(npmRoot, 'linux'), null);
  assert.equal(archiveRootOf('/srv/my-runtime.asar/x', 'linux'), null);
  assert.equal(archiveRootOf('C:/R/runtime.asar/node_modules', 'win32'), 'C:\\R\\runtime.asar');
});

test('the runtime is Electron only when this process is Electron', () => {
  const electron = skillScriptRuntime({
    execPath: 'C:\\Mixdog\\Mixdog.exe',
    versions: { node: '24.0.0', electron: '41.0.0' },
    packageRoot: 'C:\\Mixdog\\resources\\runtime.asar\\node_modules\\mixdog',
    platform: 'win32',
  });
  assert.equal(electron.electron, true);
  assert.equal(electron.interpreter, 'C:\\Mixdog\\Mixdog.exe');
  assert.equal(
    electron.entry,
    'C:\\Mixdog\\resources\\runtime.asar\\node_modules\\mixdog\\src\\skill-script-entry.mjs'
  );
  const node = skillScriptRuntime({
    execPath: '/usr/bin/node',
    versions: { node: '22.0.0' },
    packageRoot: '/pkg',
    platform: 'linux',
  });
  assert.equal(node.electron, false);
  assert.equal(node.entry, '/pkg/src/skill-script-entry.mjs');
});

test('the Windows launcher sets node mode for its own child and forwards every argument and the exit code', () => {
  const text = renderWindowsSkillLauncher({
    interpreter: 'C:\\A&B 100%!\\Mixdog.exe',
    entry: "C:\\it's\\entry.mjs",
    electron: true,
  });
  const lines = text.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.ok(lines.includes('setlocal EnableExtensions DisableDelayedExpansion'));
  assert.ok(lines.includes('set "ELECTRON_RUN_AS_NODE=1"'));
  assert.ok(lines.includes(`"C:\\A&B 100%%!\\Mixdog.exe" "C:\\it's\\entry.mjs" %*`));
  assert.ok(lines.includes('exit /b %MIXDOG_SKILL_EXIT%'));
  assert.doesNotMatch(text, /chcp/);
  assert.doesNotMatch(text, /TOKEN|SECRET|MIXDOG_HOME|MIXDOG_DATA_DIR/);
  const unicode = renderWindowsSkillLauncher({
    interpreter: 'C:\\사용자\\node.exe',
    entry: 'C:\\e.mjs',
    electron: false,
  });
  assert.match(unicode, /chcp 65001 >nul/);
  assert.match(unicode, /if defined MIXDOG_SKILL_CP chcp %MIXDOG_SKILL_CP% >nul/);
  assert.doesNotMatch(unicode, /ELECTRON_RUN_AS_NODE/);
});

test('the POSIX launcher is a sh script that execs with "$@"', () => {
  const text = renderPosixSkillLauncher({
    interpreter: "/opt/Mix dog/it's/mixdog",
    entry: '/opt/한글 & 100%!/src/skill-script-entry.mjs',
    electron: true,
  });
  assert.deepEqual(text.split('\n'), [
    '#!/bin/sh',
    '# Mixdog skill-script launcher, generated for one installation. Do not edit.',
    'ELECTRON_RUN_AS_NODE=1',
    'export ELECTRON_RUN_AS_NODE',
    `exec '/opt/Mix dog/it'\\''s/mixdog' '/opt/한글 & 100%!/src/skill-script-entry.mjs' "$@"`,
    '',
  ]);
  assert.doesNotMatch(renderPosixSkillLauncher({ interpreter: '/n', entry: '/e', electron: false }), /ELECTRON/);
});

test('one launcher directory per installation holds the sh launcher and, on Windows, the .cmd of the same name', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-skill-launcher-'));
  try {
    const runtime = skillScriptRuntime({
      execPath: '/x/node',
      versions: {},
      packageRoot: '/pkg',
      platform: process.platform,
    });
    const dir = ensureSkillLauncherDir(runtime, dataDir);
    assert.equal(dir, skillLauncherDir(runtime, dataDir));
    const names = process.platform === 'win32' ? ['mixdog-skill-node', 'mixdog-skill-node.cmd'] : ['mixdog-skill-node'];
    assert.deepEqual(readdirSync(dir).sort(), names);
    assert.equal(readFileSync(join(dir, 'mixdog-skill-node'), 'utf8'), renderPosixSkillLauncher(runtime));
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'mixdog-skill-node')).mode & 0o777, 0o700);
    // Removed launchers are restored; a different runtime gets its own directory.
    rmSync(join(dir, names.at(-1)));
    assert.equal(ensureSkillLauncherDir(runtime, dataDir), dir);
    assert.deepEqual(readdirSync(dir).sort(), names);
    const moved = ensureSkillLauncherDir({ ...runtime, interpreter: '/y/node' }, dataDir);
    assert.notEqual(moved, dir);
    assert.match(readFileSync(join(moved, 'mixdog-skill-node'), 'utf8'), /\/y\/node/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the launcher directory goes first on PATH of the given env only, without duplicates', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-skill-path-'));
  try {
    const win = { ...skillScriptRuntime(), platform: 'win32' };
    const dir = skillLauncherDir(win, dataDir);
    const env = { Path: 'C:\\Windows;C:\\Tools' };
    assert.equal(withSkillLauncherPath(env, { runtime: win, dataDir }), env);
    assert.deepEqual(env, { Path: `${dir};C:\\Windows;C:\\Tools` });
    withSkillLauncherPath(env, { runtime: win, dataDir });
    assert.equal(env.Path, `${dir};C:\\Windows;C:\\Tools`);
    const posix = { ...skillScriptRuntime(), platform: 'linux' };
    const posixEnv = withSkillLauncherPath({}, { runtime: posix, dataDir });
    assert.equal(posixEnv.PATH, skillLauncherDir(posix, dataDir));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

/** `mixdog-skill-node <args>` by bare name through cmd (Windows) or sh. */
function runByName(args, options) {
  if (process.platform !== 'win32') {
    return run('/bin/sh', ['-c', 'mixdog-skill-node "$@"', 'sh', ...args], options);
  }
  const line = ['mixdog-skill-node', ...args.map((arg) => `"${arg}"`)].join(' ');
  return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

function posixQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function psQuote(value) {
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
}

function launcherEnv(root, dataDirName) {
  const script = join(root, 'scripts dir', 'probe script.mjs');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, PROBE);
  // Real node stands in for the app binary; the launcher still sets
  // ELECTRON_RUN_AS_NODE as it would for Electron.
  const runtime = { ...skillScriptRuntime(), interpreter: process.execPath, entry: ENTRY, electron: true };
  const env = withSkillLauncherPath({ ...process.env }, { runtime, dataDir: join(root, dataDirName) });
  delete env.ELECTRON_RUN_AS_NODE;
  return { script, env };
}

const PROBE = [
  "import { resolve } from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
  'console.log(JSON.stringify({',
  '  args: process.argv.slice(2),',
  '  main: import.meta.url === pathToFileURL(resolve(process.argv[1])).href,',
  "  electronMode: 'ELECTRON_RUN_AS_NODE' in process.env,",
  "  argvEnv: 'MIXDOG_SKILL_ARGV' in process.env,",
  '}));',
  'process.exitCode = 7;',
].join('\n');

const SPECIAL_ARGS = ['two words', 'üñí 한글', "it's", 'a & b', 'a&b', '50 %', '50%', 'wow !', 'wow!', ''];
const SPECIAL_DATA_DIR = "Jo O'Neil 한글 & 100% wow!";

test('mixdog-skill-node by name runs a script as the main module with every argument, its exit code, and no node-mode variable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog skill run '));
  try {
    const { script, env } = launcherEnv(root, SPECIAL_DATA_DIR);
    const result = await runByName([script, ...SPECIAL_ARGS], { cwd: root, env });
    assert.equal(result.code, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: SPECIAL_ARGS,
      main: true,
      electronMode: false,
      argvEnv: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** PowerShell 7 and, on Windows, the bundled Windows PowerShell 5.1. */
function powerShells() {
  const shells = [];
  const pwsh = resolveShellFor('powershell')?.shell;
  if (pwsh) shells.push(pwsh);
  if (process.platform === 'win32') {
    const bundled = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    if (existsSync(bundled) && !shells.some((shell) => shell.toLowerCase() === bundled.toLowerCase()))
      shells.push(bundled);
  }
  return shells;
}

const PS_ARGS = [
  'missing&ver',
  'a|b',
  'x;y',
  '$(whoami)',
  '%PATH%',
  '!x!',
  "it's",
  'say "hi"',
  'üñí 한글',
  'two words',
  '',
  'trailing\\',
];

test('PowerShell model commands carry a mixdog-skill-node function that the display form hides', async () => {
  const command = "mixdog-skill-node 'x.mjs'";
  const plan = await planShellInvocation({
    command,
    resolvedSpec: { shell: 'pwsh', shellArg: '-Command', shellArgs: ['-Command'], shellType: 'powershell' },
    cwd: tmpdir(),
  });
  const fn = renderPowerShellSkillFunction(skillScriptRuntime());
  assert.equal(
    plan.wrappedCommand,
    `${process.platform === 'win32' ? `${POWERSHELL_UTF8_PREFIX}\n` : ''}${fn}\n${command}`
  );
  assert.equal(displayShellCommand(plan.wrappedCommand), command);
  assert.equal(displayShellCommand(`${fn}\n${command}`), command);
  assert.equal(displayShellCommand('function other { }\nls'), 'function other { }\nls');
  // Electron node mode appears only in an Electron daemon's function; no
  // caller argument reaches the native command line.
  assert.doesNotMatch(fn, /ELECTRON_RUN_AS_NODE/);
  const runtime = skillScriptRuntime();
  const electronFn = renderPowerShellSkillFunction({ ...runtime, electron: true });
  assert.match(electronFn, /\$env:ELECTRON_RUN_AS_NODE = '1'/);
  assert.ok(electronFn.includes(`& ${psQuote(runtime.interpreter)} ${psQuote(runtime.entry)} } finally {`), electronFn);
  assert.match(
    renderPowerShellSkillFunction({ interpreter: "C:\\it's\u2019\\n.exe", entry: 'e', electron: false }),
    /'C:\\it''s\u2019\u2019\\n\.exe'/
  );
});

test('bash, sh and other non-PowerShell children never get the function', async () => {
  const command = 'mixdog-skill-node "x.mjs"';
  const plan = await planShellInvocation({
    command,
    resolvedSpec: { shell: 'bash', shellArg: '-c', shellArgs: ['-c'], shellType: 'posix' },
    cwd: tmpdir(),
  });
  for (const value of [plan.wrappedCommand, ...Object.values(plan.spawnEnv)]) {
    assert.doesNotMatch(String(value), /function mixdog-skill-node/);
  }
  for (const value of Object.values(buildShellSpawnEnv(tmpdir()))) {
    assert.doesNotMatch(String(value), /function mixdog-skill-node/);
  }
});

test('the argument hand-over survives every argument shape', () => {
  assert.equal(decodeSkillArgv(undefined), null);
  assert.equal(decodeSkillArgv('other'), null);
  assert.deepEqual(decodeSkillArgv('mixdog1'), []);
  assert.deepEqual(decodeSkillArgv('mixdog1,'), ['']);
  assert.deepEqual(decodeSkillArgv('mixdog1,,'), ['', '']);
  const encoded = `mixdog1${PS_ARGS.map((arg) => `,${Buffer.from(arg).toString('base64')}`).join('')}`;
  assert.deepEqual(decodeSkillArgv(encoded), PS_ARGS);
});

const STREAMS_SCRIPT = [
  "import { writeSync } from 'node:fs';",
  'const [mode, code] = process.argv.slice(2);',
  "if (mode === 'flood') {",
  '  for (let i = 0; i < 200000; i++) writeSync(1, `o${i}\\n`);',
  '} else {',
  "  for (const [fd, text] of [[1, 'out1 한글'], [2, 'err1 üñí 한글'], [1, 'out2'], [2, 'err2']]) {",
  '    writeSync(fd, `${text}\\n`);',
  '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);',
  '  }',
  '}',
  'process.exitCode = Number(code);',
].join('\n');

for (const shell of powerShells()) {
  test(`${basename(shell)}: mixdog-skill-node output behaves as a native command's`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog skill ps streams '));
    try {
      writeFileSync(join(root, 'streams.mjs'), STREAMS_SCRIPT);
      const fn = renderPowerShellSkillFunction({ interpreter: process.execPath, entry: ENTRY, electron: false });
      const prefix = `${process.platform === 'win32' ? `${POWERSHELL_UTF8_PREFIX}\n` : ''}${fn}\n`;
      const flags = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];
      const ps = (body) => run(shell, [...flags, `${prefix}${body}`], { cwd: root, env: process.env });
      const tag =
        'ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { "E:$_" } else { "O:$_" } }';
      const lines = (text) => text.trim().split(/\r?\n/);

      // 2>&1 merges stderr into the pipeline as error records (not exceptions,
      // not plain strings) while stdout stays plain strings, each stream in
      // its own order. PowerShell reads the child's two pipes independently,
      // so the interleaving between the streams is not defined and is not
      // asserted.
      const merged = await ps(`mixdog-skill-node 'streams.mjs' small 0 2>&1 | ${tag}; "after:$LASTEXITCODE"`);
      assert.equal(merged.code, 0, merged.stderr);
      const mergedLines = lines(merged.stdout);
      assert.equal(mergedLines.pop(), 'after:0');
      assert.equal(mergedLines.length, 4, mergedLines.join('\n'));
      assert.deepEqual(
        mergedLines.filter((line) => line.startsWith('O:')),
        ['O:out1 한글', 'O:out2']
      );
      assert.deepEqual(
        mergedLines.filter((line) => line.startsWith('E:')),
        ['E:err1 üñí 한글', 'E:err2']
      );

      // Early stop ends the producer and the command goes on.
      const flood = await ps("mixdog-skill-node 'streams.mjs' flood 0 | Select-Object -First 1; 'end'");
      assert.equal(flood.code, 0, flood.stderr);
      assert.deepEqual(lines(flood.stdout), ['o0', 'end']);

      // A failing script still fails the command, redirected or not.
      const failing = await ps(`mixdog-skill-node 'streams.mjs' small 7 2>&1 | Out-Null; 'not reached'`);
      assert.equal(failing.code, 7, failing.stderr);
      assert.equal(failing.stdout.trim(), '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${basename(shell)}: mixdog-skill-node runs the script directly with verbatim arguments and fails the command with its exit code`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog skill ps '));
    try {
      const { script, env } = launcherEnv(root, SPECIAL_DATA_DIR);
      writeFileSync(join(root, 'ok.mjs'), '');
      // Real node stands in for the app binary; the function still sets and
      // restores ELECTRON_RUN_AS_NODE as it would for Electron.
      const fn = renderPowerShellSkillFunction({ interpreter: process.execPath, entry: ENTRY, electron: true });
      const prefix = process.platform === 'win32' ? `${POWERSHELL_UTF8_PREFIX}\n` : '';
      const flags = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];
      const state = '"state:$($null -eq $env:MIXDOG_SKILL_ARGV):$($null -eq $env:ELECTRON_RUN_AS_NODE):$LASTEXITCODE"';
      // Both variables are removed after the call, or get their old value back.
      const command = [
        `${prefix}${fn}`,
        `mixdog-skill-node 'ok.mjs'; ${state}`,
        `$env:ELECTRON_RUN_AS_NODE = 'prev'; mixdog-skill-node 'ok.mjs'; "prev:$env:ELECTRON_RUN_AS_NODE"; $env:ELECTRON_RUN_AS_NODE = $null`,
        `mixdog-skill-node ${[script, ...PS_ARGS].map(psQuote).join(' ')}`,
        "'not reached'",
      ].join('\n');
      const result = await run(shell, [...flags, command], { cwd: root, env });
      assert.equal(result.code, 7, result.stderr);
      const lines = result.stdout.trim().split(/\r?\n/);
      assert.equal(lines.length, 3, result.stdout);
      assert.equal(lines[0], 'state:True:True:0');
      assert.equal(lines[1], 'prev:prev');
      assert.deepEqual(JSON.parse(lines[2]), { args: PS_ARGS, main: true, electronMode: false, argvEnv: false });

      // The reviewed failure: cmd used to split `missing&ver` and run `ver`.
      // Through the real planner, with and without the UTF-8 prefix already
      // in the command, and with the output discarded.
      for (const text of [
        "mixdog-skill-node 'missing&ver'\n'not reached'",
        `${POWERSHELL_UTF8_PREFIX}\nmixdog-skill-node 'missing&ver'\n'not reached'`,
        "mixdog-skill-node 'missing&ver' | Out-Null\n'not reached'",
      ]) {
        const plan = await planShellInvocation({
          command: text,
          resolvedSpec: { shell, shellArg: '-Command', shellArgs: flags, shellType: 'powershell' },
          cwd: root,
        });
        assert.equal(plan.wrappedCommand.split('function mixdog-skill-node {').length, 2, plan.wrappedCommand);
        const failing = await run(shell, [...flags, plan.wrappedCommand], { cwd: root, env });
        assert.equal(failing.code, 1, `${text}\n${failing.stdout}\n${failing.stderr}`);
        assert.equal(failing.stdout.trim(), '');
        assert.match(failing.stderr, /missing&ver/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('bash (Git Bash on Windows) resolves mixdog-skill-node by name and propagates arguments and the exit code', {
  skip: !resolveShellFor('bash') && 'no bash on this host',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog skill bash '));
  try {
    const { script, env } = launcherEnv(root, SPECIAL_DATA_DIR);
    const { shell } = resolveShellFor('bash');
    // The command reaches bash the way the shell tool delivers it: through
    // the environment and eval, so MSYS argv parsing never re-reads quotes.
    env.MIXDOG_SHELL_SCRIPT = `mixdog-skill-node ${[script, ...SPECIAL_ARGS].map(posixQuote).join(' ')}`;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    const result = await run(shell, ['-c', 'eval "${MIXDOG_SHELL_SCRIPT}"'], { cwd: root, env });
    assert.equal(result.code, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: SPECIAL_ARGS,
      main: true,
      electronMode: false,
      argvEnv: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Windows launcher whose runtime path is not ASCII still starts it', {
  skip: process.platform !== 'win32' && 'cmd code pages are Windows-only',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog skill unicode '));
  try {
    const nodeDir = join(root, '노드 런타임');
    symlinkSync(dirname(process.execPath), nodeDir, 'junction');
    const script = join(root, 'probe.mjs');
    writeFileSync(script, PROBE);
    const runtime = { ...skillScriptRuntime(), interpreter: join(nodeDir, basename(process.execPath)), entry: ENTRY };
    const env = withSkillLauncherPath({ ...process.env }, { runtime, dataDir: join(root, 'data') });
    assert.match(
      readFileSync(join(skillLauncherDir(runtime, join(root, 'data')), 'mixdog-skill-node.cmd'), 'utf8'),
      /chcp 65001/
    );
    const result = await runByName([script, '한글 인자'], { cwd: root, env });
    assert.equal(result.code, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).args, ['한글 인자']);
  } finally {
    // Remove the junction itself before the tree, never its target.
    unlinkSync(join(root, '노드 런타임'));
    rmSync(root, { recursive: true, force: true });
  }
});

test('the bootstrap rewrites argv, removes node mode, and preserves exit codes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog skill entry '));
  try {
    const script = join(root, 'probe.mjs');
    writeFileSync(script, PROBE);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const ok = await run(process.execPath, [ENTRY, 'probe.mjs', '--flag', ''], { cwd: root, env });
    assert.equal(ok.code, 7, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout), { args: ['--flag', ''], main: true, electronMode: false, argvEnv: false });

    // argv in the environment (the PowerShell function) only counts when the
    // command line carries none, and never reaches the script.
    const handed = `mixdog1,${Buffer.from('probe.mjs').toString('base64')},${Buffer.from('a&b').toString('base64')},`;
    const viaEnv = await run(process.execPath, [ENTRY], { cwd: root, env: { ...env, MIXDOG_SKILL_ARGV: handed } });
    assert.equal(viaEnv.code, 7, viaEnv.stderr);
    assert.deepEqual(JSON.parse(viaEnv.stdout), { args: ['a&b', ''], main: true, electronMode: false, argvEnv: false });
    const both = await run(process.execPath, [ENTRY, 'probe.mjs', 'cli'], {
      cwd: root,
      env: { ...env, MIXDOG_SKILL_ARGV: handed },
    });
    assert.deepEqual(JSON.parse(both.stdout).args, ['cli']);

    const usage = await run(process.execPath, [ENTRY], { cwd: root, env });
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /Usage:/);

    const missing = await run(process.execPath, [ENTRY, 'missing.mjs'], { cwd: root, env });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /missing\.mjs/);

    writeFileSync(join(root, 'throws.mjs'), "throw new Error('boom');");
    const thrown = await run(process.execPath, [ENTRY, 'throws.mjs'], { cwd: root, env });
    assert.equal(thrown.code, 1);
    assert.match(thrown.stderr, /boom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
