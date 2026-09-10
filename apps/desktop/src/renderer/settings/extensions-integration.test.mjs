import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://mixdog.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
window.mixdogDesktop = {
  setTitleBarDimmed() {},
  rendererDiagnostic() {},
};

const { extensionSectionForSettings } = await import('../extension-sections.ts');
const { WorkflowsPane } = await import('../WorkflowsView.tsx');
const {
  adoptSidebarReferenceHost,
  resetSidebarReferenceCache,
  updateSidebarReference,
} = await import('../sidebar-reference-cache.ts');
const { CategoryPanel } = await import('./capability-panels.tsx');

function panelContext(overrides = {}) {
  return {
    api: {
      readSettings: async () => ({
        browserControl: false,
        computerControl: false,
      }),
      gitCliStatus: async () => ({ installed: true }),
    },
    data: {
      toolModules: {
        git: { enabled: true, installed: true },
        memory: { enabled: true, installed: true },
        office: { enabled: true, installed: true },
      },
      voice: { enabled: false, installed: false },
      plugins: {
        plugins: [{
          id: 'example-plugin',
          name: 'Example plugin',
          enabled: true,
          description: 'Installed package',
        }],
      },
      skills: {
        skills: [{
          name: 'example-skill',
          description: 'Reusable instructions',
        }],
      },
      disabledSkills: { disabled: [] },
      mcp: {
        servers: [{
          name: 'example-mcp',
          enabled: true,
          config: { type: 'stdio', command: 'example' },
        }],
      },
    },
    snapshot: null,
    pending: '',
    async run() {},
    async route() {},
    async setFast() {},
    confirm() {},
    notice() {},
    updaterState: { status: 'disabled' },
    async checkDesktopUpdate() {},
    async installDesktopUpdate() {},
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

async function renderPanel(category, overrides = {}) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(CategoryPanel, {
      category,
      context: panelContext(overrides),
    }));
  });
  return {
    host,
    root,
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('extension settings routes collapse into Plugin and Skill', () => {
  assert.equal(extensionSectionForSettings('plugins'), 'plugins');
  assert.equal(extensionSectionForSettings('voice'), 'plugins');
  assert.equal(extensionSectionForSettings('memory'), 'plugins');
  assert.equal(extensionSectionForSettings('skills'), 'skills');
  assert.equal(extensionSectionForSettings('mcp'), 'skills');
  assert.equal(extensionSectionForSettings('general'), null);
  assert.equal(extensionSectionForSettings(null), null);
});

test('Plugin combines built-in features and installed plugins', async () => {
  const calls = [];
  const rendered = await renderPanel('plugins', {
    async run(capability, args) {
      calls.push([capability, args]);
    },
  });
  try {
    assert.ok(document.querySelectorAll('[data-built-in-feature]').length > 0);
    // Built-in rows share the extension row grammar and carry no switch.
    assert.equal(document.querySelector('[data-built-in-feature] input'), null);
    assert.deepEqual(
      [...document.querySelectorAll('.settings-group > header h3')].map((heading) => heading.textContent),
      ['Built-in', 'Plugins'],
    );
    assert.doesNotMatch(document.body.textContent, /Agent tools|Input features/);
    assert.match(document.body.textContent, /Example plugin/);
    assert.equal(document.querySelector('[data-feature-id="memory"] .built-in-feature-state'), null);
    assert.equal(document.querySelector('[data-extension-row="Example plugin"] .sidebar-resource-state'), null);
    // List rows carry no switch; the row is icon + title + one-line description.
    assert.equal(document.querySelector('[data-extension-row="Example plugin"] input'), null);
    assert.ok(document.querySelector('[data-extension-row="Example plugin"] .extensions-row-icon'));
    await act(async () => {
      document.querySelector('[data-built-in-feature="memory"]').click();
    });
    const memoryDialog = document.querySelector('[data-feature-id="memory"]');
    assert.ok(memoryDialog);
    assert.equal((memoryDialog.textContent.match(/Memory/g) || []).length, 1);
    assert.equal(memoryDialog.querySelector('footer'), null);
    await act(async () => {
      memoryDialog.querySelector('header button[aria-label="Close"]').click();
      document.querySelector('[data-extension-row="Example plugin"]').click();
    });
    await act(async () => {
      document.querySelector('.extensions-dialog header input').click();
    });
    assert.equal(calls.at(-1)[0], 'setPluginEnabled');
    assert.equal(calls.at(-1)[1][1], false);
  } finally {
    await rendered.cleanup();
  }
});

test('built-in details show their engines and supplied model metadata instead of duplicate activation facts', async () => {
  const context = panelContext();
  context.api.gitCliStatus = async () => ({ installed: true, version: 'git 2.50.1' });
  context.api.libreOfficeStatus = async () => ({ installed: true, version: '25.2.1' });
  context.data.voice.info = {
    engine: 'whisper.cpp', runtimeVersion: '1.9.2', acceleration: 'vulkan',
    model: 'ggml-large-v3-turbo-q8_0.bin', modelBytes: 874188075, ffmpegVersion: '6.1.1',
  };
  context.data.toolModules.memory.info = {
    model: 'custom/embedding', dtype: 'q4', dimensions: 1024,
    device: 'cuda', engine: 'Transformers.js · ONNX Runtime',
  };
  context.data.toolModules.localProvider = {
    runtime: { installed: true, version: 'b-test', backend: 'CUDA 12.4' },
    activeModel: 'custom', running: true,
    models: [{ id: 'custom', name: 'Custom Q4_K_M', contextWindow: 8192 }],
  };
  const expected = {
    git: ['git 2.50.1'],
    office: ['25.2.1', 'Word', 'PDF'],
    voice: ['whisper.cpp · 1.9.2', 'ggml-large-v3-turbo-q8_0.bin', '0.9 GB', 'vulkan', '6.1.1'],
    memory: ['custom/embedding', 'q4', '1024', 'cuda', 'ONNX Runtime'],
    localProvider: ['llama.cpp', 'b-test', 'CUDA 12.4', 'Custom Q4_K_M', '8192'],
    browser: ['Chromium', 'Chrome DevTools Protocol', 'cookies'],
    computer: ['Windows UI Automation', 'Win32'],
  };
  const rendered = await renderPanel('plugins', context);
  try {
    const ids = [...document.querySelectorAll('[data-built-in-feature]')]
      .map((row) => row.getAttribute('data-built-in-feature'));
    for (const id of ids) {
      await act(async () => document.querySelector(`[data-built-in-feature="${id}"]`).click());
      const dialog = document.querySelector(`[data-feature-id="${id}"]`);
      const labels = [...dialog.querySelectorAll('dt')].map((node) => node.textContent);
      assert.ok(!labels.includes('Installation'), id);
      assert.ok(!labels.includes('Status'), id);
      const facts = dialog.querySelector('.extensions-dialog-facts').textContent;
      for (const value of expected[id]) assert.ok(facts.includes(value), `${id}: ${value}`);
      await act(async () => dialog.querySelector('header button[aria-label="Close"]').click());
    }
  } finally {
    await rendered.cleanup();
  }
});

test('bundled skills have inert required-tool buttons and inherit parent activation', async () => {
  const context = panelContext();
  context.data.skills.skills = [{
    name: 'office-guide',
    description: 'Document instructions',
    owner: { kind: 'builtin', feature: 'office' },
  }];
  context.data.disabledSkills.disabled = ['office-guide'];
  const calls = [];
  const rendered = await renderPanel('plugins', {
    ...context,
    async run(...args) { calls.push(args); },
  });
  try {
    await act(async () => document.querySelector('[data-built-in-feature="office"]').click());
    let dialog = document.querySelector('[data-feature-id="office"]');
    assert.equal(dialog.querySelectorAll('input[type="checkbox"]').length, 1);
    const button = [...dialog.querySelectorAll('button')].find((node) => node.textContent === 'Required tools');
    assert.equal(button.disabled, true);
    await act(async () => button.click());
    assert.deepEqual(calls, []);
    assert.equal(dialog.querySelector('input[type="checkbox"]').checked, true);
    // Persisted parent changes, including removal, update the child without a
    // separate setDisabledSkills mutation.
    for (const entry of [{ installed: true, enabled: false }, { installed: false, enabled: true }]) {
      context.data = { ...context.data, toolModules: { ...context.data.toolModules, office: entry } };
      await act(async () => rendered.root.render(React.createElement(CategoryPanel, {
        category: 'plugins', context,
      })));
      dialog = document.querySelector('[data-feature-id="office"]');
      if (entry.installed) assert.equal(dialog.querySelector('input[type="checkbox"]').checked, false);
      assert.equal(dialog.querySelectorAll('input').length, entry.installed ? 1 : 0);
    }
  } finally {
    await rendered.cleanup();
  }
});

test('plugin detail shows all supplied metadata and existing installation facts as text', async () => {
  const installedAt = '2026-01-02T12:00:00Z';
  const updatedAt = '2026-02-03T12:00:00Z';
  const rendered = await renderPanel('plugins', {
    data: {
      ...panelContext().data,
      plugins: { plugins: [{
        id: 'info-plugin',
        name: 'Info plugin',
        version: '1.2.3',
        author: '<script>Author</script> <author@example.test>',
        homepage: 'https://example.test',
        repository: 'https://example.test/plugin.git',
        license: 'MIT',
        keywords: ['tools', 'mcp'],
        sourceType: 'git',
        sourceUrl: 'https://example.test/source.git',
        root: 'C:\\plugins\\info',
        mcpServerName: 'plugin-info',
        installedAt,
        updatedAt,
      }] },
    },
  });
  try {
    await act(async () => {
      document.querySelector('[data-extension-row="Info plugin"]').click();
    });
    const facts = document.querySelector('.extensions-dialog dl');
    assert.deepEqual(Object.fromEntries([...facts.children].map((row) => [
      row.querySelector('dt').textContent, row.querySelector('dd').textContent,
    ])), {
      Version: '1.2.3',
      Author: '<script>Author</script> <author@example.test>',
      Homepage: 'https://example.test',
      Repository: 'https://example.test/plugin.git',
      License: 'MIT',
      Keywords: 'tools, mcp',
      Source: 'git · https://example.test/source.git',
      Root: 'C:\\plugins\\info',
      'MCP server': 'plugin-info',
      Installed: new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(installedAt)),
      Updated: new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(updatedAt)),
    });
    assert.equal(facts.querySelector('script'), null);
  } finally {
    await rendered.cleanup();
  }
});

