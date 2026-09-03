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
    assert.equal(document.querySelectorAll('[data-feature-id]').length, 6);
    assert.deepEqual(
      [...document.querySelectorAll('.settings-group > header h3')].map((heading) => heading.textContent),
      ['Built-in', 'Plugins'],
    );
    assert.doesNotMatch(document.body.textContent, /Agent tools|Input features/);
    assert.match(document.body.textContent, /Example plugin/);
    assert.equal(document.querySelector('[data-feature-id="memory"] .built-in-feature-state'), null);
    assert.equal(document.querySelector('[data-extension-row="Example plugin"] .sidebar-resource-state'), null);
    await act(async () => {
      document.querySelector('[data-extension-row="Example plugin"] input').click();
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
    assert.equal(document.querySelector('[data-feature-id="browser"] input'), null);
    assert.equal(document.querySelector('[data-feature-id="computer"] input'), null);
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
    assert.equal(document.querySelector('[data-feature-id="computer"] input').checked, true);
  } finally {
    await first.cleanup();
  }

  const second = await renderPanel('plugins', { api });
  try {
    assert.equal(document.querySelector('[data-feature-id="browser"] input').checked, true);
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
      document.querySelector('[data-extension-row="Open plugin"] .extensions-row-open').click();
    });
    const scopeField = document.querySelector('[data-extension-scope="plugins"]');
    assert.ok(scopeField);
    assert.equal(scopeField.querySelector('button[aria-pressed="true"]').textContent, 'All projects');
    assert.match(document.body.textContent, /Contents/);
    assert.match(document.body.textContent, /Info/);

    // Choosing "Selected projects" starts from the current project.
    await act(async () => {
      [...scopeField.querySelectorAll('.extensions-scope-mode button')][1].click();
    });
    assert.deepEqual(calls.at(-1), ['setExtensionScope', ['plugins', 'open-plugin', ['C:\\work\\alpha']]]);
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
    await act(async () => {
      document.querySelector('[data-extension-row="example-skill"] input').click();
      document.querySelector('[data-extension-row="example-mcp"] input').click();
    });
    assert.deepEqual(calls.slice(-2).map(([capability, args]) => [capability, args]), [
      ['setDisabledSkills', [['example-skill']]],
      ['setMcpServerEnabled', ['example-mcp', false]],
    ]);
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
