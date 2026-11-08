#!/usr/bin/env node
// Records what Node's `setExtensionScope` answers for a Skill when two sessions working in DIFFERENT folders ask the
// same thing. The real `createResourceApi` (src/session-runtime/resource-api.mjs) is built once per session, as the
// runtime does, over the real `createSkillsApi` listing bound to that session's own folder (`getCwd`/`getCurrentCwd`).
// The answer carries the folder the skills were read in (`cwd`) and, per skill, `activeHere` for THAT folder. Recorded per
// session: the request, the undecorated `skillsStatus()` the API read, the config it saved and the whole reply.
// The skill listing keeps only the user-global skills (the built-in ones do not depend on the folder and are 90 KB each);
// the sandbox folder is written `<BASE>`.
//
//   node benchmarks/rust-core/recorders/record-set-extension-scope-sessions.mjs --tree <git archive of b6f10295a with node_modules>
//
// Output: native/core/fixtures/set-extension-scope-sessions/golden.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'extension-scope-sessions-')));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const finalDir = join(FIXTURES_ROOT, 'set-extension-scope-sessions');
const stage = stageSet(finalDir);
const contextMod = await importFrom(tree, 'src/runtime/agent/orchestrator/context/collect.mjs');
const { createSkillsApi } = await importFrom(tree, 'src/session-runtime/skills-api.mjs');
const { createResourceApi } = await importFrom(tree, 'src/session-runtime/resource-api.mjs');

const base = join(sandbox, 'base');
const folders = { one: join(base, 'one'), two: join(base, 'two') };
for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
const onlyGlobal = {
  ...contextMod,
  collectSkillsCached: (cwd) => contextMod.collectSkillsCached(cwd).filter((skill) => skill.source === 'global'),
};
await createSkillsApi({ contextMod: onlyGlobal, getCwd: () => folders.one }).addGlobalSkill({
  name: 'deploy',
  description: 'Use when deploying.',
});
await createSkillsApi({ contextMod: onlyGlobal, getCwd: () => folders.one }).addGlobalSkill({
  name: 'review',
  description: 'Use when reviewing.',
});

const escaped = (path) => JSON.stringify(path).slice(1, -1);
const mask = (value) => JSON.parse(JSON.stringify(value).split(escaped(base)).join('<BASE>').split(escaped(sandbox)).join('<SANDBOX>'));

// Both sessions share one config (they share the data dir) and ask the same scope; only the folder differs.
const sessions = {};
let config = { theme: 'dark' };
for (const [id, folder] of Object.entries(folders)) {
  const skills = createSkillsApi({ contextMod: onlyGlobal, getCwd: () => folder });
  let undecorated = null;
  const saved = [];
  const api = createResourceApi({
    getConfig: () => config,
    getSession: () => null,
    getCurrentCwd: () => folder,
    cfgMod: {},
    mgr: {},
    hooks: {},
    saveConfigAndAdopt: (next) => {
      config = structuredClone(next);
      saved.push(structuredClone(next));
    },
    connectConfiguredMcp: async () => ({ servers: [] }),
    invalidatePreSessionToolSurface: () => {},
    recreateCurrentSessionIfReady: async () => {},
    normalizeMcpServerInput: () => {
      throw new Error('not used');
    },
    mcpStatus: () => ({ servers: [] }),
    skillsStatus: () => (undecorated = skills.skillsStatus()),
    pluginsStatus: () => ({ plugins: [] }),
    reloadFullConfig: () => {},
    getActiveTurnCount: () => 0,
    skillContent: skills.skillContent,
    addGlobalSkill: skills.addGlobalSkill,
    saveSkillDocument: skills.saveSkillDocument,
    removeGlobalSkill: skills.removeGlobalSkill,
    invalidateSkills: skills.invalidateSkills,
  });
  const request = { kind: 'skills', name: 'deploy', projects: [folders.one] };
  const reply = await api.setExtensionScope(request.kind, request.name, request.projects);
  api.disposeGlobalExtensionSubscription();
  if (reply.cwd !== folder) throw new Error(`${id}: the reply read ${reply.cwd}, not the session folder ${folder}`);
  sessions[id] = { folder, request, status: undecorated, saved, reply };
}
const activeHere = Object.fromEntries(
  Object.entries(sessions).map(([id, s]) => [id, Object.fromEntries(s.reply.skills.map((skill) => [skill.name, skill.activeHere]))])
);
if (activeHere.one.deploy !== true || activeHere.two.deploy !== false) throw new Error(`the folders must decide activeHere: ${JSON.stringify(activeHere)}`);

writeJson(join(stage, 'golden.json'), {
  domain: 'set-extension-scope-sessions',
  recorder: 'benchmarks/rust-core/recorders/record-set-extension-scope-sessions.mjs',
  sessions: mask(sessions),
});
writeSetManifest(stage, {
  set: 'set-extension-scope-sessions',
  recorder: 'benchmarks/rust-core/recorders/record-set-extension-scope-sessions.mjs',
  command: 'node benchmarks/rust-core/recorders/record-set-extension-scope-sessions.mjs --tree <tree>',
  identityTree: tree,
  identityRef: NODE_COMMIT,
});
commitStage(stage, finalDir);
console.log(`recorded setExtensionScope for ${Object.keys(sessions).length} sessions in different folders`);