test('plugin detail keeps every unavailable fact visible with a placeholder', async () => {
  const rendered = await renderPanel('plugins', {
    data: {
      ...panelContext().data,
      plugins: { plugins: [{
        id: 'empty-plugin',
        name: 'Empty plugin',
        version: '  ',
        author: {},
        keywords: [' ', null],
        installedAt: 'invalid-date',
        updatedAt: Number.POSITIVE_INFINITY,
      }] },
    },
  });
  try {
    await act(async () => {
      document.querySelector('[data-extension-row="Empty plugin"]').click();
    });
    const facts = [...document.querySelectorAll('.extensions-dialog dl > div')];
    assert.equal(facts.length, 11);
    assert.ok(facts.every((row) => row.querySelector('dd').textContent === 'Not provided'));
  } finally {
    await rendered.cleanup();
  }
});

test('empty Plugin, Skill, and MCP categories keep their own visible empty states', async () => {
  const skills = await renderPanel('skills', {
    data: {
      skills: { skills: [] },
      disabledSkills: { disabled: [] },
      mcp: { servers: [] },
      __loadedSections: ['skills', 'mcp'],
    },
  });
  try {
    assert.match(document.body.textContent, /No skills found\./);
    assert.match(document.body.textContent, /No MCP servers configured\./);
  } finally {
    await skills.cleanup();
  }

  const plugins = await renderPanel('plugins', {
    data: {
      toolModules: {
        git: { enabled: true, installed: true },
        memory: { enabled: true, installed: true },
        office: { enabled: true, installed: true },
      },
      voice: { enabled: false, installed: false },
      plugins: { plugins: [] },
      __loadedSections: ['plugins'],
    },
  });
  try {
    assert.match(document.body.textContent, /No plugins installed\./);
  } finally {
    await plugins.cleanup();
  }
});

