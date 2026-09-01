import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionService,
  createSession,
  createProjectPicker,
  createPanelSurface,
  createStubSessionRuntime,
  withDaemon,
} from './_shared.mjs';


test('project registry and filesystem operations have one explicit daemon API', async () => {
  const rows = [];
  const touched = [];
  const projectStore = {
    listProjects: () => rows,
    resolveProjectPath: (value) => `resolved:${value}`,
    pathExists: (value) => value.includes('existing'),
    isDirectory: (value) => value.includes('directory'),
    addProject: (value) => {
      const project = { name: 'Added', path: value };
      rows.push(project);
      return project;
    },
    touchProjectSelected: (value) => {
      touched.push(value);
      return rows.find((row) => row.path === value) || null;
    },
    renameProject: (value, name) => {
      const project = rows.find((row) => row.path === value);
      if (!project) return null;
      project.name = name;
      return project;
    },
    removeProject: (value) => {
      const index = rows.findIndex((row) => row.path === value);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
    ensureDir: (value) => `created:${value}`,
  };
  const service = createSessionService({
    createSessionRuntime: async () => createStubSessionRuntime(),
    desktopRuntime: { loadProjects: async () => projectStore },
  });
  try {
    assert.deepEqual(await service.handleCall('project.list'), { projects: [] });
    assert.deepEqual(await service.handleCall('project.inspect', {
      path: 'existing-directory',
    }), {
      path: 'resolved:existing-directory',
      exists: true,
      directory: true,
    });
    const added = await service.handleCall('project.add', { path: 'C:\\project' });
    assert.equal(added.project.path, 'C:\\project');
    await service.handleCall('project.touch', { path: 'C:\\project' });
    assert.deepEqual(touched, ['C:\\project']);
    const renamed = await service.handleCall('project.rename', {
      path: 'C:\\project',
      name: 'Renamed',
    });
    assert.equal(renamed.project.name, 'Renamed');
    assert.deepEqual(await service.handleCall('project.ensureDirectory', {
      path: 'C:\\new',
    }), { path: 'created:C:\\new' });
    assert.deepEqual(await service.handleCall('project.remove', {
      path: 'C:\\project',
    }), { removed: true });
  } finally {
    await service.stop('test end');
  }
});

test('the TUI project picker awaits service switches and contains service failures', async () => {
  const calls = [];
  const notices = [];
  let picker = null;
  const factory = createProjectPicker({
    state: { cwd: 'C:\\current' },
    store: {
      listProjects: async () => [{ name: 'One', path: 'C:\\one' }],
      setCwd: async (path) => {
        calls.push(`cwd:${path}`);
        return path;
      },
      addProject: async (path) => {
        calls.push(`add:${path}`);
        return { name: 'One', path };
      },
      pushNotice: (message, tone) => notices.push([message, tone]),
    },
    surface: createPanelSurface({
      setPicker: (next) => {
        picker = typeof next === 'function' ? next(picker) : next;
      },
      setContextPanel: () => {},
      setUsagePanel: () => {},
    }),
    setProviderPrompt: () => {},
    setChannelPrompt: () => {},
    setHookPrompt: () => {},
    setSettingsPrompt: () => {},
    closeUsagePanel: () => {},
    projectNameFromPath: (value) => value,
    pickFolder: async () => ({ available: true, path: null }),
  });
  await factory.openProjectPicker();
  assert.equal(picker.items[0].value, 'C:\\one');
  assert.equal(await factory.enterProject('C:\\one'), true);
  assert.deepEqual(calls, ['cwd:C:\\one', 'add:C:\\one']);

  const failed = createProjectPicker({
    state: { cwd: 'C:\\current' },
    store: {
      setCwd: async () => { throw new Error('service rejected cwd'); },
      pushNotice: (message, tone) => notices.push([message, tone]),
    },
    surface: createPanelSurface({ setPicker: () => {}, setContextPanel: () => {}, setUsagePanel: () => {} }),
    setProviderPrompt: () => {},
    setChannelPrompt: () => {},
    setHookPrompt: () => {},
    setSettingsPrompt: () => {},
    closeUsagePanel: () => {},
    projectNameFromPath: (value) => value,
    pickFolder: async () => ({ available: true, path: null }),
  });
  assert.equal(await failed.enterProject('C:\\broken'), false);
  assert.ok(notices.some(([message, tone]) =>
    tone === 'error' && /service rejected cwd/.test(message)));
});

test('the remote TUI project surface uses only daemon project and cwd routes', async () => {
  const rows = [{ name: 'Shared', path: 'C:\\shared' }];
  const touched = [];
  const projectStore = {
    listProjects: () => rows,
    addProject: (path) => {
      const project = { name: 'Added', path };
      rows.push(project);
      return project;
    },
    touchProjectSelected: (path) => {
      touched.push(path);
      return rows.find((row) => row.path === path) || null;
    },
  };
  await withDaemon(async () => {
    const runtime = await createSession({ cwd: 'C:\\initial' });
    assert.deepEqual(await runtime.listProjects(), rows);
    assert.deepEqual(await runtime.addProject('C:\\added'), {
      name: 'Added',
      path: 'C:\\added',
    });
    assert.equal(await runtime.setCwd('C:\\shared'), 'C:\\shared');
    assert.equal(runtime.getState().cwd, 'C:\\shared');
    assert.equal(typeof runtime.getState().cwd, 'string');
    assert.deepEqual(touched, ['C:\\shared']);
    await runtime.dispose('test');
  }, {
    desktopRuntime: { loadProjects: async () => projectStore },
  });
});
