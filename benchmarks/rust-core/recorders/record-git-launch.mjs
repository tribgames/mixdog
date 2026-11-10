#!/usr/bin/env node
// Golden twin of the git executable product code starts and the environment it starts with
// (`src/runtime/shared/git-launch.mjs`: `resolveGitLaunch`, `gitLaunchEnvironment`).
//
// Each layout scenario builds a real Git for Windows lookalike on disk (empty files and
// directories: the resolution only looks at which exist), calls `resolveGitLaunch` with a PATH
// naming it and records the launch (or null). Each environment scenario calls
// `gitLaunchEnvironment` with an explicit base environment and records the whole result. The
// folder the scenario ran in is written as `<ROOT>` (the same placeholder the Rust replay puts
// in its own folder); the system directory the HOME rule compares with is recorded as
// `systemRoot`.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, commitStage, writeSetManifest, writeText } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = realpathSync.native(mkdtempSync(join(resolve(args.get('work') ?? tmpdir()), 'git-launch-')));
const { resolveGitLaunch, gitLaunchEnvironment } = await importFrom(tree, 'src/runtime/shared/git-launch.mjs');

const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';

// Files ('name') and directories ('name/') of a layout, relative to a scenario's folder.
const INSTALL = ['git-bash.exe', 'usr/bin/', 'cmd/git.exe', 'bin/git.exe', 'mingw64/bin/git.exe'];
const layouts = [
  { id: 'installer', files: INSTALL, path: '<ROOT>\\cmd' },
  { id: 'bin launcher', files: INSTALL, path: '<ROOT>\\bin' },
  { id: 'quoted entry with spaces', files: INSTALL, path: '  "<ROOT>\\cmd"  ' },
  { id: 'empty entries first', files: INSTALL, path: ';; ;<ROOT>\\cmd;' },
  { id: 'upper-case directory', files: ['git-bash.exe', 'usr/bin/', 'CMD/git.exe', 'mingw64/bin/git.exe'], path: '<ROOT>\\CMD' },
  { id: 'clangarm64 only', files: ['git-bash.exe', 'usr/bin/', 'cmd/git.exe', 'clangarm64/bin/git.exe'], path: '<ROOT>\\cmd' },
  { id: 'mingw32 only', files: ['git-bash.exe', 'usr/bin/', 'cmd/git.exe', 'mingw32/bin/git.exe'], path: '<ROOT>\\cmd' },
  { id: 'two msystems', files: [...INSTALL, 'mingw32/bin/git.exe'], path: '<ROOT>\\cmd' },
  { id: 'no msystem', files: ['git-bash.exe', 'usr/bin/', 'cmd/git.exe'], path: '<ROOT>\\cmd' },
  { id: 'no git-bash.exe', files: ['usr/bin/', 'cmd/git.exe', 'mingw64/bin/git.exe'], path: '<ROOT>\\cmd' },
  { id: 'no usr/bin', files: ['git-bash.exe', 'cmd/git.exe', 'mingw64/bin/git.exe'], path: '<ROOT>\\cmd' },
  { id: 'not cmd or bin', files: ['git-bash.exe', 'usr/bin/', 'tools/git.exe', 'mingw64/bin/git.exe'], path: '<ROOT>\\tools' },
  { id: 'git.com beside git.exe', files: [...INSTALL, 'cmd/git.com'], path: '<ROOT>\\cmd' },
  { id: 'git.com in an earlier entry', files: [...INSTALL, 'shim/git.com'], path: '<ROOT>\\shim;<ROOT>\\cmd' },
  { id: 'another git.exe first', files: [...INSTALL, 'other/git.exe'], path: '<ROOT>\\other;<ROOT>\\cmd' },
  { id: 'relative entry first', files: INSTALL, path: 'relative\\dir;<ROOT>\\cmd' },
  { id: 'rooted entry without a drive is absolute', files: INSTALL, path: '\\no-such-folder-for-git;<ROOT>\\cmd' },
  { id: 'forward slashes', files: INSTALL, path: '<ROOT>/cmd' },
  { id: 'no git.exe on PATH', files: INSTALL, path: '<ROOT>\\usr\\bin' },
  { id: 'empty PATH', files: INSTALL, path: '' },
  { id: 'msys config', files: [...INSTALL, 'etc/git-bash.config'], path: '<ROOT>\\cmd', config: '# comment\r\nMSYS=winsymlinks:nativestrict\r\nOTHER=1\nMSYS=error_start=\\x\n  MSYS=indented\n' },
];
// The same layout reached through the administrator share of its drive: a UNC path.
const drive = work.slice(0, 1);
layouts.push({ id: 'unc path', files: INSTALL, path: '<UNC>\\cmd' });

const withRoot = (text, root, unc) => String(text).replaceAll('<ROOT>', root).replaceAll('<UNC>', unc);
const masked = (value, root, unc) =>
  typeof value === 'string' ? value.replaceAll(unc, '<UNC>').replaceAll(root, '<ROOT>') : Array.isArray(value) ? value.map((v) => masked(v, root, unc)) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, masked(v, root, unc)])) : value;

