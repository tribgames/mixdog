import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom, toolModulesSource } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['HTMLElement', 'Event'],
  actEnvironment: false,
});
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
const modules = toolModulesSource();
window.mixdogDesktop = {
  setTitleBarDimmed() {},
  rendererDiagnostic() {},
  sections: modules.sections,
};

const { extensionSectionForSettings } = await import('../extension-sections.ts');
const { WorkflowsPane } = await import('../WorkflowsView.tsx');
const { adoptSidebarReferenceHost, resetSidebarReferenceCache, updateSidebarReference } = await import(
  '../sidebar-reference-cache.ts'
);
const { CategoryPanel } = await import('./capability-panels.tsx');

/** A `skillsStatus` row: one source's skill, with the source key the switch writes. */
function skillRow(name, sourceKey, extra = {}) {
  const owner =
    sourceKey === 'global'
      ? { kind: 'user' }
      : sourceKey === 'builtin'
        ? { kind: 'builtin' }
        : { kind: 'plugin', id: sourceKey.slice('plugin:'.length) };
  return {
    name,
    key: `${sourceKey}:${name}`,
    sourceKey,
    state: 'inUse',
    hiddenBy: null,
    offBy: null,
    replacesBuiltin: false,
    switchable: true,
    enabled: true,
    editable: sourceKey === 'global',
    owner,
    ...extra,
  };
}

function panelContext(overrides = {}) {
  const context = {
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
        tidy: { enabled: true, installed: true },
      },
      voice: { enabled: false, installed: false },
      plugins: {
        plugins: [
          {
            id: 'example-plugin',
            name: 'Example plugin',
            enabled: true,
            description: 'Installed package',
          },
        ],
      },
      skills: {
        skills: [skillRow('example-skill', 'global', { description: 'Reusable instructions' })],
      },
      disabledSkills: { disabled: [] },
      mcp: {
        servers: [
          {
            name: 'example-mcp',
            enabled: true,
            config: { type: 'stdio', command: 'example' },
          },
        ],
      },
    },
    snapshot: null,
    pending: '',
    async run() {},
    async refreshExtensions() {},
    async route() {},
    async setFast() {},
    confirm() {},
    notice() {},
    updaterState: { status: 'disabled' },
    async checkDesktopUpdate() {},
    async installDesktopUpdate() {},
    ...overrides,
  };
  // The built-in cards read the core's `toolModules` section: what a test says the core holds is pushed with it.
  if (context.data.toolModules) modules.publish(context.data.toolModules);
  return context;
}

function writablePanelContext(overrides) {
  const context = panelContext(overrides);
  const api = {
    ...context.api,
    async invokeCapability({ capability, args }) {
      if (capability === 'getTidyEngineStatus' && !context.api.readCapabilities) return { value: null };
      assert.ok(overrides.run, `Unexpected command: ${capability}`);
      return { value: await overrides.run(capability, args) };
    },
  };
  return {
    ...context,
    api,
    async run(capability, args) {
      return (await api.invokeCapability({ capability, args })).value;
    },
  };
}

async function renderPanel(category, overrides = {}) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(CategoryPanel, {
        category,
        context: panelContext(overrides),
      })
    );
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

test('About offers GitHub, GitHub Sponsors, and issue links', async (t) => {
  const previousApi = window.mixdogDesktop;
  const opened = [];
  window.mixdogDesktop = {
    ...previousApi,
    async openExternal(url) {
      opened.push(url);
    },
  };
  t.after(() => {
    window.mixdogDesktop = previousApi;
  });
  const panel = await renderPanel('about');
  t.after(() => panel.cleanup());

  assert.doesNotMatch(panel.host.textContent, /Ko-fi|Support mixdog development/i);
  const rows = [...panel.host.querySelectorAll('.settings-about-row')];
  const rowButtons = (row) => [...row.querySelectorAll('button')].map((button) => button.textContent.trim());
  assert.deepEqual(
    rows.slice(0, 2).map((row) => row.querySelector('.settings-resource-title b').textContent),
    ['GitHub', 'Sponsor']
  );
  assert.deepEqual(rowButtons(rows[0]), ['Star on GitHub ↗', 'Open ↗']);
  assert.deepEqual(rowButtons(rows[1]), ['Sponsor ↗']);
  const buttons = [...panel.host.querySelectorAll('button')];
  assert.deepEqual(
    buttons.map((button) => button.textContent.trim()),
    ['Star on GitHub ↗', 'Open ↗', 'Sponsor ↗', 'Issues ↗', 'Give feedback', 'View changelog']
  );
  assert.doesNotMatch(panel.host.textContent, /Contact support|Email ↗|Copy/);
  for (const button of buttons.slice(0, 4)) {
    await act(async () => button.click());
  }
  assert.deepEqual(opened, [
    'https://github.com/tribgames/mixdog',
    'https://github.com/tribgames/mixdog',
    'https://github.com/sponsors/JYP8877',
    'https://github.com/tribgames/mixdog/issues',
  ]);
  await act(async () => buttons[4].click());
  assert.ok(document.querySelector('[role="dialog"][data-settings-nested-dialog]'));
  assert.equal(opened.length, 4);
});

test('extension settings routes collapse into Plugin and Skill', () => {
  assert.equal(extensionSectionForSettings('plugins'), 'plugins');
  assert.equal(extensionSectionForSettings('voice'), 'plugins');
  assert.equal(extensionSectionForSettings('memory'), 'plugins');
  // Skills have their own rail destination; only MCP stays in Extensions.
  assert.equal(extensionSectionForSettings('skills'), null);
  assert.equal(extensionSectionForSettings('mcp'), 'connectors');
  assert.equal(extensionSectionForSettings('general'), null);
  assert.equal(extensionSectionForSettings(null), null);
});

