#!/usr/bin/env node
// What Node does with each class of path at the places the Rust workspace resolves a project path, recorded from an exact export of
// b6f10295a on this Windows host with the real project store (src/runtime/shared/projects.mjs) and the real registry:
//   known   DesktopProjectRegistry.knownPath (desktop-project-registry.ts:179): the registered project a path names, else the refusal;
//           the shape of `project/read`, `project/recoveryDirectory`, every project root and `transfer/trash/info` (ipc-server-files.ts:132
//           takes `projectDirectory` first, which is `knownPath`)
//   ensure  project-catalog.mjs `ensureProjectDirectory` (`ensureDir`, projects.mjs:239): the folder made and the absolute path it answers
//   add     SessionHost.canonicalDirectory (session-host.ts:575), what `addProject` registers (session-host.ts:674): `realpath` and a folder check
// The folder under test is a real project in a temporary folder that is the working directory; each input is a template (`{proj}`, `{tmp}`,
// ...) the replay fills in for its own folder, and each answer is recorded with the folder written back as the same token.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-project-path-classes.mjs --tree <git archive of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'project-path-classes');
const tree = resolveTree(parseArgs());

const tmp = mkdtempSync(join(realpathSync(tmpdir()), 'ppc-'));
const proj = join(tmp, 'proj');
mkdirSync(proj);
process.env.MIXDOG_PROJECTS_FILE = join(tmp, 'projects.json');
process.chdir(tmp);

const projects = await importFrom(tree, 'src/runtime/shared/projects.mjs');
const { DesktopProjectRegistry } = await importFrom(tree, 'apps/desktop/src/main/desktop-project-registry.ts');
const { createProjectCatalog } = await importFrom(tree, 'src/standalone/session-service/project-catalog.mjs');
const { SessionHost } = await importFrom(tree, 'apps/desktop/src/main/session-host.ts');
const { requiredString } = await importFrom(tree, 'apps/desktop/src/main/ipc-validation.ts');
if (!projects.addProject(proj)) throw new Error(`the project store did not register ${proj}`);

const registry = new DesktopProjectRegistry({ loadProjectsModule: async () => projects, userDataRoot: () => tmp });
const catalog = createProjectCatalog({ desktopRuntime: { loadProjects: () => projects } });

const root = parse(tmp).root;
const rooted = tmp.slice(root.length - 1);
const fill = {
  proj, tmp, PROJ: proj.toUpperCase(), TMP: tmp.toUpperCase(), tmpName: basename(tmp), drive: root.slice(0, 2),
  projSlash: proj.replaceAll('\\', '/'), projUpper: proj.toUpperCase(), tmpRooted: rooted, tmpRootedSlash: rooted.replaceAll('\\', '/'),
};
const expand = (template) => template.replace(/\{(\w+)\}/g, (_, name) => fill[name]);
// The folder as an answer spells it: as is, upper-cased (an answer that echoes an upper-case input) and as a JS string literal (an error
// message that quotes the path). The folder under test goes first: the temporary folder holds it.
const escaped = (text) => text.replaceAll('\\', '\\\\');
const tokens = [[proj, '{proj}'], [escaped(proj), '{proj}'], [proj.toUpperCase(), '{PROJ}'], [tmp, '{tmp}'], [escaped(tmp), '{tmp}'], [tmp.toUpperCase(), '{TMP}']];
const tokenize = (text) => tokens.reduce((out, [folder, token]) => out.replaceAll(folder, token), text);

const inputs = [
  ['absolute', '{proj}'],
  ['trailing separator', '{proj}\\'],
  ['forward slashes', '{projSlash}'],
  ['upper case', '{projUpper}'],
  ['dot-dot inside', '{proj}\\sub\\..'],
  ['padded', '  {proj}  '],
  ['relative', 'proj'],
  ['relative dot', '.\\proj'],
  ['relative dot-dot', '..\\{tmpName}\\proj'],
  ['relative, nothing there', 'other'],
  ['relative, a new nested folder', 'made\\deep'],
  ['rooted backslash', '{tmpRooted}\\proj'],
  ['rooted slash', '{tmpRootedSlash}/proj'],
  ['drive-relative', '{drive}proj'],
  ['absolute, not registered', '{tmp}\\other'],
  ['absolute, a new nested folder', '{tmp}\\made2\\deep'],
  ['device path', '\\\\?\\{proj}'],
  ['empty', ''],
  ['blank', '   '],
  ['NUL inside', '{proj}\u0000'],
].map(([name, template]) => ({ name, template }));

