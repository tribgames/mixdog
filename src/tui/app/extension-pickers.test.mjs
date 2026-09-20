import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createExtensionPickers } from './extension-pickers.mjs';

// The MCP / Skills / Plugins picker cluster against a fake store: what each
// list paints, how toggles reopen optimistically and settle, and where the
// detail panels navigate.

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness({ store: overrides = {}, disabled = new Set() } = {}) {
  supersedePanelEpoch();
  let live = null;
  const painted = [];
  const notices = [];
  const prompts = [];
  const disabledWrites = [];
  const clipboard = [];
  let disabledSkills = disabled;
  const surface = createPanelSurface({
    setPicker: (next) => {
      const previous = live;
      live = typeof next === 'function' ? next(previous) : next;
      if (shouldSupersedePanelEpoch(previous, live)) supersedePanelEpoch();
      painted.push(live);
    },
    setContextPanel: () => {},
    setUsagePanel: () => {},
  });
  const store = {
    pushNotice: (message, tone) => notices.push([message, tone]),
    ...overrides,
  };
  const pickers = createExtensionPickers({
    store,
    theme: { success: 'green', inactive: 'gray' },
    clean: (value) => String(value || '').trim(),
    copyToClipboard: async (text) => {
      clipboard.push(text);
    },
    surface,
    getPicker: () => live,
    setProviderPrompt: () => {},
    setSettingsPrompt: (prompt) => prompts.push(prompt),
    getDisabledSkills: () => disabledSkills,
    setDisabledSkills: (next) => {
      disabledSkills = typeof next === 'function' ? next(disabledSkills) : next;
      disabledWrites.push(new Set(disabledSkills));
    },
  });
  const current = () => live;
  const select = (item) => current().onSelect(item.value, item);
  const row = (value) => current().items.find((item) => item.value === value);
  return { ...pickers, current, select, row, painted, notices, prompts, disabledWrites, clipboard };
}

test('MCP list: markers and scoped descriptions, a toggle reopens optimistically then settles', async () => {
  const gate = deferred();
  const toggles = [];
  let enabled = true;
  const h = createHarness({
    store: {
      mcpStatus: async () => ({
        servers: [
          { name: 'graph', enabled, transport: 'stdio', status: 'ready', toolCount: 3, scope: ['a', 'b'] },
          { name: 'web', enabled: false, transport: 'http', error: 'boom' },
        ],
      }),
      setMcpServerEnabled: (name, target) => {
        toggles.push([name, target]);
        return gate.promise;
      },
    },
  });
  await h.openMcpServersPicker();
  await flush();
  const list = h.current();
  assert.equal(list._kind, 'mcp-servers');
  assert.deepEqual(
    list.items.map((item) => [item.value, item.marker, item.description]),
    [
      ['server:graph', '●', 'config · ready · stdio · 3 tools · 2 projects'],
      ['server:web', '○', 'config · unknown · http · 0 tools · boom'],
    ]
  );

  list.onLeft(h.row('server:graph'));
  await flush();
  assert.deepEqual(toggles, [['graph', false]]);
  assert.equal(h.row('server:graph').marker, '○', 'optimistic flip');
  assert.equal(h.row('server:graph').description, 'disabling… · stdio');
  assert.equal(h.current().initialIndex, 0);

  enabled = false;
  gate.resolve();
  await flush();
  assert.equal(h.row('server:graph').description, 'config · ready · stdio · 3 tools · 2 projects');
  assert.equal(h.row('server:graph').marker, '○');
});

test('MCP toggle settle after Esc paints nothing', async () => {
  const gate = deferred();
  const h = createHarness({
    store: {
      mcpStatus: async () => ({ servers: [{ name: 'graph', enabled: true }] }),
      setMcpServerEnabled: () => gate.promise,
    },
  });
  await h.openMcpServersPicker();
  await flush();
  h.current().onRight(h.row('server:graph'));
  await flush();
  h.current().onCancel();
  assert.equal(h.current(), null);
  const paintedBefore = h.painted.length;
  gate.resolve();
  await flush();
  assert.equal(h.painted.length, paintedBefore);
  assert.equal(h.current(), null);
});

test('Skills: a toggle records the disabled set, notifies, and reopens without refetching', async () => {
  let statusCalls = 0;
  const h = createHarness({
    store: {
      skillsStatus: async () => {
        statusCalls += 1;
        return {
          skills: [
            { name: 'docx', source: 'built-in', description: 'Word files', activeHere: false },
            { name: 'pdf', source: 'built-in', description: 'PDF files' },
          ],
        };
      },
    },
  });
  await h.openSkillsPicker();
  await flush();
  assert.equal(h.current()._kind, 'skills');
  assert.equal(h.row('docx').description, 'built-in · Word files · not in this project');
  assert.equal(h.row('docx').marker, '●');

  h.select(h.row('docx'));
  await flush();
  assert.deepEqual([...h.disabledWrites.at(-1)], ['docx']);
  assert.deepEqual(h.notices.at(-1), ['skill disabled: docx (prompt updates next session /clear)', 'info']);
  assert.equal(h.row('docx').marker, '○');
  assert.equal(h.current().items[h.current().initialIndex].value, 'docx');
  assert.equal(statusCalls, 1, 'the reopen reuses the fetched skills');

  h.current().onLeft(h.row('docx'));
  await flush();
  assert.deepEqual([...h.disabledWrites.at(-1)], []);
  assert.equal(h.row('docx').marker, '●');
});

