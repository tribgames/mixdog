import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSessionExtensionsApi } from '../tui/session/session-api/extensions.mjs';
import { createResourceApi } from './resource-api.mjs';

function resourceApi({ config, currentCwd, skillsStatus }) {
  return createResourceApi({
    getConfig: () => config,
    getSession: () => null,
    getCurrentCwd: () => currentCwd,
    cfgMod: {},
    mgr: {},
    hooks: {},
    saveConfigAndAdopt: () => {},
    connectConfiguredMcp: async () => ({ servers: [] }),
    invalidatePreSessionToolSurface: () => {},
    refreshEmptySessionToolPolicy: async () => {},
    recreateCurrentSessionIfReady: async () => {},
    normalizeMcpServerInput: () => {
      throw new Error('not used');
    },
    mcpStatus: () => ({ servers: [] }),
    skillsStatus,
    pluginsStatus: () => ({ plugins: [] }),
    reloadFullConfig: () => {},
    getActiveTurnCount: () => 0,
  });
}

test('skillsStatus({ cwd }) lists and scopes skills for that folder; anything but a directory is refused', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skills-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const other = join(root, 'other');
  mkdirSync(project);
  mkdirSync(other);
  writeFileSync(join(root, 'file.txt'), 'x');
  const listed = [];
  const api = resourceApi({
    config: { extensionScopes: { skills: { 'proj-only': [project] } } },
    currentCwd: other,
    skillsStatus: (options) => {
      listed.push(options?.cwd ?? null);
      return {
        skills: [
          { name: 'proj-only', enabled: true },
          { name: 'everywhere', enabled: true },
        ],
      };
    },
  });
  t.after(() => api.disposeGlobalExtensionSubscription());
  const activeHere = (status) => Object.fromEntries(status.skills.map((skill) => [skill.name, skill.activeHere]));

  // The session's own folder by default.
  assert.deepEqual(activeHere(api.skillsStatus()), { 'proj-only': false, everywhere: true });
  // A named folder (a draft's Project, resolved by the host).
  assert.deepEqual(activeHere(api.skillsStatus({ cwd: project })), { 'proj-only': true, everywhere: true });
  assert.deepEqual(listed, [null, project]);

  for (const options of [
    { cwd: 'relative/path' },
    { cwd: '' },
    { cwd: 3 },
    { cwd: join(root, 'missing') },
    { cwd: join(root, 'file.txt') },
    'x',
  ]) {
    assert.throws(() => api.skillsStatus(options), TypeError, JSON.stringify(options));
  }
  assert.deepEqual(listed, [null, project]);
});

test('the session protocol forwards skillsStatus options to the runtime', () => {
  const seen = [];
  const api = createSessionExtensionsApi({
    runtime: { skillsStatus: (options) => (seen.push(options), { skills: [] }) },
    getState: () => ({ commandBusy: false, stats: {} }),
    set: () => {},
    pushNotice: () => {},
    resetStatsAndSyncContext: () => {},
    routeState: () => ({}),
  });
  api.skillsStatus();
  api.skillsStatus({ cwd: 'C:/project' });
  assert.deepEqual(seen, [undefined, { cwd: 'C:/project' }]);
});