test('Plugin combines built-in features and installed plugins', async () => {
  const calls = [];
  const rendered = await renderPanel(
    'plugins',
    writablePanelContext({
      async run(capability, args) {
        calls.push([capability, args]);
      },
    })
  );
  try {
    assert.ok(document.querySelectorAll('[data-built-in-feature]').length > 0);
    // Built-in rows share the extension row grammar and carry no switch.
    assert.equal(document.querySelector('[data-built-in-feature] input'), null);
    assert.deepEqual(
      [...document.querySelectorAll('.settings-group > header h3')].map((heading) => heading.textContent),
      ['Built-in', 'Plugins']
    );
    assert.doesNotMatch(document.body.textContent, /Agent tools|Input features/);
    assert.match(document.body.textContent, /Example plugin/);
    assert.equal(document.querySelector('[data-feature-id="memory"] .built-in-feature-state'), null);
    assert.equal(document.querySelector('[data-extension-row="Example plugin"] .sidebar-resource-tag'), null);
    const voiceTag = document.querySelector('[data-built-in-feature="voice"] .sidebar-resource-tag');
    assert.ok(voiceTag);
    assert.equal(voiceTag.textContent, 'Not installed');
    assert.equal(voiceTag.getAttribute('data-tone'), 'muted');
    // List rows carry no switch; the row is icon + title + one-line description.
    assert.equal(document.querySelector('[data-extension-row="Example plugin"] input'), null);
    assert.ok(document.querySelector('[data-extension-row="Example plugin"] .extensions-row-icon'));
    await act(async () => {
      document.querySelector('[data-built-in-feature="memory"]').click();
    });
    const memoryDialog = document.querySelector('[data-feature-id="memory"]');
    assert.ok(memoryDialog);
    assert.deepEqual(
      [...memoryDialog.querySelectorAll('header h2')].map((heading) => heading.textContent),
      ['Memory']
    );
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
    engine: 'whisper.cpp',
    runtimeVersion: '1.9.2',
    acceleration: 'vulkan',
    model: 'ggml-large-v3-turbo-q8_0.bin',
    modelBytes: 874188075,
    ffmpegVersion: '6.1.1',
  };
  context.data.toolModules.memory.info = {
    model: 'custom/embedding',
    dtype: 'q4',
    dimensions: 1024,
    device: 'cuda',
    engine: 'Transformers.js · ONNX Runtime',
  };
  context.data.toolModules.localProvider = {
    runtime: { installed: true, version: 'b-test', backend: 'CUDA 12.4' },
    activeModel: 'custom',
    running: true,
    models: [{ id: 'custom', name: 'Custom Q4_K_M', contextWindow: 8192 }],
  };
  const expected = {
    git: ['git 2.50.1'],
    office: ['25.2.1', 'Word', 'PDF'],
    voice: ['whisper.cpp · 1.9.2', 'ggml-large-v3-turbo-q8_0.bin', '0.9 GB', 'vulkan', '6.1.1'],
    memory: ['custom/embedding', 'q4', '1024', 'cuda', 'ONNX Runtime'],
    localProvider: ['llama.cpp', 'b-test', 'CUDA 12.4', 'Custom Q4_K_M', '8192'],
    browser: ['Chromium', 'Chrome DevTools Protocol', 'cookies'],
    computer: ['macOS Accessibility', 'macOS'],
  };
  // Computer Use names the backend of the desktop it runs on.
  const originalUserAgent = navigator.userAgent;
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  });
  const rendered = await renderPanel('plugins', context);
  try {
    const ids = [...document.querySelectorAll('[data-built-in-feature]')].map((row) =>
      row.getAttribute('data-built-in-feature')
    );
    for (const id of ids) {
      await act(async () => document.querySelector(`[data-built-in-feature="${id}"]`).click());
      const dialog = document.querySelector(`[data-feature-id="${id}"]`);
      const labels = [...dialog.querySelectorAll('dt')].map((node) => node.textContent);
      assert.ok(!labels.includes('Installation'), id);
      assert.ok(!labels.includes('Status'), id);
      const facts = dialog.querySelector('.extensions-dialog-facts')?.textContent;
      if (expected[id]) {
        for (const value of expected[id]) assert.ok(facts?.includes(value), `${id}: ${value}`);
      }
      await act(async () => dialog.querySelector('header button[aria-label="Close"]').click());
    }
  } finally {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    await rendered.cleanup();
  }
});

test('built-in skills are not shown in the built-in feature details', async () => {
  const context = panelContext();
  context.data.skills.skills = [
    {
      name: 'office-guide',
      description: 'Document instructions',
      owner: { kind: 'builtin', feature: 'office' },
    },
  ];
  const rendered = await renderPanel('plugins', context);
  try {
    await act(async () => document.querySelector('[data-built-in-feature="office"]').click());
    const dialog = document.querySelector('[data-feature-id="office"]');
    assert.ok(dialog);
    assert.doesNotMatch(dialog.textContent, /office-guide/);
    assert.equal(
      [...dialog.querySelectorAll('button')].some((node) => node.textContent === 'Required tools'),
      false
    );
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
      plugins: {
        plugins: [
          {
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
          },
        ],
      },
    },
  });
  try {
    await act(async () => {
      document.querySelector('[data-extension-row="Info plugin"]').click();
    });
    const facts = document.querySelector('.extensions-dialog dl');
    assert.deepEqual(
      Object.fromEntries(
        [...facts.children].map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])
      ),
      {
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
      }
    );
    assert.equal(facts.querySelector('script'), null);
  } finally {
    await rendered.cleanup();
  }
});

