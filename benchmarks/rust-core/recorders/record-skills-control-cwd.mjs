#!/usr/bin/env node
// Records what Node's skills actions answer on the desktop's control session. `ensureControlSession`
// (apps/desktop/src/main/session-host-transport.ts) opens it in `taskWorkspace()` = `<userData>/workspace/unclassified`, and
// every call without a session is served by it. Node's real `createSkillsApi` (the status listing, bound to the runtime's
// `currentCwd`, here that folder) sits under the real `createSkillsResourceApi` (the five desktop actions). Each action's whole
// response is recorded, with the sandbox data folder written `<DATA>`, and `cwdAt` names where the folder is in it:
// `cwd` for the two reads, `status.cwd` for the three mutations (`{ skill, status }`).
//
//   node benchmarks/rust-core/recorders/record-skills-control-cwd.mjs --tree <git clone at b6f10295a with node_modules>
//
// Output: native/core/fixtures/skills-control-cwd/golden.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'skills-control-cwd-')));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const finalDir = join(FIXTURES_ROOT, 'skills-control-cwd');
const stage = stageSet(finalDir);
const contextMod = await importFrom(tree, 'src/runtime/agent/orchestrator/context/collect.mjs');
const { createSkillsApi } = await importFrom(tree, 'src/session-runtime/skills-api.mjs');
const { createSkillsResourceApi } = await importFrom(tree, 'src/session-runtime/resource-skills-api.mjs');

// The control session's folder, as session-host.ts `taskWorkspace` makes it: created, then realpathed.
const dataDir = process.env.MIXDOG_DATA_DIR;
const sessionFolder = join(dataDir, 'userdata', 'workspace', 'unclassified');
mkdirSync(sessionFolder, { recursive: true });
const rt = { currentCwd: realpathSync(sessionFolder) };
const skills = createSkillsApi({ contextMod, getCwd: () => rt.currentCwd });
const resource = createSkillsResourceApi({
  deps: {
    skillsStatus: skills.skillsStatus,
    skillContent: skills.skillContent,
    addGlobalSkill: skills.addGlobalSkill,
    saveSkillDocument: skills.saveSkillDocument,
    removeGlobalSkill: skills.removeGlobalSkill,
    invalidateSkills: skills.invalidateSkills,
  },
  sync: { announce: async () => {} },
  decorate: { skills: (status) => status },
});

const escaped = (path) => JSON.stringify(path).slice(1, -1);
const mask = (value) =>
  JSON.parse(JSON.stringify(value).split(escaped(dataDir)).join('<DATA>').split(escaped(tree)).join('<TREE>'));
const answered = {};
const record = (action, response, cwdAt) => {
  const folder = cwdAt.split('.').reduce((value, key) => value[key], response);
  if (folder !== rt.currentCwd) throw new Error(`${action}: ${cwdAt} is ${folder}, not the session folder`);
  answered[action] = { cwdAt, response: mask(response) };
};
record('skillsStatus', await resource.skillsStatus(), 'cwd');
record('addSkill', await resource.addSkill({ name: 'control-skill', description: 'Use when recording the control folder.' }), 'status.cwd');
record(
  'saveSkill',
  await resource.saveSkill({ originalName: 'control-skill', name: 'control-skill', description: 'Use when saved.', instructions: '# Saved' }),
  'status.cwd'
);
record('removeSkill', await resource.removeSkill({ name: 'control-skill' }), 'status.cwd');
record('reloadSkills', await resource.reloadSkills(), 'cwd');

writeJson(join(stage, 'golden.json'), {
  domain: 'skills-control-cwd',
  recorder: 'benchmarks/rust-core/recorders/record-skills-control-cwd.mjs',
  sessionFolder: `<DATA>/${relative(dataDir, sessionFolder).split('\\').join('/')}`,
  answered,
});
writeSetManifest(stage, {
  set: 'skills-control-cwd',
  recorder: 'benchmarks/rust-core/recorders/record-skills-control-cwd.mjs',
  command: 'node benchmarks/rust-core/recorders/record-skills-control-cwd.mjs --tree <tree>',
  identityTree: tree,
  identityRef: NODE_COMMIT,
});
commitStage(stage, finalDir);
console.log(`recorded ${Object.keys(answered).length} skills responses on the control session folder`);