test('Browser Use and Computer Use mount at their real state without replaying an on animation', async () => {
  const settings = deferred();
  const api = {
    readSettings: async () => settings.promise,
    gitCliStatus: async () => ({ installed: true }),
  };
  const first = await renderPanel('plugins', { api });
  try {
    await act(async () => {
      document.querySelector('[data-built-in-feature="browser"]').click();
    });
    assert.equal(document.querySelector('[data-feature-id="browser"] input'), null);
    await act(async () => {
      // Mirrors the settings store: an already-on control arrives with its
      // grandfathered install marker.
      settings.resolve({
        browserControl: true,
        computerControl: true,
        browserInstalled: true,
        computerInstalled: true,
      });
      await settings.promise;
    });
    assert.equal(document.querySelector('[data-feature-id="browser"] input').checked, true);
  } finally {
    await first.cleanup();
  }

  const second = await renderPanel('plugins', { api });
  try {
    await act(async () => {
      document.querySelector('[data-built-in-feature="computer"]').click();
    });
    assert.equal(document.querySelector('[data-feature-id="computer"] input').checked, true);
  } finally {
    await second.cleanup();
  }
});

test('project scope stays in the plugin detail and saves from its scope selector', async () => {
  const calls = [];
  const rendered = await renderPanel('plugins', {
    api: {
      readSettings: async () => ({ browserControl: false, computerControl: false }),
      gitCliStatus: async () => ({ installed: true }),
      invokeCapability: async () => ({}),
      listProjects: async () => [
        { name: 'alpha', path: 'C:\\work\\alpha', alias: null },
        { name: 'beta', path: 'C:\\work\\beta', alias: 'Beta' },
      ],
    },
    data: {
      toolModules: {
        git: { enabled: true, installed: true },
        memory: { enabled: true, installed: true },
        office: { enabled: true, installed: true },
      },
      voice: { enabled: false, installed: false },
      plugins: {
        plugins: [
          { id: 'scoped-plugin', name: 'Scoped plugin', enabled: true, scope: ['C:\\work\\beta'], activeHere: false },
          { id: 'open-plugin', name: 'Open plugin', enabled: true, scope: null, activeHere: true },
        ],
      },
      skills: { cwd: 'C:\\work\\alpha', skills: [] },
      mcp: { servers: [] },
      disabledSkills: { disabled: [] },
    },
    async run(capability, args) {
      calls.push([capability, args]);
    },
  });
  try {
    assert.equal(
      document.querySelector('[data-extension-row="Scoped plugin"] .extensions-row-badge'),
      null,
    );
    assert.equal(document.querySelector('[data-extension-row="Open plugin"] .extensions-row-badge'), null);

    await act(async () => {
      document.querySelector('[data-extension-row="Open plugin"]').click();
    });
    const scopeField = document.querySelector('[data-extension-scope="plugins"]');
    assert.ok(scopeField);
    // One dropdown: Shared, or a single project.
    assert.equal(scopeField.querySelector('.mx-select-value').textContent, 'Shared (all projects)');
    assert.match(document.body.textContent, /Contents/);
    assert.match(document.body.textContent, /Info/);

    await act(async () => {
      scopeField.querySelector('.mx-select-trigger').click();
    });
    const options = [...document.querySelectorAll('.mx-menu [role="option"]')].map((option) => option.textContent);
    assert.deepEqual(options, ['Shared (all projects)', 'alpha · Current project', 'Beta']);
    await act(async () => {
      document.querySelectorAll('.mx-menu [role="option"]')[2].click();
    });
    assert.deepEqual(calls.at(-1), ['setExtensionScope', ['plugins', 'open-plugin', ['C:\\work\\beta']]]);
  } finally {
    await rendered.cleanup();
  }
});

