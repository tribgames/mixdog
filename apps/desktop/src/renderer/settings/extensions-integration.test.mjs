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
    assert.equal(document.querySelectorAll('[data-built-in-feature]').length, 6);
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

test('project scope shows as a row badge and saves from the plugin detail', async () => {
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
      document.querySelector('[data-extension-row="Scoped plugin"] .extensions-row-badge').textContent,
      'Not in this project',
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
