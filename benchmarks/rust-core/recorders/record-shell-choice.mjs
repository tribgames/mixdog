#!/usr/bin/env node
// Golden twin of the shell one spawn runs under (`shell-runtime.mjs`): Node's real
// `setConfiguredShell` and `resolveShellFor('default')` over the "system shell" setting, the
// `MIXDOG_SHELL` variable and the platform. `process.platform` is stubbed per scenario (the
// resolver reads it on every call); each scenario starts from a freshly dropped resolution, as
// a changed setting does.
//
//   node benchmarks/rust-core/recorders/record-shell-choice.mjs --tree <dir with node_modules>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Recorder isolation: no user directory of this machine is touched.
const scratch = mkdtempSync(join(tmpdir(), 'rec-shell-choice-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(scratch, name);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const { importFrom, parseArgs, REPO_ROOT, resolveTree, writeJson } = await import('./lib/common.mjs');

const cli = parseArgs();
const tree = resolveTree(cli);
const runtime = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs');

const REALLY = process.platform;
const platform = (name) => Object.defineProperty(process, 'platform', { value: name, configurable: true });
const setEnv = (value) => (value === null ? delete process.env.MIXDOG_SHELL : (process.env.MIXDOG_SHELL = value));
// A value no scenario uses, so the next `setConfiguredShell` always sees a change.
const DROP = '\u0001drop';
// The machine's own default shell (found by probing its disks) is written `<default>`: the
// scenarios choose between "the default" and an explicit program, never a particular default.
let machineDefault = null;
const chosen = () => {
  const spec = runtime.resolveShellFor('default');
  return { shell: spec.shell === machineDefault ? '<default>' : spec.shell, shellType: spec.shellType };
};

const CONFIGURED = [
  '',
  'pwsh',
  'powershell',
  'pwsh.exe',
  'PowerShell.EXE',
  '  pwsh  ',
  'D:\\Tools\\PowerShell\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  '/usr/bin/pwsh',
  'bash',
  'zsh',
  'sh',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\bin\\bash.exe\\',
  'cmd.exe',
  'C:\\tools\\pwsh.cmd',
];
const ENV = [null, '', 'pwsh', ' pwsh ', 'bash', 'cmd.exe', 'D:\\Tools\\PowerShell\\pwsh.exe'];

const defaults = {};
const cases = [];
for (const name of ['win32', 'linux', 'darwin']) {
  platform(name);
  setEnv(null);
  runtime.setConfiguredShell(DROP);
  runtime.setConfiguredShell('');
  machineDefault = runtime.resolveShellFor('default').shell;
  defaults[name] = chosen().shellType;
  // Off Windows neither the setting nor the variable matters; a few scenarios say so.
  const configured = name === 'win32' ? CONFIGURED : ['', 'pwsh', 'bash'];
  const envs = name === 'win32' ? ENV : [null, 'pwsh'];
  for (const value of configured) {
    for (const env of envs) {
      runtime.setConfiguredShell(DROP);
      runtime.setConfiguredShell(value);
      setEnv(env);
      cases.push({ platform: name, configured: value, env, ...chosen() });
    }
  }
}

// One process, no forced drop: the setting changes between spawns, the resolver follows each
// change (a repeated value keeps its resolution).
platform('win32');
setEnv(null);
runtime.setConfiguredShell(DROP);
runtime.setConfiguredShell('');
machineDefault = runtime.resolveShellFor('default').shell;
const sequence = [];
for (const value of ['', 'pwsh', 'pwsh', 'bash', 'D:\\Tools\\PowerShell\\pwsh.exe', '', 'powershell.exe']) {
  runtime.setConfiguredShell(value);
  sequence.push({ set: value, ...chosen() });
}
platform(REALLY);
setEnv(null);

writeJson(
  join(REPO_ROOT, 'native', 'core', 'crates', 'mixdog-tools', 'src', 'exec', 'testdata', 'shell_choice.json'),
  { defaults, cases, sequence },
);
console.log(`shell choice: ${cases.length} cases, ${sequence.length} sequence steps`);