test('plugin detail keeps every unavailable fact visible with a placeholder', async () => {
  const rendered = await renderPanel('plugins', {
    data: {
      ...panelContext().data,
      plugins: {
        plugins: [
          {
            id: 'empty-plugin',
            name: 'Empty plugin',
            version: '  ',
            author: {},
            keywords: [' ', null],
            installedAt: 'invalid-date',
            updatedAt: Number.POSITIVE_INFINITY,
          },
        ],
      },
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

test('with no own skills the own category invites one, and built-in skills stay unlisted', async () => {
  let opened = 0;
  const skills = await renderPanel('user-skills', {
    openCreate() {
      opened += 1;
    },
    data: {
      skills: { skills: [skillRow('office-guide', 'builtin')] },
      disabledSkills: { disabled: [] },
      mcp: { servers: [] },
      __loadedSections: ['skills', 'mcp'],
    },
  });
  try {
    const categories = [...document.querySelectorAll('.skills-category')];
    assert.deepEqual(
      categories.map((category) => category.dataset.skillSource),
      ['global']
    );
    assert.equal(categories[0].querySelector('.sidebar-heading-toggle').textContent, 'My skills0');
    assert.doesNotMatch(document.body.textContent, /office-guide/);
    const invite = document.querySelector('.skills-invite');
    assert.match(invite.textContent, /Add skill/);
    await act(async () => invite.click());
    assert.equal(opened, 1);
  } finally {
    await skills.cleanup();
  }
});

test('an empty MCP category keeps its visible empty state', async () => {
  const mcp = await renderPanel('skills', {
    data: {
      skills: { skills: [] },
      disabledSkills: { disabled: [] },
      mcp: { servers: [] },
      __loadedSections: ['skills', 'mcp'],
    },
  });
  try {
    assert.match(document.body.textContent, /No MCP servers configured\./);
    assert.doesNotMatch(document.body.textContent, /No skills/);
  } finally {
    await mcp.cleanup();
  }
});

test('an empty Plugin category keeps its visible empty state', async () => {
  const plugins = await renderPanel('plugins', {
    data: {
      toolModules: {
        git: { enabled: true, installed: true },
        memory: { enabled: true, installed: true },
        office: { enabled: true, installed: true },
        tidy: { enabled: true, installed: true },
      },
      voice: { enabled: false, installed: false },
      plugins: { plugins: [] },
      __loadedSections: ['plugins'],
    },
  });
  try {
    assert.match(document.body.textContent, /No plugins\./);
  } finally {
    await plugins.cleanup();
  }
});

const installedDesktopFeatures = {
  browserControl: true,
  computerControl: true,
  browserInstalled: true,
  computerInstalled: true,
};

test('Browser Use and Computer Use mount at their real state without replaying an on animation', async () => {
  const settings = Promise.withResolvers();
  let saved = installedDesktopFeatures;
  const api = {
    readSettings: async () => {
      await settings.promise;
      return saved;
    },
    updateSetting: async (key, enabled) => {
      saved = { ...saved, [key]: enabled };
      return saved;
    },
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
      settings.resolve();
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

test('Browser Use and Computer Use are unavailable without a desktop settings writer', async () => {
  const rendered = await renderPanel('plugins', {
    api: { readSettings: async () => installedDesktopFeatures },
  });
  try {
    for (const id of ['browser', 'computer']) {
      await act(async () => document.querySelector(`[data-built-in-feature="${id}"]`).click());
      const dialog = document.querySelector(`[data-feature-id="${id}"]`);
      assert.match(dialog.textContent, /Desktop feature settings are unavailable on this host/);
      assert.equal(dialog.querySelector('input[type="checkbox"], button[aria-label^="Install "]'), null);
      await act(async () => dialog.querySelector('button[aria-label="Close"]').click());
    }
  } finally {
    await rendered.cleanup();
  }
});

test('project scope stays in the plugin detail and saves from its scope selector', async () => {
  const calls = [];
  modules.publishSection('projects', [
    { name: 'alpha', path: 'C:\\work\\alpha', alias: null },
    { name: 'beta', path: 'C:\\work\\beta', alias: 'Beta' },
  ]);
  const rendered = await renderPanel('plugins', {
    api: {
      readSettings: async () => ({ browserControl: false, computerControl: false }),
      gitCliStatus: async () => ({ installed: true }),
      invokeCapability: async () => ({}),
      // The projects are the core's `projects` section, published above.
      sections: modules.sections,
    },
    data: {
      toolModules: {
        git: { enabled: true, installed: true },
        memory: { enabled: true, installed: true },
        office: { enabled: true, installed: true },
        tidy: { enabled: true, installed: true },
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
    assert.equal(document.querySelector('[data-extension-row="Scoped plugin"] .sidebar-resource-tag'), null);
    assert.equal(document.querySelector('[data-extension-row="Open plugin"] .sidebar-resource-tag'), null);

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

test('an MCP plugin is a connector package: no skills, its own servers, each switched off on its own', async () => {
  const calls = [];
  const rendered = await renderPanel('connectors', {
    data: {
      toolModules: {
        git: { enabled: true, installed: true },
        memory: { enabled: true, installed: true },
        office: { enabled: true, installed: true },
        tidy: { enabled: true, installed: true },
      },
      voice: { enabled: false, installed: false },
      plugins: {
        plugins: [
          {
            id: 'bundle',
            name: 'Bundle',
            enabled: true,
            mcpServerName: 'plugin-bundle',
            mcpScript: '.mcp.json',
            mcpEnabled: true,
            mcpErrors: [{ key: 'broken', message: 'stdio server requires "command"' }],
          },
        ],
      },
      skills: {
        skills: [
          { name: 'bundled-skill', description: 'Ships with Bundle', owner: { kind: 'plugin', id: 'bundle' } },
          { name: 'loose-skill', description: 'User skill' },
        ],
      },
      disabledSkills: { disabled: ['loose-skill'] },
      mcp: {
        servers: [
          {
            name: 'plugin-bundle',
            enabled: true,
            serverEnabled: true,
            source: 'plugin',
            owner: { kind: 'plugin', id: 'bundle', key: 'bundle' },
            config: { type: 'stdio', command: 'x' },
          },
          // Same name prefix, other owner: never listed under this plugin.
          {
            name: 'plugin-bundle-other',
            enabled: true,
            source: 'plugin',
            owner: { kind: 'plugin', id: 'other', key: 'x' },
          },
        ],
      },
    },
    async run(capability, args) {
      calls.push([capability, args]);
    },
  });
  try {
    await act(async () => {
      document.querySelector('[data-connector-row="bundle"] > button').click();
    });
    assert.equal(document.querySelector('[data-extension-item="plugin-bundle-other"]'), null);
    assert.match(document.querySelector('.extensions-dialog').textContent, /broken: stdio server requires "command"/);
    assert.equal(document.querySelector('[data-extension-item="bundled-skill"]'), null);
    assert.doesNotMatch(document.querySelector('.extensions-dialog').textContent, /bundled-skill/);
    await act(async () => {
      document.querySelector('[data-extension-item="plugin-bundle"] .extensions-action').click();
    });
    await act(async () => {
      [...document.querySelectorAll('.extensions-dialog button')]
        .find((node) => node.textContent === 'Disconnect')
        .click();
    });
    assert.deepEqual(calls.at(-1), ['setMcpServerEnabled', ['plugin-bundle', false]]);
  } finally {
    await rendered.cleanup();
  }
});

test('the Skill category lists only MCP; user skills live in their own category', async () => {
  const rendered = await renderPanel('skills', { createOpen: true });
  try {
    assert.deepEqual(
      [...document.querySelectorAll('.settings-group > header h3')].map((heading) => heading.textContent),
      ['MCP']
    );
    assert.doesNotMatch(document.body.textContent, /example-skill/);
    assert.match(document.body.textContent, /example-mcp/);
    assert.equal(document.querySelector('[data-extension-create-kind]'), null);
    assert.equal(document.querySelector('[data-extension-row="example-mcp"] input'), null);
    const mcpTag = document.querySelector('[data-extension-row="example-mcp"] .sidebar-resource-tag');
    assert.ok(mcpTag);
    assert.equal(mcpTag.textContent, 'Not connected');
    assert.equal(mcpTag.getAttribute('data-tone'), 'warn');
  } finally {
    await rendered.cleanup();
  }
});

const userSkillsPaneSkills = [
  skillRow('my-skill', 'global', { description: 'Mine' }),
  skillRow('office-guide', 'builtin', { description: 'Built in' }),
  skillRow('bundled-skill', 'plugin:bundle', { description: 'From a plugin' }),
];

test('the Skills pane lists own and plugin skills by source and creates a new one through addSkill', async () => {
  let closed = 0;
  const calls = [];
  const skills = userSkillsPaneSkills.map((skill) =>
    skill.name === 'my-skill' ? { ...skill, state: 'off', offBy: 'source', enabled: false } : skill
  );
  const rendered = await renderPanel('user-skills', {
    createOpen: true,
    closeCreate() {
      closed += 1;
    },
    data: {
      skills: { skills },
      plugins: { plugins: [{ id: 'bundle', name: 'Bundle Kit', enabled: true }] },
      disabledSkills: { disabled: ['global:my-skill'] },
      __loadedSections: ['skills'],
    },
    async run(capability, args) {
      calls.push([capability, args]);
      if (capability === 'skillContent') return { content: '# Mine' };
      return { ok: true };
    },
  });
  try {
    assert.deepEqual(
      [...document.querySelectorAll('.skills-category .sidebar-heading-toggle')].map((heading) => heading.textContent),
      ['My skills1', 'Bundle Kit1']
    );
    assert.ok(document.querySelector('[data-skill-source="global"] [data-extension-row="my-skill"]'));
    assert.ok(document.querySelector('[data-skill-source="plugin:bundle"] [data-extension-row="bundled-skill"]'));
    assert.equal(document.querySelector('[data-extension-row="office-guide"]'), null);
    assert.equal(
      document.querySelector('[data-extension-row="my-skill"] .sidebar-resource-tag').textContent,
      'Disabled'
    );

    // Create: the editor opens straight away and saves through addSkill.
    assert.equal(document.querySelector('#extensions-skill-dialog-title').textContent, 'Add skill');
    globalThis.FormData = window.FormData;
    document.querySelector('[name="skill-name"]').value = 'new-skill';
    document.querySelector('[name="skill-description"]').value = 'New one';
    await act(async () => {
      document
        .querySelector('.extensions-skill-dialog form')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(calls.find(([capability]) => capability === 'addSkill')[1][0].name, 'new-skill');
    assert.equal(closed, 1);
  } finally {
    await rendered.cleanup();
  }
});

test('the Skills pane edits a user skill through saveSkill', async () => {
  const calls = [];
  const edit = await renderPanel('user-skills', {
    data: { skills: { skills: userSkillsPaneSkills }, disabledSkills: { disabled: [] }, __loadedSections: ['skills'] },
    async run(capability, args) {
      calls.push([capability, args]);
      if (capability === 'skillContent') return { content: '# Mine' };
      return { ok: true };
    },
  });
  try {
    await act(async () => {
      document.querySelector('[data-extension-row="my-skill"] .skills-row-open').click();
    });
    assert.ok(document.querySelector('#extensions-skill-dialog-title'));
    await act(async () => {
      document
        .querySelector('.extensions-skill-dialog form')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(calls.findLast(([capability]) => capability === 'saveSkill')[1][0].originalName, 'global:my-skill');
  } finally {
    await edit.cleanup();
  }
});

// Own `review` hides the plugin's; the plugin's `setup` is in use in the
// built-in's place; `deploy` and `lint` occur once.
const sourceSkills = () => [
  skillRow('deploy', 'global'),
  skillRow('review', 'global'),
  skillRow('lint', 'plugin:acme'),
  skillRow('review', 'plugin:acme', { state: 'hidden', hiddenBy: 'global' }),
  skillRow('setup', 'plugin:acme', { replacesBuiltin: true }),
  skillRow('docx', 'builtin'),
  skillRow('setup', 'builtin', { state: 'hidden', hiddenBy: 'plugin:acme' }),
];

function renderSourceSkills(skills, disabled, calls) {
  return renderPanel('user-skills', {
    data: {
      skills: { skills },
      plugins: { plugins: [{ id: 'acme', name: 'Acme Tools', enabled: true }] },
      disabledSkills: { disabled },
      __loadedSections: ['skills'],
    },
    async run(capability, args) {
      calls.push([capability, args]);
      if (capability === 'skillContent') return { content: '# Skill' };
      return { ok: true };
    },
  });
}

const skillRowElement = (key) => document.querySelector(`[data-skill-key="${key}"]`);
const rowStatus = (key) => {
  const row = skillRowElement(key);
  const tag = row.querySelector('.sidebar-resource-tag');
  return {
    tag: tag?.textContent ?? null,
    tone: tag?.dataset.tone ?? null,
    note: row.querySelector('.skills-row-note')?.textContent ?? null,
  };
};

test('the Skills pane groups own and plugin skills by source and says which skill of a name is in use', async () => {
  const rendered = await renderSourceSkills(sourceSkills(), [], []);
  try {
    assert.deepEqual(
      [...document.querySelectorAll('.skills-category .sidebar-heading-toggle')].map((heading) => heading.textContent),
      ['My skills2', 'Acme Tools3', 'Built-in1']
    );
    assert.equal(skillRowElement('builtin:docx'), null, 'a built-in that shares no name stays unlisted');
    assert.deepEqual(rowStatus('builtin:setup'), { tag: 'Overridden', tone: 'muted', note: 'In use: Acme Tools' });
    assert.deepEqual(rowStatus('global:deploy'), { tag: null, tone: null, note: null });
    assert.deepEqual(rowStatus('global:review'), { tag: 'In use', tone: 'ok', note: null });
    assert.deepEqual(rowStatus('plugin:acme:review'), { tag: 'Overridden', tone: 'muted', note: 'In use: My skills' });
    assert.deepEqual(rowStatus('plugin:acme:setup'), {
      tag: 'In use',
      tone: 'ok',
      note: 'Replaces the built-in skill',
    });
    assert.equal(skillRowElement('plugin:acme:review').querySelector('input').checked, true);
  } finally {
    await rendered.cleanup();
  }
});

test('"Same names only" keeps the names more than one source ships, a built-in counted', async () => {
  const rendered = await renderSourceSkills(sourceSkills(), [], []);
  try {
    const chip = (label) =>
      [...document.querySelectorAll('.skills-filter button')].find((button) => button.textContent === label);
    await act(async () => chip('Same names only').click());
    assert.equal(chip('Same names only').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(
      [...document.querySelectorAll('[data-skill-key]')].map((row) => row.dataset.skillKey),
      ['global:review', 'plugin:acme:review', 'plugin:acme:setup', 'builtin:setup']
    );
    assert.deepEqual(
      [...document.querySelectorAll('.skills-category .sidebar-heading-toggle')].map((heading) => heading.textContent),
      ['My skills1', 'Acme Tools2', 'Built-in1']
    );
    await act(async () => chip('All').click());
    assert.equal(document.querySelectorAll('[data-skill-key]').length, 6);
  } finally {
    await rendered.cleanup();
  }
});

test('the row switch, the row menu and the editor switch each ask the core to switch that row by its key', async () => {
  const calls = [];
  // `review` is off through a bare name entry: turning the own row on is still one row's switch.
  const skills = sourceSkills().map((skill) =>
    skill.key === 'global:review' ? { ...skill, state: 'off', offBy: 'name', enabled: false } : skill
  );
  const rendered = await renderSourceSkills(skills, ['review'], calls);
  const switched = () => calls.filter(([capability]) => capability !== 'skillContent');
  try {
    await act(async () => skillRowElement('plugin:acme:setup').querySelector('input').click());
    assert.deepEqual(switched().at(-1), ['setSkillEnabled', ['plugin:acme:setup', false]]);

    const row = skillRowElement('plugin:acme:lint');
    await act(async () =>
      row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }))
    );
    assert.equal(document.querySelector('[role="menuitem"][data-action-id="remove"]'), null, 'a plugin skill is not deleted here');
    await act(async () => document.querySelector('[role="menuitem"][data-action-id="toggle"]').click());
    assert.deepEqual(switched().at(-1), ['setSkillEnabled', ['plugin:acme:lint', false]]);

    await act(async () => skillRowElement('global:review').querySelector('input').click());
    assert.deepEqual(switched().at(-1), ['setSkillEnabled', ['global:review', true]]);

    await act(async () => skillRowElement('plugin:acme:review').querySelector('.skills-row-open').click());
    await act(async () => document.querySelector('.extensions-skill-dialog header input[type="checkbox"]').click());
    assert.deepEqual(switched().at(-1), ['setSkillEnabled', ['plugin:acme:review', false]]);
    assert.equal(switched().length, 4, 'the disabled list is never read or rewritten from the panel');
  } finally {
    await rendered.cleanup();
  }
});

test('saving a plugin row\'s required tools names that row, not the own skill of its name', async () => {
  const calls = [];
  const rendered = await renderSourceSkills(sourceSkills(), [], calls);
  try {
    await act(async () => skillRowElement('plugin:acme:review').querySelector('.skills-row-open').click());
    const add = [...document.querySelectorAll('.extensions-skill-dialog .extensions-mcp-list-add')].find(
      (button) => button.textContent === '+ Add'
    );
    await act(async () => add.click());
    globalThis.FormData = window.FormData;
    await act(async () => {
      document
        .querySelector('.extensions-skill-dialog form')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(calls.findLast(([capability]) => capability === 'saveSkill'), [
      'saveSkill',
      [{ originalName: 'plugin:acme:review', dependenciesOnly: true, toolDependencies: [] }],
    ]);
  } finally {
    await rendered.cleanup();
  }
});

test('a skill its required feature or its project scope turns off reads as off, never in use, and is no built-in to turn back on', async () => {
  for (const offBy of ['feature', 'scope']) {
    const off = { state: 'off', offBy, enabled: false, switchable: false };
    const skills = [
      ...sourceSkills().map((skill) => (skill.key === 'plugin:acme:setup' ? { ...skill, ...off } : skill)),
      skillRow('pdf', 'builtin', off),
    ];
    const rendered = await renderSourceSkills(skills, [], []);
    try {
      assert.deepEqual(rowStatus('plugin:acme:setup'), { tag: 'Disabled', tone: 'muted', note: null }, offBy);
      assert.equal(skillRowElement('plugin:acme:setup').querySelector('input').checked, false, offBy);
      assert.equal(skillRowElement('builtin:pdf'), null, `${offBy}: not a built-in to turn back on`);
    } finally {
      await rendered.cleanup();
    }
  }
});

test('a row the core marks not switchable has no working switch, menu toggle or editor switch, whatever its offBy', async () => {
  for (const [state, offBy] of [
    ['inUse', null],
    ['off', 'source'],
    ['off', 'name'],
    ['off', 'feature'],
    ['off', 'scope'],
  ]) {
    const skills = sourceSkills().map((skill) =>
      skill.key === 'plugin:acme:lint' ? { ...skill, state, offBy, switchable: false } : skill
    );
    const rendered = await renderSourceSkills(skills, [], []);
    try {
      const row = skillRowElement('plugin:acme:lint');
      assert.equal(row.querySelector('input').disabled, true, `${state}/${offBy}`);
      assert.equal(skillRowElement('plugin:acme:setup').querySelector('input').disabled, false, 'a switchable row stays live');
      await act(async () =>
        row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }))
      );
      assert.equal(document.querySelector('[role="menuitem"][data-action-id="toggle"]'), null, `${state}/${offBy}`);
      await act(async () => document.querySelector('[role="menuitem"][data-action-id="open"]').click());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      assert.ok(document.querySelector('#extensions-skill-dialog-title'), `${state}/${offBy}: the editor opened`);
      assert.equal(
        document.querySelector('.extensions-skill-dialog header input[type="checkbox"]'),
        null,
        `${state}/${offBy}`
      );
    } finally {
      await rendered.cleanup();
    }
  }
});

test('built-ins the disabled list turns off are listed last so they can be turned back on', async () => {
  const calls = [];
  const skills = [
    ...sourceSkills(),
    skillRow('pdf', 'builtin', { state: 'off', offBy: 'source', enabled: false }),
    skillRow('xlsx', 'builtin', { state: 'off', offBy: 'name', enabled: false }),
    skillRow('image', 'builtin', { state: 'off', offBy: 'feature', enabled: false, switchable: false }),
  ];
  const rendered = await renderSourceSkills(skills, ['builtin:pdf', 'xlsx'], calls);
  try {
    const categories = [...document.querySelectorAll('.skills-category')];
    assert.deepEqual(
      categories.map((category) => category.dataset.skillSource),
      ['global', 'plugin:acme', 'builtin']
    );
    assert.equal(categories[2].querySelector('.sidebar-heading-toggle').textContent, 'Built-in3');
    assert.deepEqual(
      [...categories[2].querySelectorAll('[data-skill-key]')].map((row) => row.dataset.skillKey),
      ['builtin:setup', 'builtin:pdf', 'builtin:xlsx']
    );
    await act(async () => skillRowElement('builtin:pdf').querySelector('input').click());
    assert.deepEqual(calls.at(-1), ['setSkillEnabled', ['builtin:pdf', true]]);
  } finally {
    await rendered.cleanup();
  }
});

test('a built-in turned back on while a plugin skill of its name stays off is still listed and can be turned off again', async () => {
  const calls = [];
  // From `["setup"]` the built-in was switched on: its own row is in use, the plugin's stays off by the bare name.
  const skills = [
    skillRow('lint', 'plugin:acme'),
    skillRow('setup', 'plugin:acme', { state: 'off', offBy: 'name', enabled: false }),
    skillRow('docx', 'builtin'),
    skillRow('setup', 'builtin'),
  ];
  const rendered = await renderSourceSkills(skills, ['plugin:acme:setup'], calls);
  try {
    assert.deepEqual(
      [...document.querySelectorAll('[data-skill-source="builtin"] [data-skill-key]')].map((row) => row.dataset.skillKey),
      ['builtin:setup']
    );
    assert.deepEqual(rowStatus('builtin:setup'), { tag: 'In use', tone: 'ok', note: null });
    const input = skillRowElement('builtin:setup').querySelector('input');
    assert.equal(input.checked, true);
    await act(async () => input.click());
    assert.deepEqual(calls.at(-1), ['setSkillEnabled', ['builtin:setup', false]]);
  } finally {
    await rendered.cleanup();
  }
});

test('after the core replies the switch shows the refreshed row, not the value it asked for', async () => {
  const offBySource = sourceSkills().map((skill) =>
    skill.key === 'plugin:acme:lint' ? { ...skill, state: 'off', offBy: 'source', enabled: false } : skill
  );
  // The key is gone from the list, but the plugin's scope still leaves this folder out.
  const offByScope = sourceSkills().map((skill) =>
    skill.key === 'plugin:acme:lint' ? { ...skill, state: 'off', offBy: 'scope', enabled: false, switchable: false } : skill
  );
  let reply;
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = (skills) =>
    root.render(
      React.createElement(CategoryPanel, {
        category: 'user-skills',
        context: panelContext({
          data: {
            skills: { skills },
            plugins: { plugins: [{ id: 'acme', name: 'Acme Tools', enabled: true }] },
            __loadedSections: ['skills'],
          },
          run: (capability) =>
            capability === 'setSkillEnabled' ? new Promise((resolve) => (reply = resolve)) : Promise.resolve({}),
        }),
      })
    );
  try {
    await act(async () => render(offBySource));
    const input = () => skillRowElement('plugin:acme:lint').querySelector('input');
    assert.equal(input().checked, false);
    await act(async () => input().click());
    assert.equal(input().checked, true, 'the asked value shows until the reply');
    await act(async () => render(offByScope));
    await act(async () => reply({ disabled: [] }));
    assert.equal(input().checked, false);
    assert.equal(input().disabled, true);
    assert.deepEqual(rowStatus('plugin:acme:lint'), { tag: 'Disabled', tone: 'muted', note: null });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('opening the hidden row of a shared name asks for that row, not the one in use', async () => {
  const calls = [];
  const rendered = await renderSourceSkills(sourceSkills(), [], calls);
  try {
    await act(async () => skillRowElement('plugin:acme:review').querySelector('.skills-row-open').click());
    assert.deepEqual(
      calls.filter(([capability]) => capability === 'skillContent'),
      [['skillContent', ['plugin:acme:review']]]
    );
    assert.ok(document.querySelector('#extensions-skill-dialog-title'));
  } finally {
    await rendered.cleanup();
  }
});

test('a collapsed skill category stays collapsed the next time the pane opens', async () => {
  window.localStorage.removeItem('mixdog:skills-panel-category-open');
  const first = await renderSourceSkills(sourceSkills(), [], []);
  try {
    const heading = () => document.querySelector('[data-skill-source="plugin:acme"] .sidebar-heading-toggle');
    await act(async () => heading().click());
    assert.equal(heading().getAttribute('aria-expanded'), 'false');
    assert.equal(skillRowElement('plugin:acme:lint'), null);
    assert.ok(skillRowElement('global:deploy'), 'the other category stays open');
  } finally {
    await first.cleanup();
  }
  const second = await renderSourceSkills(sourceSkills(), [], []);
  try {
    assert.equal(
      document.querySelector('[data-skill-source="plugin:acme"] .sidebar-heading-toggle').getAttribute('aria-expanded'),
      'false'
    );
    assert.equal(skillRowElement('plugin:acme:lint'), null);
  } finally {
    await second.cleanup();
    window.localStorage.removeItem('mixdog:skills-panel-category-open');
  }
});

async function submitNewMcp(name) {
  globalThis.FormData = window.FormData;
  document.querySelector('[name="mcp-name"]').value = name;
  document.querySelector('[name="mcp-command"]').value = 'example';
  await act(async () => {
    document
      .querySelector('.extensions-mcp-dialog form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

test('a new MCP server is created through the duplicate-rejecting add, never the overwriting save', async () => {
  const calls = [];
  let closed = 0;
  const rendered = await renderPanel('mcp', {
    createOpen: true,
    closeCreate() {
      closed += 1;
    },
    async run(capability, args) {
      calls.push([capability, args]);
      return { name: args[0].name };
    },
  });
  try {
    await submitNewMcp('fresh-mcp');
    assert.deepEqual(
      calls.map(([capability]) => capability),
      ['addMcpServer']
    );
    assert.equal(calls[0][1][0].name, 'fresh-mcp');
    assert.equal(calls[0][1][0].originalName, undefined);
    assert.equal(closed, 1);
  } finally {
    await rendered.cleanup();
  }
});

test('the add dialog stays open and shows the host duplicate rejection from a stale name list', async () => {
  let closed = 0;
  const rendered = await renderPanel('mcp', {
    createOpen: true,
    closeCreate() {
      closed += 1;
    },
    async run(capability) {
      assert.equal(capability, 'addMcpServer');
      throw new Error('MCP server already exists: raced-mcp');
    },
  });
  try {
    await submitNewMcp('raced-mcp');
    assert.equal(closed, 0);
    assert.ok(document.querySelector('#extensions-mcp-dialog-title'), 'the dialog is still open');
    assert.match(document.querySelector('.extensions-mcp-dialog').textContent, /MCP server already exists: raced-mcp/);
  } finally {
    await rendered.cleanup();
  }
});

test('a Skill row acknowledges the card click before its detail payload resolves', async () => {
  const skillContent = Promise.withResolvers();
  const rendered = await renderPanel('user-skills', {
    async run(capability) {
      if (capability === 'skillContent') return skillContent.promise;
    },
  });
  try {
    await act(async () => {
      document.querySelector('[data-extension-row="example-skill"] .skills-row-open').click();
    });
    assert.match(document.querySelector('[data-extension-loading="skill"]').textContent, /Loading/);

    await act(async () => {
      skillContent.resolve({ content: '# Example' });
      await skillContent.promise;
    });
    assert.ok(document.querySelector('#extensions-skill-dialog-title'));
  } finally {
    skillContent.resolve({ content: '# Example' });
    await rendered.cleanup();
  }
});

test('an MCP row acknowledges the card click before its detail payload resolves', async () => {
  const mcpConfig = Promise.withResolvers();
  const rendered = await renderPanel('mcp', {
    async run(capability) {
      if (capability === 'getMcpServerConfig') return mcpConfig.promise;
    },
  });
  try {
    await act(async () => {
      document.querySelector('[data-extension-row="example-mcp"]').click();
    });
    assert.match(document.querySelector('[data-extension-loading="mcp"]').textContent, /Loading/);

    await act(async () => {
      mcpConfig.resolve({ name: 'example-mcp', config: { type: 'stdio', command: 'example' } });
      await mcpConfig.promise;
    });
    assert.ok(document.querySelector('#extensions-mcp-dialog-title'));
  } finally {
    mcpConfig.resolve({ name: 'example-mcp', config: { type: 'stdio', command: 'example' } });
    await rendered.cleanup();
  }
});

const sidebarData = () => ({
  toolModules: {},
  voice: { enabled: false, installed: false },
  plugins: {
    plugins: [
      { id: 'off-plugin', name: 'Off plugin', enabled: false },
      { id: 'on-plugin', name: 'On plugin', enabled: true },
    ],
  },
  skills: {
    skills: [
      skillRow('off-skill', 'global', { description: 'Disabled skill', state: 'off', offBy: 'source', enabled: false }),
      skillRow('on-skill', 'global', { description: 'Active skill' }),
    ],
  },
  disabledSkills: { disabled: ['global:off-skill'] },
  mcp: {
    servers: [
      { name: 'off-mcp', enabled: false, config: { type: 'stdio', command: 'x' } },
      { name: 'connected-mcp', enabled: true, connected: true, config: { type: 'stdio', command: 'y' } },
    ],
  },
});

test('a disabled Skill row is tagged and an active one is not', async () => {
  const renderedSkills = await renderPanel('user-skills', { data: sidebarData() });
  try {
    const offSkillTag = document.querySelector('[data-extension-row="off-skill"] .sidebar-resource-tag');
    assert.ok(offSkillTag);
    assert.equal(offSkillTag.textContent, 'Disabled');
    assert.equal(offSkillTag.getAttribute('data-tone'), 'muted');

    const onSkillTag = document.querySelector('[data-extension-row="on-skill"] .sidebar-resource-tag');
    assert.equal(onSkillTag, null);
  } finally {
    await renderedSkills.cleanup();
  }
});

test('a disabled MCP row is tagged and a connected one is not', async () => {
  const renderedMcp = await renderPanel('skills', { data: sidebarData() });
  try {
    const offMcpTag = document.querySelector('[data-extension-row="off-mcp"] .sidebar-resource-tag');
    assert.ok(offMcpTag);
    assert.equal(offMcpTag.textContent, 'Disabled');
    assert.equal(offMcpTag.getAttribute('data-tone'), 'muted');

    const connectedMcpTag = document.querySelector('[data-extension-row="connected-mcp"] .sidebar-resource-tag');
    assert.equal(connectedMcpTag, null);
  } finally {
    await renderedMcp.cleanup();
  }
});

test('a disabled Plugin row is tagged and an enabled one is not', async () => {
  const renderedPlugins = await renderPanel('plugins', {
    data: {
      toolModules: {},
      voice: { enabled: false, installed: false },
      plugins: {
        plugins: [
          { id: 'off-plugin', name: 'Off plugin', enabled: false },
          { id: 'on-plugin', name: 'On plugin', enabled: true },
        ],
      },
      skills: { skills: [] },
      disabledSkills: { disabled: [] },
      mcp: { servers: [] },
    },
  });
  try {
    const offPluginTag = document.querySelector('[data-extension-row="Off plugin"] .sidebar-resource-tag');
    assert.ok(offPluginTag);
    assert.equal(offPluginTag.textContent, 'Disabled');
    assert.equal(offPluginTag.getAttribute('data-tone'), 'muted');

    const onPluginTag = document.querySelector('[data-extension-row="On plugin"] .sidebar-resource-tag');
    assert.equal(onPluginTag, null);
  } finally {
    await renderedPlugins.cleanup();
  }
});

test('Workflow card surface opens an immediate loading popup before editor data resolves', async () => {
  const workflowPack = Promise.withResolvers();
  const api = {
    async invokeCapability({ capability }) {
      if (capability === 'getWorkflowPack') return workflowPack.promise;
      return { value: undefined };
    },
    async listProviderModels() {
      return [];
    },
  };
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('workflows', [
    {
      id: 'alpha',
      name: 'Alpha',
      description: 'Example workflow',
      source: 'user',
    },
  ]);
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

test('Code Tidy card renders engine list, install progress, and failed engine row', async () => {
  let tidyEngineStatus = {
    toolsDir: 'C:\\Users\\alice\\.mixdog\\data\\tools',
    core: ['biome', 'ruff', 'shfmt', 'shellcheck', 'psscriptanalyzer'],
    engines: [
      {
        id: 'biome',
        title: 'Biome',
        languages: ['JavaScript', 'TypeScript', 'JSON', 'CSS'],
        kind: ['formatter', 'linter'],
        version: '1.9.4',
        source: 'managed',
        bytes: 35651584,
        managed: true,
        core: true,
        toolchain: false,
      },
      {
        id: 'shfmt',
        title: 'shfmt',
        languages: ['Shell'],
        kind: ['formatter'],
        version: '3.7.0',
        source: 'host',
        managed: true,
        core: true,
        toolchain: false,
      },
      {
        id: 'ruff',
        title: 'ruff',
        languages: ['Python'],
        kind: ['formatter', 'linter'],
        version: '',
        source: 'missing',
        managed: true,
        core: true,
        toolchain: false,
      },
      {
        id: 'psscriptanalyzer',
        title: 'PSScriptAnalyzer',
        languages: ['PowerShell'],
        kind: ['formatter', 'linter'],
        version: '',
        source: 'missing',
        managed: true,
        core: true,
        toolchain: false,
        installHint: 'Install PowerShell (pwsh) to use PSScriptAnalyzer',
      },
      {
        id: 'google-java-format',
        title: 'google-java-format',
        languages: ['Java'],
        kind: ['formatter'],
        version: '',
        source: 'missing',
        managed: true,
        core: false,
        toolchain: false,
      },
      {
        id: 'rustfmt',
        title: 'rustfmt',
        languages: ['Rust'],
        kind: ['formatter'],
        version: '',
        source: 'missing',
        managed: false,
        core: false,
        toolchain: true,
        installHint: 'Install rustup and run `rustup component add rustfmt`',
      },
      {
        id: 'ast-grep',
        title: 'ast-grep',
        languages: ['C', 'Rust', 'Go'],
        kind: ['structural'],
        version: '0.34.0',
        source: 'managed',
        managed: true,
        core: false,
        toolchain: false,
      },
    ],
    installing: null,
  };

  let tidyInstallStatus = null;
  const installDeferred = Promise.withResolvers();

  const context = writablePanelContext({
    data: {
      ...panelContext().data,
      toolModules: {
        ...panelContext().data.toolModules,
        tidy: { enabled: false, installed: false },
      },
    },
    api: {
      ...panelContext().api,
      async readCapabilities(requests) {
        return requests.map((req) => {
          if (req.capability === 'getTidyEngineStatus') {
            return { ok: true, value: tidyEngineStatus };
          }
          if (req.capability === 'getTidyInstallStatus') {
            return { ok: true, value: tidyInstallStatus };
          }
          return { ok: false, error: 'unknown' };
        });
      },
    },
    async run(capability, args) {
      if (capability === 'installBuiltinFeature' && args[0] === 'tidy') {
        await installDeferred.promise;
        // Simulate install completing with feature installed, but ruff failed and psscriptanalyzer skipped
        tidyEngineStatus = {
          ...tidyEngineStatus,
          engines: tidyEngineStatus.engines.map((e) => {
            const source = { biome: 'managed', shfmt: 'host', ruff: 'missing' }[e.id];
            return source ? { ...e, source } : e;
          }),
          installing: {
            active: false,
            percent: 100,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            engines: [
              {
                id: 'biome',
                status: 'installed',
                receivedBytes: 35651584,
                totalBytes: 35651584,
                version: '1.9.4',
                bytes: 35651584,
              },
              {
                id: 'shfmt',
                status: 'present',
                receivedBytes: 0,
                totalBytes: 0,
                version: '3.7.0',
                bytes: 0,
              },
              {
                id: 'ruff',
                status: 'failed',
                receivedBytes: 12897485,
                totalBytes: 78643200,
                version: '',
                bytes: 0,
                error: 'Checksum mismatch',
              },
              {
                id: 'psscriptanalyzer',
                status: 'skipped',
                receivedBytes: 0,
                totalBytes: 0,
                version: '',
                bytes: 0,
                installHint: 'Install PowerShell (pwsh) to use PSScriptAnalyzer',
              },
            ],
          },
        };
        return { tidy: { installed: true, enabled: true } };
      }
      return {};
    },
  });

  const rendered = await renderPanel('plugins', context);
  try {
    // Open Code Tidy dialog
    await act(async () => {
      document.querySelector('[data-built-in-feature="tidy"]').click();
    });

    const dialog = document.querySelector('[data-feature-id="tidy"]');
    assert.ok(dialog);

    // 1. Check ast-grep is excluded from engine rows
    assert.equal(dialog.querySelector('[data-tidy-engine="ast-grep"]'), null);

    // Check Biome (installed managed): no tag, row tone ok, description languages · version · size
    const biomeRow = dialog.querySelector('[data-tidy-engine="biome"]');
    assert.ok(biomeRow);
    assert.equal(biomeRow.getAttribute('data-tone'), 'ok');
    assert.equal(biomeRow.querySelector('.extensions-item-badge'), null);
    assert.match(biomeRow.textContent, /JavaScript, TypeScript, JSON, CSS · 1\.9\.4 · 34\.0 MB/);

    // Check shfmt (present host engine): no tag
    const shfmtRow = dialog.querySelector('[data-tidy-engine="shfmt"]');
    assert.ok(shfmtRow);
    assert.equal(shfmtRow.getAttribute('data-tone'), 'ok');
    assert.equal(shfmtRow.querySelector('.extensions-item-badge'), null);
    assert.match(shfmtRow.textContent, /Shell · 3\.7\.0/);

    // Check ruff (core, missing): tag 'Not installed' (muted), description 'Python'
    const ruffRow = dialog.querySelector('[data-tidy-engine="ruff"]');
    assert.ok(ruffRow);
    const ruffTag = ruffRow.querySelector('.extensions-item-badge');
    assert.ok(ruffTag);
    assert.equal(ruffTag.textContent, 'Not installed');
    assert.equal(ruffTag.getAttribute('data-tone'), 'muted');
    assert.match(ruffRow.textContent, /Python/);

    // Check google-java-format (non-core managed, missing): tag 'On demand' (muted)
    const javaRow = dialog.querySelector('[data-tidy-engine="google-java-format"]');
    assert.ok(javaRow);
    const javaTag = javaRow.querySelector('.extensions-item-badge');
    assert.ok(javaTag);
    assert.equal(javaTag.textContent, 'On demand');
    assert.equal(javaTag.getAttribute('data-tone'), 'muted');

    // Check rustfmt (toolchain host missing): tag 'Not detected' (muted), description is installHint
    const rustRow = dialog.querySelector('[data-tidy-engine="rustfmt"]');
    assert.ok(rustRow);
    const rustTag = rustRow.querySelector('.extensions-item-badge');
    assert.ok(rustTag);
    assert.equal(rustTag.textContent, 'Not detected');
    assert.equal(rustTag.getAttribute('data-tone'), 'muted');
    assert.match(rustRow.textContent, /Install rustup and run `rustup component add rustfmt`/);

    // Section title count is installed engines (2: Biome + shfmt)
    const enginesSection = dialog.querySelector('.extensions-section');
    assert.ok(enginesSection);
    assert.equal(enginesSection.querySelector('em')?.textContent, '2');

    // ExtensionNote under Engines section
    assert.match(
      dialog.textContent,
      /Structural rules are built in; engines download to C:\\Users\\alice\\\.mixdog\\data\\tools\./
    );

    // Info block fact
    assert.match(
      dialog.textContent,
      /Install downloads the core engines \(Biome, ruff, shfmt, shellcheck, PSScriptAnalyzer\); other languages download on first use\./
    );

    // 2. Active install progress text
    tidyInstallStatus = {
      active: true,
      percent: 42,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      engines: [
        {
          id: 'ruff',
          status: 'downloading',
          receivedBytes: 12897485,
          totalBytes: 78643200,
          version: '',
          bytes: 0,
        },
        {
          id: 'psscriptanalyzer',
          status: 'downloading',
          receivedBytes: 12897485,
          totalBytes: 0, // totalBytes 0/null → Downloading 12.3 MB (no slash)
          version: '',
          bytes: 0,
        },
      ],
    };

    // Trigger install
    const installButton = dialog.querySelector('.built-in-feature-control button');
    assert.ok(installButton);

    // Start install
    await act(async () => {
      installButton.click();
    });

    // While installing: SlotProgress in header, badge on list, progress text in engine rows
    const progressSlot = dialog.querySelector('.built-in-feature-slot-progress');
    assert.ok(progressSlot);
    assert.equal(progressSlot.getAttribute('aria-valuenow'), '42');
    assert.equal(progressSlot.getAttribute('aria-valuetext'), 'Installing Code Tidy…');
    assert.match(progressSlot.textContent, /42%/);

    const tidyListBadge = document.querySelector('[data-built-in-feature="tidy"] .sidebar-resource-tag');
    assert.ok(tidyListBadge);
    assert.equal(tidyListBadge.textContent, 'Installing… 42%');
    assert.equal(tidyListBadge.getAttribute('data-tone'), 'muted');

    // With totalBytes > 0: has slash
    assert.match(
      dialog.querySelector('[data-tidy-engine="ruff"]')?.textContent || '',
      /Downloading 12\.3 MB \/ 75\.0 MB/
    );

    // With totalBytes 0/null: exactly "Downloading 12.3 MB" without slash
    const pwshRowProgress = dialog.querySelector('[data-tidy-engine="psscriptanalyzer"]');
    assert.ok(pwshRowProgress);
    assert.match(pwshRowProgress.textContent, /Downloading 12\.3 MB/);
    assert.doesNotMatch(pwshRowProgress.textContent, /Downloading 12\.3 MB \//);

    // Resolve the install
    await act(async () => {
      installDeferred.resolve();
    });

    // 3. After install finishes:
    // ruff shows as Failed (danger) with error in description
    const postRuffRow = dialog.querySelector('[data-tidy-engine="ruff"]');
    assert.ok(postRuffRow);
    const failedTag = postRuffRow.querySelector('.extensions-item-badge');
    assert.ok(failedTag);
    assert.equal(failedTag.textContent, 'Failed');
    assert.equal(failedTag.getAttribute('data-tone'), 'danger');
    assert.match(postRuffRow.textContent, /Checksum mismatch/);

    // present engine: shfmt still has no tag
    const postShfmtRow = dialog.querySelector('[data-tidy-engine="shfmt"]');
    assert.ok(postShfmtRow);
    assert.equal(postShfmtRow.querySelector('.extensions-item-badge'), null);

    // skipped engine: psscriptanalyzer renders 'Not detected' (muted) + installHint
    const postPwshRow = dialog.querySelector('[data-tidy-engine="psscriptanalyzer"]');
    assert.ok(postPwshRow);
    const skippedTag = postPwshRow.querySelector('.extensions-item-badge');
    assert.ok(skippedTag);
    assert.equal(skippedTag.textContent, 'Not detected');
    assert.equal(skippedTag.getAttribute('data-tone'), 'muted');
    assert.match(postPwshRow.textContent, /Install PowerShell \(pwsh\) to use PSScriptAnalyzer/);
  } finally {
    await rendered.cleanup();
  }
});

async function renderTidyWithPendingProbe(settledPsEngine) {
  const engine = (id, title, extra = {}) => ({
    id,
    title,
    languages: [title],
    kind: ['formatter'],
    version: '1.0.0',
    source: 'managed',
    managed: true,
    core: true,
    toolchain: false,
    ...extra,
  });
  const pending = engine('psscriptanalyzer', 'PSScriptAnalyzer', { source: 'missing', version: '', probing: true });
  let tidyEngineStatus = {
    toolsDir: 'C:\\tools',
    core: ['biome', 'psscriptanalyzer'],
    engines: [engine('biome', 'Biome'), pending],
    probing: true,
    installing: null,
  };
  const rendered = await renderPanel(
    'plugins',
    writablePanelContext({
      data: {
        ...panelContext().data,
        toolModules: { ...panelContext().data.toolModules, tidy: { enabled: true, installed: true } },
      },
      api: {
        ...panelContext().api,
        async readCapabilities(requests) {
          return requests.map((req) =>
            req.capability === 'getTidyEngineStatus' ? { ok: true, value: tidyEngineStatus } : { ok: true, value: null }
          );
        },
      },
    })
  );
  const listTag = () => document.querySelector('[data-built-in-feature="tidy"] .sidebar-resource-tag');
  const settle = async () => {
    // The daemon's probe answers; the card must pick that up without user action.
    tidyEngineStatus = {
      ...tidyEngineStatus,
      engines: [engine('biome', 'Biome'), { ...pending, ...settledPsEngine, probing: undefined }],
      probing: false,
    };
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
  };
  return { rendered, listTag, settle };
}

test('Code Tidy reports a pending host-module probe as pending, then shows the host engine once it answers', async () => {
  const { rendered, listTag, settle } = await renderTidyWithPendingProbe({ source: 'host', version: '1.25.0' });
  try {
    assert.equal(listTag(), null, 'a pending probe is not "Setup needed"');
    await act(async () => {
      document.querySelector('[data-built-in-feature="tidy"]').click();
    });
    const row = () => document.querySelector('[data-feature-id="tidy"] [data-tidy-engine="psscriptanalyzer"]');
    assert.equal(row().querySelector('.extensions-item-badge').textContent, 'Checking…');
    await settle();
    assert.equal(row().querySelector('.extensions-item-badge')?.textContent ?? '', '');
    assert.match(row().textContent, /1\.25\.0/);
    assert.equal(listTag(), null);
  } finally {
    await rendered.cleanup();
  }
});

test('Code Tidy shows a host-module engine as missing once its probe answers that it is absent', async () => {
  const { rendered, listTag, settle } = await renderTidyWithPendingProbe({ source: 'missing', installable: true });
  try {
    assert.equal(listTag(), null);
    await act(async () => {
      document.querySelector('[data-built-in-feature="tidy"]').click();
    });
    await settle();
    const row = document.querySelector('[data-feature-id="tidy"] [data-tidy-engine="psscriptanalyzer"]');
    assert.equal(row.querySelector('.extensions-item-badge').textContent, 'Not installed');
    assert.equal(row.querySelector('button.extensions-action').textContent, 'Install');
    assert.equal(listTag().textContent, 'Setup needed');
  } finally {
    await rendered.cleanup();
  }
});

test('an installed Code Tidy with missing core engines flags setup and offers per-engine Install/Retry', async () => {
  const engine = (id, title, extra = {}) => ({
    id,
    title,
    languages: [title],
    kind: ['formatter'],
    version: '',
    source: 'missing',
    managed: true,
    core: true,
    toolchain: false,
    ...extra,
  });
  let tidyEngineStatus = {
    toolsDir: 'C:\\tools',
    core: ['biome', 'ruff', 'shellcheck', 'psscriptanalyzer'],
    engines: [
      engine('biome', 'Biome', { source: 'managed', version: '1.9.4' }),
      engine('ruff', 'ruff', { installable: true }),
      engine('shellcheck', 'ShellCheck', { installable: true }),
      engine('psscriptanalyzer', 'PSScriptAnalyzer'),
    ],
    installing: null,
  };
  const installDeferred = Promise.withResolvers();
  const runs = [];
  const context = writablePanelContext({
    data: {
      ...panelContext().data,
      toolModules: { ...panelContext().data.toolModules, tidy: { enabled: true, installed: true } },
    },
    api: {
      ...panelContext().api,
      async readCapabilities(requests) {
        return requests.map((req) =>
          req.capability === 'getTidyEngineStatus' ? { ok: true, value: tidyEngineStatus } : { ok: true, value: null }
        );
      },
    },
    async run(capability, args) {
      runs.push([capability, args]);
      if (capability === 'installBuiltinFeature') {
        await installDeferred.promise;
        tidyEngineStatus = {
          ...tidyEngineStatus,
          installing: {
            active: false,
            percent: 100,
            startedAt: 1,
            updatedAt: 2,
            engines: [
              {
                id: 'ruff',
                status: 'failed',
                receivedBytes: 0,
                totalBytes: 0,
                version: '',
                bytes: 0,
                error: 'HTTP 503',
              },
            ],
          },
        };
      }
      return {};
    },
  });

  const rendered = await renderPanel('plugins', context);
  try {
    // Installed and enabled, yet a core engine is missing: not plain ready.
    const listTag = document.querySelector('[data-built-in-feature="tidy"] .sidebar-resource-tag');
    assert.equal(listTag?.textContent, 'Setup needed');
    assert.equal(listTag.getAttribute('data-tone'), 'warn');

    await act(async () => {
      document.querySelector('[data-built-in-feature="tidy"]').click();
    });
    const dialog = document.querySelector('[data-feature-id="tidy"]');
    const actionOf = (id) => dialog.querySelector(`[data-tidy-engine="${id}"] button.extensions-action`);
    assert.equal(actionOf('biome'), null);
    assert.equal(actionOf('psscriptanalyzer'), null, 'nothing to install into without a PowerShell host');
    assert.equal(actionOf('ruff').textContent, 'Install');
    assert.equal(actionOf('shellcheck').textContent, 'Install');

    await act(async () => {
      actionOf('ruff').click();
    });
    assert.deepEqual(runs.at(-1), ['installBuiltinFeature', ['tidy', { engines: ['ruff'] }]]);
    await act(async () => {
      installDeferred.resolve();
    });

    // The failure and its reason stay on the row, and the control becomes Retry.
    const ruffRow = dialog.querySelector('[data-tidy-engine="ruff"]');
    assert.equal(ruffRow.querySelector('.extensions-item-badge').textContent, 'Failed');
    assert.match(ruffRow.textContent, /HTTP 503/);
    assert.equal(actionOf('ruff').textContent, 'Retry');
    assert.equal(actionOf('shellcheck').textContent, 'Install');
  } finally {
    await rendered.cleanup();
  }
});