const answer = async (run, template) => {
  try {
    return { result: tokenize(String(await run(expand(template)))) };
  } catch (error) {
    return { error: { name: error.name, message: tokenize(error.message), ...(error.code ? { code: error.code } : {}) } };
  }
};
const operations = {
  known: (text) => registry.knownPath(text),
  ensure: async (text) => (await catalog.ensureProjectDirectory({ path: text })).path,
  add: (text) => SessionHost.prototype.canonicalDirectory.call(null, requiredString(text, 'projectPath')),
};
const answers = {};
for (const [name, run] of Object.entries(operations)) {
  answers[name] = [];
  for (const input of inputs) answers[name].push(await answer(run, input.template));
}

// The registry's own rule, `resolveProjectPath` (projects.mjs:251, `toAbsolute`), with the POSIX rules: projects.mjs loaded with node:path as
// path.posix (lib/posix-path-hook.mjs). Its working directory is a POSIX folder, the one a POSIX host would hand `process.cwd()`; it is the
// only thing the rule reads besides the input, and it is written into the recording.
const POSIX_CWD = '/home/user/work';
const POSIX_INPUTS = [
  ['absolute', '/home/user/proj'],
  ['trailing separator', '/home/user/proj/'],
  ['double slashes', '//home//user/proj'],
  ['dot-dot inside', '/home/user/proj/sub/..'],
  ['dot-dot above the root', '/../../proj'],
  ['padded', '  /home/user/proj  '],
  ['trimmed tab and newline', '\t/home/user/proj\n'],
  ['case is kept', '/Home/User/PROJ'],
  ['relative', 'proj'],
  ['relative dot', './proj'],
  ['relative dot-dot', '../work/proj'],
  ['relative, a nested folder', 'made/deep'],
  ['relative above the root', '../../../../x'],
  ['backslashes are a file name', 'a\\b'],
  ['drive-looking', 'C:\\proj'],
  ['drive-looking with slashes', 'C:/proj'],
  ['root', '/'],
  ['empty', ''],
  ['blank', '   '],
  ['NUL inside', '/home/user/pr\u0000oj'],
].map(([name, value]) => ({ name, value }));
register(pathToFileURL(join(REPO_ROOT, 'benchmarks', 'rust-core', 'recorders', 'lib', 'posix-path-hook.mjs')).href);
const posixProjects = await import(`${pathToFileURL(join(tree, 'src/runtime/shared/projects.mjs')).href}?posix`);
const windowsCwd = process.cwd;
process.cwd = () => POSIX_CWD;
const posixAnswers = POSIX_INPUTS.map((input) => ({ result: posixProjects.resolveProjectPath(input.value) }));
process.cwd = windowsCwd;

const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), {
  note: "What Node answers per class of project path, on a Windows host with the working directory on the project's parent: `known` (the registry's lookup), `ensure` (the folder the catalog makes) and `add` (the real path `addProject` registers); `{proj}` is the registered folder, `{tmp}` its parent. Answers are in the order of `inputs`.",
  inputs,
  answers,
  posix: {
    note: "resolveProjectPath (projects.mjs:251) loaded with node:path as path.posix and `cwd` as the working directory: Node's answers on a POSIX host, '' for an input it resolves to nothing.",
    cwd: POSIX_CWD,
    inputs: POSIX_INPUTS,
    answers: posixAnswers,
  },
});
writeSetManifest(out, {
  set: 'project-path-classes',
  recorder: 'benchmarks/rust-core/recorders/record-project-path-classes.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-project-path-classes.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
  extra: { inputs: inputs.length, operations: Object.keys(operations), posixInputs: POSIX_INPUTS.length },
});
commitStage(out, FIXTURES);
console.log(`project-path-classes: ${inputs.length} inputs x ${Object.keys(operations).join(', ')}`);
process.exit(0);