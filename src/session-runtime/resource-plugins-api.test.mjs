import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectSkillsCached, invalidateSkillsCache } from '../runtime/agent/orchestrator/context/skill-catalog.mjs';
import { createPluginsResourceApi } from './resource-plugins-api.mjs';

// Windows refuses to rename a directory that holds an open
// recursive fs.watch, which the skills catalog keeps on every enabled
// plugin's skills dir; POSIX allows it, so the regression only exists there.
const SKIP = process.platform !== 'win32';
const SKILL_MD = '---\nname: a\ndescription: test skill\n---\nbody\n';
const GIT_URL = 'https://plugins.example.test/watched.git';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

// An isolated data dir holding one managed, enabled git plugin whose skills
// dir is watched. The plugin's remote is redirected to a local repo, so
// updating it needs no network.
function watchedPluginFixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-plugins-api-'));
  const previous = {
    MIXDOG_DATA_DIR: process.env.MIXDOG_DATA_DIR,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    GIT_CONFIG_KEY_1: process.env.GIT_CONFIG_KEY_1,
    GIT_CONFIG_VALUE_1: process.env.GIT_CONFIG_VALUE_1,
  };
  t.after(() => {
    invalidateSkillsCache();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  });

  const remote = join(base, 'remote');
  mkdirSync(join(remote, 'skills', 'a'), { recursive: true });
  writeFileSync(join(remote, 'skills', 'a', 'SKILL.md'), SKILL_MD);
  git(remote, 'init', '-q');
  git(remote, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'add', '-A');
  git(remote, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'init');
  process.env.GIT_CONFIG_COUNT = '2';
  process.env.GIT_CONFIG_KEY_0 = `url.${remote}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = GIT_URL;
  // The temp dir can be deep enough to exceed MAX_PATH inside .git/objects.
  process.env.GIT_CONFIG_KEY_1 = 'core.longpaths';
  process.env.GIT_CONFIG_VALUE_1 = 'true';

  const dataDir = join(base, 'data');
  process.env.MIXDOG_DATA_DIR = dataDir;
  const id = 'watched-plugin';
  const root = join(dataDir, 'plugins', 'installed', id);
  mkdirSync(join(root, 'skills', 'a'), { recursive: true });
  writeFileSync(join(root, 'skills', 'a', 'SKILL.md'), SKILL_MD);
  writeFileSync(
    join(dataDir, 'plugins', 'registry.json'),
    JSON.stringify({
      version: 1,
      plugins: [{ id, name: id, title: id, source: GIT_URL, url: GIT_URL, sourceType: 'git', root, managed: true, enabled: true }],
    })
  );

  // Arm the recursive watcher on <plugin>\skills.
  invalidateSkillsCache();
  assert.ok(collectSkillsCached().some((skill) => skill.name === 'a'));

  const api = createPluginsResourceApi({
    deps: {
      getConfig: () => ({}),
      cfgMod: { getPluginData: () => dataDir },
      saveConfigAndAdopt: () => {},
      pluginsStatus: () => ({ plugins: [{ id, name: id, title: id }] }),
      invalidateSkills: invalidateSkillsCache,
    },
    sync: { reconcilePluginsAndAnnounce: async () => {} },
    decorate: {},
  });
  return { api, id, root };
}

test('updating a plugin whose skills dir is watched succeeds', { skip: SKIP }, async (t) => {
  const { api, id, root } = watchedPluginFixture(t);
  await api.updatePlugin(id);
  assert.equal(existsSync(join(root, 'skills', 'a', 'SKILL.md')), true);
  assert.equal(existsSync(`${root}.backup`), false);
});