test('plugin detail toggles each bundled skill and MCP server on its own', async () => {
  const calls = [];
  const rendered = await renderPanel('plugins', {
    data: {
      toolModules: {
        git: { enabled: true, installed: true },
        memory: { enabled: true, installed: true },
        office: { enabled: true, installed: true },
      },
      voice: { enabled: false, installed: false },
      plugins: {
        plugins: [{ id: 'bundle', name: 'Bundle', enabled: true, mcpServerName: 'plugin-bundle', mcpScript: 'mcp.mjs', mcpEnabled: true }],
      },
      skills: {
        skills: [
          { name: 'bundled-skill', description: 'Ships with Bundle', owner: { kind: 'plugin', id: 'bundle' } },
          { name: 'loose-skill', description: 'User skill' },
        ],
      },
      disabledSkills: { disabled: ['loose-skill'] },
      mcp: { servers: [{ name: 'plugin-bundle', enabled: true, source: 'plugin', config: { type: 'stdio', command: 'x' } }] },
    },
    async run(capability, args) {
      calls.push([capability, args]);
    },
  });
  try {
    await act(async () => {
      document.querySelector('[data-extension-row="Bundle"]').click();
    });
    await act(async () => {
      document.querySelector('[data-extension-item="bundled-skill"] input').click();
    });
    assert.deepEqual(calls.at(-1), ['setDisabledSkills', [['loose-skill', 'bundled-skill']]]);
    await act(async () => {
      document.querySelector('[data-extension-item="plugin-bundle"] input').click();
    });
    assert.deepEqual(calls.at(-1), ['setMcpServerEnabled', ['plugin-bundle', false]]);
  } finally {
    await rendered.cleanup();
  }
});

