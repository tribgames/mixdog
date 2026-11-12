#!/usr/bin/env node
// Recording of the project list the desktop shows for a Node profile (b6f10295a): the real DesktopProjectRegistry
// (apps/desktop/src/main/desktop-project-registry.ts) over the real shared/projects.mjs (its MIXDOG_PROJECTS_FILE pointing at the case's
// projects.json) and the preferences sidecar desktop-projects.json of the case's profile folder. Each case prepares a profile (which of the two
// files exist, what they hold, which folders exist) and records `registry.list()`: the projects with their names, aliases and order
// (compareProjects) and the recents. The profile is described in the golden by relative folder names, from which the replay writes the same
// files under its own root; every path of the answer is written <root> + the folder name, with the separators Node produced.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-project-registry-import-cases.mjs --tree <export of b6f10295a with node_modules>
import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSet } from './lib/case-set.mjs';
import { parseArgs, resolveTree } from './lib/common.mjs';

const set = openSet('project-registry-import-cases', import.meta.url);
const tree = resolveTree(parseArgs());
const { DesktopProjectRegistry } = await set.load('apps/desktop/src/main/desktop-project-registry.ts');
const { makeTempDirSync } = await set.load('scripts/lib/scoped-temp.mjs');
const PROJECTS_URL = pathToFileURL(join(tree, 'src/runtime/shared/projects.mjs')).href;
let sequence = 0;
const roots = [];

// The registry file as Node wrote it: unsorted, a name only where it differs from the folder, a recency tie (gamma, delta).
const REGISTRY = [
  { path: 'alpha', addedAt: 1000 },
  { path: 'beta', name: 'beta', addedAt: 3000, lastSelectedAt: 5000 },
  { path: 'gamma', addedAt: 2000, lastSelectedAt: 2500 },
  { path: 'delta', addedAt: 2500 },
  { path: 'epsilon', name: 'Zed', addedAt: 4000 },
];

const SCENARIOS = [
  { name: 'projects.json only', registry: REGISTRY },
  { name: 'both files: aliases, one of a path that is not registered, one blank', registry: REGISTRY, preferences: { aliases: { alpha: 'The A', gamma: '  ', ghost: 'Ghost' }, hidden: [] } },
  { name: 'a tombstoned path that is still registered', registry: REGISTRY, preferences: { aliases: { beta: 'The B' }, hidden: ['beta', 'ghost'] } },
  { name: 'an entry whose folder no longer exists', registry: [...REGISTRY, { path: 'vanished', addedAt: 6000 }], missing: ['vanished'] },
  { name: 'neither file' },
  { name: 'desktop-projects.json only: nothing is registered', preferences: { aliases: { alpha: 'The A' }, hidden: ['beta'] } },
];

for (const scenario of SCENARIOS) {
  await set.run(scenario.name, async () => {
    const root = fs.realpathSync(makeTempDirSync('project-registry-import'));
    roots.push(root);
    try {
      const absolute = (name) => join(root, name);
      const profile = join(root, 'profile');
      fs.mkdirSync(profile);
      for (const entry of scenario.registry ?? []) if (!scenario.missing?.includes(entry.path)) fs.mkdirSync(absolute(entry.path));
      const registryFile = join(root, 'projects.json');
      if (scenario.registry) fs.writeFileSync(registryFile, JSON.stringify({ projects: scenario.registry.map(({ path, name, ...rest }) => ({ name: name ?? path, path: absolute(path), ...rest })) }));
      if (scenario.preferences) {
        const aliases = Object.fromEntries(Object.entries(scenario.preferences.aliases).map(([path, alias]) => [absolute(path), alias]));
        fs.writeFileSync(join(profile, 'desktop-projects.json'), JSON.stringify({ version: 2, aliases, hidden: scenario.preferences.hidden.map(absolute) }));
      }
      const saved = process.env.MIXDOG_PROJECTS_FILE;
      process.env.MIXDOG_PROJECTS_FILE = registryFile;
      let store;
      try { store = await import(`${PROJECTS_URL}?import=${sequence++}`); } finally { if (saved === undefined) delete process.env.MIXDOG_PROJECTS_FILE; else process.env.MIXDOG_PROJECTS_FILE = saved; }
      const registry = new DesktopProjectRegistry({ loadProjectsModule: async () => store, userDataRoot: () => profile });
      return { profile: scenario, listed: await registry.list() };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

await set.finish({
  entry: { runs: 'apps/desktop DesktopProjectRegistry.list over the real shared/projects.mjs and the real desktop-projects.json reader, over prepared profiles', notRun: 'no daemon, no Electron' },
  replay: { entry: 'the real `migrate` of the prepared Node profile, then the core\'s project registry import and project catalog listing: the same projects, names, aliases and order', normalised: { dataDir: '<root>, wherever it occurs; separators as Node produced them' } },
  replaceInText: roots.map((r) => [r, '<root>']),
  normaliseReason: 'per-run temp root written <root>',
});
process.exit(0);