test('Skill detail: Use opens the skill prompt; Enable/Disable update the set and return to Skills', async () => {
  const h = createHarness({
    store: { skillsStatus: async () => ({ skills: [{ name: 'pdf', source: 'built-in', description: 'PDF files' }] }) },
    disabled: new Set(['pdf']),
  });
  h.openSkillDetailPicker({ name: 'pdf', description: 'PDF files', whenToUse: 'PDF work' });
  let panel = h.current();
  assert.equal(panel.title, 'Skill · pdf');
  assert.equal(panel.description, 'PDF files — PDF work');
  assert.deepEqual(
    panel.items.map((item) => [item.value, item._action]),
    [
      ['use', 'noop'],
      ['enable', 'enable'],
    ]
  );
  h.select(h.row('enable'));
  await flush();
  assert.deepEqual([...h.disabledWrites.at(-1)], []);
  assert.equal(h.current()._kind, 'skills');

  h.openSkillDetailPicker({ name: 'pdf', description: 'PDF files' });
  panel = h.current();
  assert.deepEqual(
    panel.items.map((item) => item.value),
    ['use', 'disable']
  );
  h.select(h.row('use'));
  assert.equal(h.current(), null);
  assert.equal(h.prompts.at(-1).kind, 'skill-use');
  assert.equal(h.prompts.at(-1).skillName, 'pdf');
});

test('Project skills: Enter on a row opens its detail, Esc returns to Skills', async () => {
  const h = createHarness({
    store: { skillsStatus: async () => ({ skills: [{ name: 'deploy', source: 'project', filePath: 'x/SKILL.md' }] }) },
  });
  await h.openProjectSkillsPicker();
  await flush();
  assert.equal(h.current().title, 'Project skills');
  assert.equal(h.row('deploy').description, 'project · x/SKILL.md');
  h.select(h.row('deploy'));
  assert.equal(h.current().title, 'Skill · deploy');
  h.current().onCancel();
  await flush();
  assert.equal(h.current()._kind, 'skills');
});

test('Plugins: menu → installed list → detail actions (info, copy, update, MCP enable)', async () => {
  const plugin = {
    id: 'demo',
    name: 'demo',
    title: 'Demo',
    version: '1.2.0',
    sourceType: 'git',
    source: 'git',
    sourceUrl: 'https://example.test/demo',
    skillCount: 2,
    root: 'C:/plugins/demo',
    mcpScript: 'mcp/server.mjs',
    mcpServerName: 'demo-mcp',
    description: 'A demo plugin',
  };
  const updated = [];
  const mcpEnabled = [];
  const h = createHarness({
    store: {
      pluginsStatus: async () => ({ count: 1, plugins: [plugin] }),
      updatePlugin: async (p) => {
        updated.push(p.name);
      },
      enablePluginMcp: async (p) => {
        mcpEnabled.push(p.name);
      },
      mcpStatus: async () => ({ servers: [] }),
    },
  });
  await h.openPluginsPicker();
  await flush();
  assert.equal(h.current().title, 'Plugins');
  assert.equal(h.row('installed').description, '1 installed');

  h.select(h.row('add'));
  assert.equal(h.prompts.at(-1).kind, 'plugin-add');

  await h.openInstalledPluginsPicker();
  await flush();
  assert.equal(h.current().title, 'Installed plugins');
  assert.equal(h.row('demo:1.2.0').description, 'git · 1.2.0 · skills 2 · mcp mcp/server.mjs');
  h.select(h.row('demo:1.2.0'));
  const detail = h.current();
  assert.equal(detail.title, 'Demo');
  assert.deepEqual(
    detail.items.map((item) => [item.value, item._action]),
    [
      ['info', 'info'],
      ['update', 'update'],
      ['enable-mcp', 'enable-mcp'],
      ['copy-root', 'copy-root'],
      ['copy-mcp-name', 'copy-mcp-name'],
      ['uninstall', 'uninstall'],
    ]
  );
  assert.equal(h.row('enable-mcp').label, 'Enable MCP server');

  h.select(h.row('info'));
  assert.match(
    h.notices.at(-1)[0],
    /^Demo 1\.2\.0\nsource: git \/ https:\/\/example\.test\/demo\nskills: 2\nmcp: available \(demo-mcp\)/
  );
  assert.match(h.notices.at(-1)[0], /applies to: all projects\nroot: C:\/plugins\/demo\n\nA demo plugin$/);

  h.openPluginDetailPicker(plugin);
  h.select(h.row('copy-root'));
  await flush();
  assert.deepEqual(h.clipboard, ['C:/plugins/demo']);
  assert.deepEqual(h.notices.at(-1), ['copied plugin root: demo', 'plain']);

  h.openPluginDetailPicker(plugin);
  h.select(h.row('update'));
  await flush();
  assert.deepEqual(updated, ['demo']);
  assert.equal(h.current().title, 'Installed plugins');

  h.openPluginDetailPicker(plugin);
  h.select(h.row('enable-mcp'));
  await flush();
  assert.deepEqual(mcpEnabled, ['demo']);
  assert.equal(h.current()._kind, 'mcp-servers');
});

test('a plugin without an MCP script shows the no-op MCP rows', async () => {
  const h = createHarness({ store: { pluginsStatus: async () => ({ count: 0, plugins: [] }) } });
  h.openPluginDetailPicker({ name: 'bare', sourceType: 'local', source: 'local', root: '/p' });
  assert.equal(h.row('enable-mcp').label, 'No MCP script');
  assert.equal(h.row('enable-mcp')._action, 'noop');
  assert.equal(h.row('copy-mcp-name')._action, 'noop');
  assert.equal(h.row('update').label, 'Refresh metadata');
  h.current().onCancel();
  await flush();
  assert.equal(h.current().title, 'Installed plugins');
  assert.equal(h.row('empty').label, 'No installed plugins');
});