test('Skill combines skills and MCP and lets the add action choose either kind', async () => {
  let closed = 0;
  const calls = [];
  const rendered = await renderPanel('skills', {
    createOpen: true,
    closeCreate() { closed += 1; },
    async run(capability, args) {
      calls.push([capability, args]);
      if (capability === 'skillContent') return { content: '# Example' };
    },
  });
  try {
    assert.deepEqual(
      [...document.querySelectorAll('.settings-group > header h3')].map((heading) => heading.textContent),
      ['Skills', 'MCP'],
    );
    assert.match(document.body.textContent, /example-skill/);
    assert.match(document.body.textContent, /example-mcp/);
    assert.ok(document.querySelector('[data-extension-create-kind="skill"]'));
    assert.ok(document.querySelector('[data-extension-create-kind="mcp"]'));
    // Rows carry no switch; enabling happens inside each detail dialog.
    assert.equal(document.querySelector('[data-extension-row="example-skill"] input'), null);
    assert.equal(document.querySelector('[data-extension-row="example-mcp"] input'), null);
    assert.equal(document.querySelector('#extensions-skill-dialog-title'), null);

    await act(async () => {
      document.querySelector('[data-extension-create-kind="skill"]').click();
    });
    assert.equal(document.querySelector('#extensions-skill-dialog-title').textContent, 'Add skill');
    assert.equal(closed, 0);
  } finally {
    await rendered.cleanup();
  }
});

test('Skill and MCP rows acknowledge the card click before their detail payload resolves', async () => {
  const skillContent = deferred();
  const mcpConfig = deferred();
  const rendered = await renderPanel('skills', {
    async run(capability) {
      if (capability === 'skillContent') return skillContent.promise;
      if (capability === 'getMcpServerConfig') return mcpConfig.promise;
    },
  });
  try {
    await act(async () => {
      document.querySelector('[data-extension-row="example-skill"]').click();
    });
    assert.match(document.querySelector('[data-extension-loading="skill"]').textContent, /Loading/);

    await act(async () => {
      skillContent.resolve({ content: '# Example' });
      await skillContent.promise;
    });
    assert.ok(document.querySelector('#extensions-skill-dialog-title'));
    await act(async () => {
      document.querySelector('.extensions-skill-dialog header button[aria-label="Close"]').click();
      document.querySelector('[data-extension-row="example-mcp"]').click();
    });
    assert.match(document.querySelector('[data-extension-loading="mcp"]').textContent, /Loading/);

    await act(async () => {
      mcpConfig.resolve({ name: 'example-mcp', config: { type: 'stdio', command: 'example' } });
      await mcpConfig.promise;
    });
    assert.ok(document.querySelector('#extensions-mcp-dialog-title'));
  } finally {
    skillContent.resolve({ content: '# Example' });
    mcpConfig.resolve({ name: 'example-mcp', config: { type: 'stdio', command: 'example' } });
    await rendered.cleanup();
  }
});

test('Workflow card surface opens an immediate loading popup before editor data resolves', async () => {
  const workflowPack = deferred();
  const api = {
    async invokeCapability({ capability }) {
      if (capability === 'getWorkflowPack') return workflowPack.promise;
      return { value: undefined };
    },
    async listProviderModels() { return []; },
  };
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('workflows', [{
    id: 'alpha',
    name: 'Alpha',
    description: 'Example workflow',
    source: 'user',
  }]);
  updateSidebarReference('agents', []);
  updateSidebarReference('webSearchRoute', {});
  updateSidebarReference('webSearchModels', []);
  updateSidebarReference('providerSetup', {});
  updateSidebarReference('quickProviderModels', []);

  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(React.createElement(WorkflowsPane, { api, active: true }));
    });
    const row = host.querySelector('.workflows-packs .schedules-row');
    assert.ok(row);
    await act(async () => {
      row.click();
    });
    assert.match(document.querySelector('[data-sidebar-loading="workflow"]').textContent, /Loading/);

    await act(async () => {
      workflowPack.resolve({ value: { id: 'alpha', name: 'Alpha', body: '# Alpha' } });
      await workflowPack.promise;
    });
    assert.ok(document.querySelector('#workflows-dialog-title'));
  } finally {
    workflowPack.resolve({ value: { id: 'alpha', name: 'Alpha', body: '# Alpha' } });
    await act(async () => root.unmount());
    host.remove();
    resetSidebarReferenceCache();
  }
});