function build(name, scenario) {
  const root = join(work, name);
  mkdirSync(root);
  for (const entry of scenario.files) {
    const full = join(root, entry);
    if (entry.endsWith('/')) mkdirSync(full, { recursive: true });
    else {
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, entry === 'etc/git-bash.config' ? scenario.config : '');
    }
  }
  return root;
}

const layoutCases = layouts.map((scenario, index) => {
  const root = build(`layout-${index}`, scenario);
  const unc = `\\\\localhost\\${drive}$${root.slice(2)}`;
  const launch = resolveGitLaunch({ platform: 'win32', pathValue: withRoot(scenario.path, root, unc) });
  return { id: scenario.id, files: scenario.files, config: scenario.config ?? null, path: scenario.path, launch: masked(launch, root, unc) };
});
const found = layoutCases.filter((c) => c.launch !== null).length;
if (found < 10 || found === layoutCases.length) throw new Error(`${found} of ${layoutCases.length} layouts resolve`);
const uncCase = layoutCases.find((c) => c.id === 'unc path');
if (!uncCase.launch?.root.startsWith('<UNC>')) throw new Error(`the UNC layout resolved to ${JSON.stringify(uncCase.launch)}`);

// ── the environment ─────────────────────────────────────────────────────────
const SYSTEM32 = `${systemRoot}\\System32`;
const envScenarios = [
  { id: 'home from USERPROFILE', base: { PATH: 'C:\\x', USERPROFILE: 'C:\\Users\\u' } },
  { id: 'HOME kept', base: { PATH: 'C:\\x', HOME: 'C:\\h', USERPROFILE: 'C:\\Users\\u' } },
  { id: 'HOME from an existing HOMEPATH', base: { PATH: 'C:\\x', HOMEDRIVE: '', HOMEPATH: '<ROOT>\\home', USERPROFILE: 'C:\\Users\\u' }, dirs: ['home/'] },
  { id: 'HOMEPATH that is not a folder', base: { PATH: 'C:\\x', HOMEDRIVE: '', HOMEPATH: '<ROOT>\\nowhere', USERPROFILE: 'C:\\Users\\u' } },
  { id: 'HOMEPATH without USERPROFILE', base: { PATH: 'C:\\x', HOMEDRIVE: '', HOMEPATH: '<ROOT>\\nowhere' } },
  { id: 'HOMEPATH is the system directory', base: { PATH: 'C:\\x', HOMEDRIVE: '', HOMEPATH: '<SYSTEM32>', USERPROFILE: 'C:\\Users\\u' } },
  { id: 'HOMEPATH is the system directory in other case', base: { PATH: 'C:\\x', HOMEDRIVE: '', HOMEPATH: '<SYSTEM32>', USERPROFILE: 'C:\\Users\\u' }, lower: true },
  { id: 'no home at all', base: { PATH: 'C:\\x' } },
  { id: 'HOME ending in a backslash', base: { PATH: 'C:\\x', HOME: 'C:\\h\\' } },
  { id: 'PLINK_PROTOCOL kept', base: { PATH: 'C:\\x', PLINK_PROTOCOL: 'telnet', HOME: 'C:\\h' } },
  { id: 'MSYS prepended', base: { PATH: 'C:\\x', MSYS: 'existing', HOME: 'C:\\h' }, layout: 'msys config' },
  { id: 'MSYS from the config alone', base: { PATH: 'C:\\x', HOME: 'C:\\h' }, layout: 'msys config' },
  { id: 'MSYSTEM replaced', base: { PATH: 'C:\\x', MSYSTEM: 'MINGW32', HOME: 'C:\\h' } },
  { id: 'names in other case', base: { path: 'C:\\x', home: 'C:\\h', Msystem: 'X', plink_protocol: 'p' } },
  { id: 'two spellings of PATH', base: { Path: 'C:\\lower', PATH: 'C:\\upper', HOME: 'C:\\h' } },
  { id: 'two spellings of HOME', base: { PATH: 'C:\\x', home: 'C:\\low', HOME: 'C:\\up' } },
  { id: 'no PATH', base: { HOME: 'C:\\h' } },
  { id: 'other variables untouched', base: { PATH: 'C:\\x', HOME: 'C:\\h', Foo: 'bar', EMPTY: '' } },
];
const envCases = envScenarios.map((scenario, index) => {
  const layoutId = scenario.layout ?? 'installer';
  const definition = layouts.find((l) => l.id === layoutId);
  const root = build(`env-${index}`, { ...definition, files: [...definition.files, ...(scenario.dirs ?? [])] });
  const unc = `\\\\localhost\\${drive}$${root.slice(2)}`;
  const launch = resolveGitLaunch({ platform: 'win32', pathValue: withRoot(definition.path, root, unc) });
  if (!launch) throw new Error(`${scenario.id}: no launch`);
  const system32 = scenario.lower ? SYSTEM32.toLowerCase() : SYSTEM32;
  const base = Object.fromEntries(Object.entries(scenario.base).map(([k, v]) => [k, withRoot(v, root, unc).replaceAll('<SYSTEM32>', system32)]));
  const env = gitLaunchEnvironment(launch, base);
  return { id: scenario.id, layout: layoutId, dirs: scenario.dirs ?? [], lowerSystem32: scenario.lower === true, base: scenario.base, env: masked(env, root, unc) };
});
if (!envCases.some((c) => c.env.HOME === '<ROOT>\\home')) throw new Error('no scenario took HOME from HOMEPATH');

