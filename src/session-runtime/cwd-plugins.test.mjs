import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';

import { createCwdPlugins } from './cwd-plugins.mjs';

test('explicit cwd selection persists execution cwd and desktop project metadata together', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cwd-persist-'));
  const before = join(root, 'before');
  const after = join(root, 'after');
  mkdirSync(before);
  mkdirSync(after);
  let currentCwd = before;
  let desktopSession = { classification: 'project', projectPath: before };
  const session = {
    id: 'sess-cwd-persist',
    cwd: before,
    desktopSession,
    clientHostPid: 4321,
  };
  const persisted = [];
  const sentinels = [];
  const overrides = [];
  try {
    const { applyResolvedCwd } = createCwdPlugins({
      getCurrentCwd: () => currentCwd,
      setCurrentCwd: (next) => { currentCwd = next; },
      getConfig: () => ({}),
      getSession: () => session,
      getDesktopSession: () => desktopSession,
      setDesktopSession: (next) => { desktopSession = next; },
      getRoute: () => ({}),
      isCodeGraphPrewarmLazy: () => true,
      isCodeGraphFirstTurnPrewarmDone: () => false,
      getCodeGraphPrewarmDelayMs: () => 0,
      setSessionNeedsCwdRefresh: () => {},
      scheduleCodeGraphPrewarm: () => {},
      hooks: { dispatch: async () => {} },
      hookCommonPayload: (value) => value,
      bootProfile: () => {},
      getMemoryModule: async () => null,
      listRegisteredPlugins: () => [],
      pluginAdminStatus: () => ({}),
      pluginManifest: () => ({}),
      pluginMcpServerName: () => '',
      mcpScriptForPlugin: () => '',
      countSkillFiles: () => 0,
      writeLastSessionCwd: (cwd, pid) => sentinels.push({ cwd, pid }),
      updateCurrentCwdOverride: (cwd) => overrides.push(cwd),
      persistSession: (value) => persisted.push(structuredClone(value)),
      clean: (value) => String(value || '').trim(),
      resolve,
      statSync,
      existsSync: () => false,
      cfgMod: {},
      STANDALONE_DATA_DIR: root,
    });

    applyResolvedCwd(after, { persistProjectSelection: true });

    assert.equal(currentCwd, after);
    assert.equal(session.cwd, after);
    assert.deepEqual(desktopSession, { classification: 'project', projectPath: after });
    assert.deepEqual(session.desktopSession, desktopSession);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].cwd, after);
    assert.deepEqual(persisted[0].desktopSession, desktopSession);
    assert.deepEqual(sentinels, [{ cwd: after, pid: 4321 }]);
    assert.deepEqual(overrides, [after]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