// ── the environment a git child gets: the caller's variables first, the launcher's on top ───
// `gitChildEnv(env)` takes the whole environment the child would have (the process's with the
// caller's changes applied), so a PATH, MSYSTEM or MSYS the caller set is transformed like any
// inherited one. `process` is the inherited environment, `set` and `remove` the caller's changes;
// PATH is the one the layout is resolved from, so `pathFrom` names where it comes from.
const { gitCommand, gitChildEnv } = await importFrom(tree, 'src/runtime/shared/git-launch.mjs');
const mergeScenarios = [
  { id: 'nothing from the caller', process: { PATH: '<ROOT>\\cmd;C:\\p', HOME: 'C:\\h' }, set: {}, remove: [] },
  { id: 'caller PATH names the install', process: { PATH: 'C:\\p', HOME: 'C:\\h' }, set: { PATH: '<ROOT>\\cmd;C:\\caller' }, remove: [] },
  { id: 'caller PATH replaces an inherited one', process: { PATH: '<ROOT>\\cmd;C:\\inherited', HOME: 'C:\\h' }, set: { PATH: '<ROOT>\\cmd;C:\\caller' }, remove: [] },
  { id: 'caller MSYSTEM', process: { PATH: '<ROOT>\\cmd', HOME: 'C:\\h' }, set: { MSYSTEM: 'UCRT64' }, remove: [] },
  { id: 'caller MSYS with a config', layout: 'msys config', process: { PATH: '<ROOT>\\cmd', HOME: 'C:\\h' }, set: { MSYS: 'mine' }, remove: [] },
  { id: 'caller PLINK_PROTOCOL and HOME', process: { PATH: '<ROOT>\\cmd', USERPROFILE: 'C:\\Users\\u' }, set: { PLINK_PROTOCOL: 'telnet', HOME: 'C:\\callerhome' }, remove: [] },
  { id: 'caller removes HOME', process: { PATH: '<ROOT>\\cmd', HOME: 'C:\\h' }, set: {}, remove: ['HOME'] },
  { id: 'caller removes USERPROFILE', process: { PATH: '<ROOT>\\cmd', USERPROFILE: 'C:\\Users\\u' }, set: {}, remove: ['USERPROFILE'] },
  { id: 'caller sets everything at once', layout: 'msys config', process: { PATH: 'C:\\p', MSYS: 'inherited', HOME: 'C:\\h' }, set: { PATH: '<ROOT>\\cmd', MSYSTEM: 'X', MSYS: 'mine', GIT_TERMINAL_PROMPT: '0' }, remove: [] },
  { id: 'no install on the caller PATH', process: { PATH: '<ROOT>\\cmd', HOME: 'C:\\h' }, set: { PATH: 'C:\\nothing', MSYSTEM: 'X' }, remove: [] },
];
const mergeCases = mergeScenarios.map((scenario, index) => {
  const layoutId = scenario.layout ?? 'installer';
  const definition = layouts.find((l) => l.id === layoutId);
  const root = build(`merge-${index}`, definition);
  const unc = `\\\\localhost\\${drive}$${root.slice(2)}`;
  const insert = (value) => withRoot(value, root, unc);
  const env = Object.fromEntries(Object.entries(scenario.process).map(([k, v]) => [k, insert(v)]));
  for (const name of scenario.remove) delete env[name];
  for (const [name, value] of Object.entries(scenario.set)) env[name] = insert(value);
  const command = gitCommand(env);
  const child = gitChildEnv(env);
  return { id: scenario.id, layout: layoutId, process: scenario.process, set: scenario.set, remove: scenario.remove, command: masked(command, root, unc), env: masked(child, root, unc) };
});
if (!mergeCases.some((c) => c.command !== 'git') || !mergeCases.some((c) => c.command === 'git')) throw new Error('the merge scenarios must both resolve and not resolve a launch');

const stage = stageSet(join(FIXTURES_ROOT, 'git-launch'));
writeText(join(stage, 'launch.json'), `${JSON.stringify({ systemRoot, layouts: layoutCases, environments: envCases, merges: mergeCases }, null, 1)}\n`);
writeSetManifest(stage, {
  set: 'git-launch',
  recorder: 'benchmarks/rust-core/recorders/record-git-launch.mjs',
  command: 'node benchmarks/rust-core/recorders/record-git-launch.mjs --tree <tree> --ref <ref>',
  identityTree: tree,
  identityRef: args.get('ref') ?? 'HEAD',
});
commitStage(stage, join(FIXTURES_ROOT, 'git-launch'));
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${join(FIXTURES_ROOT, 'git-launch')}`);
process.exit(0);
