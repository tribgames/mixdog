import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement'],
  actEnvironment: false,
});
globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { CategoryPanel } = await import('./capability-panels.tsx');
const { SettingsConfirmDialog } = await import('./capability-controls.tsx');

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const servers = [
  { name: 'rea', enabled: true, status: 'connected', connected: true, transport: 'stdio', source: 'config' },
  { name: 'webdocs', enabled: true, status: 'failed', transport: 'http', source: 'config' },
];

async function mount(element, host = document.body.appendChild(document.createElement('main'))) {
  const root = createRoot(host);
  await act(async () => root.render(element));
  return {
    host,
    root,
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function skillsPanel({ run, confirm, mcpServers = servers }) {
  return React.createElement(CategoryPanel, {
    category: 'skills',
    context: {
      api: {},
      data: {
        skills: { skills: [] },
        disabledSkills: { disabled: [] },
        mcp: { servers: mcpServers },
        __loadedSections: ['skills', 'mcp'],
      },
      snapshot: null,
      pending: '',
      run,
      async route() {},
      async setFast() {},
      confirm,
      notice() {},
      updaterState: { status: 'disabled' },
      async checkDesktopUpdate() {},
      async installDesktopUpdate() {},
    },
  });
}

const rowNames = () =>
  [...document.querySelectorAll('[data-extension-row]')].map((row) => row.getAttribute('data-extension-row'));

async function removeFromMenu(name) {
  const row = document.querySelector(`[data-extension-row="${name}"]`);
  await act(async () => {
    row.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    );
  });
  await act(async () => {
    document.querySelector('[role="menu"] [data-action-id="remove"]').click();
    // The menu defers the confirmation until it has closed.
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

test('a sidebar confirmation renders outside its host so the sidebar cannot clip it', async () => {
  const sidebar = document.body.appendChild(document.createElement('aside'));
  let closed = 0;
  const view = await mount(
    React.createElement(SettingsConfirmDialog, {
      options: {
        title: 'Remove MCP server?',
        description: 'rea',
        confirmLabel: 'Remove',
        danger: true,
        onConfirm() {},
      },
      onClose: () => {
        closed += 1;
      },
      portal: true,
    }),
    sidebar
  );
  try {
    const layer = document.querySelector('.settings-confirm-layer');
    assert.ok(layer);
    assert.equal(layer.parentElement, document.body);
    assert.equal(sidebar.querySelector('.settings-confirm-layer'), null);
    await act(async () => {
      document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(closed, 1, 'Escape dismisses a confirmation that no settings dialog owns');
  } finally {
    await view.cleanup();
    sidebar.remove();
  }
});

test('removing an MCP server from the row menu hides its row at once and calls removeMcpServer', async () => {
  const calls = [];
  const removal = deferred();
  let confirmation = null;
  const view = await mount(
    skillsPanel({
      run: async (capability, args) => {
        calls.push([capability, args]);
        if (capability === 'removeMcpServer') return removal.promise;
        return undefined;
      },
      confirm: (options) => {
        confirmation = options;
      },
    })
  );
  try {
    assert.deepEqual(rowNames(), ['rea', 'webdocs']);
    await removeFromMenu('rea');
    assert.ok(confirmation, 'the menu opens the confirmation');
    assert.equal(confirmation.danger, true);
    await act(async () => {
      void confirmation.onConfirm();
    });
    assert.deepEqual(calls, [['removeMcpServer', ['rea']]]);
    assert.deepEqual(rowNames(), ['webdocs'], 'the row leaves before the settings re-read lands');
    await act(async () => {
      removal.resolve({ servers: [servers[1]] });
      await removal.promise;
    });
    assert.deepEqual(rowNames(), ['webdocs']);
    // The re-read no longer lists it; a later server with that name shows again.
    await act(async () =>
      view.root.render(skillsPanel({ run: async () => undefined, confirm() {}, mcpServers: [servers[1]] }))
    );
    await act(async () =>
      view.root.render(skillsPanel({ run: async () => undefined, confirm() {}, mcpServers: servers }))
    );
    assert.deepEqual(rowNames(), ['rea', 'webdocs']);
  } finally {
    await view.cleanup();
  }
});

const noopPanel = (mcpServers) => skillsPanel({ run: async () => undefined, confirm() {}, mcpServers });

for (const refreshBeforeReturn of [false, true]) {
  test(`a server recreated between snapshots shows again (refresh before return: ${refreshBeforeReturn})`, async () => {
    const removal = deferred();
    let confirmation = null;
    const view = await mount(
      skillsPanel({
        run: async (capability) => (capability === 'removeMcpServer' ? removal.promise : undefined),
        confirm: (options) => {
          confirmation = options;
        },
      })
    );
    try {
      await removeFromMenu('rea');
      let settled;
      await act(async () => {
        settled = confirmation.onConfirm();
      });
      if (refreshBeforeReturn) {
        // The post-write section read lands while the call is still pending.
        await act(async () => view.root.render(noopPanel([servers[1]])));
        assert.deepEqual(rowNames(), ['webdocs']);
      }
      await act(async () => {
        removal.resolve({ servers: [servers[1]] });
        await settled;
      });
      assert.deepEqual(rowNames(), ['webdocs']);
      // Recreated (e.g. by the setup tool): the next snapshot lists it again.
      await act(async () => view.root.render(noopPanel(servers)));
      assert.deepEqual(rowNames(), ['rea', 'webdocs']);
    } finally {
      await view.cleanup();
    }
  });
}

test('a failed refresh after a successful removal does not hide a later authoritative server', async () => {
  const removal = deferred();
  let confirmation = null;
  const view = await mount(
    skillsPanel({
      run: async (capability) => (capability === 'removeMcpServer' ? removal.promise : undefined),
      confirm: (options) => {
        confirmation = options;
      },
    })
  );
  try {
    await removeFromMenu('rea');
    let settled;
    await act(async () => {
      settled = confirmation.onConfirm();
    });
    // A stale sweep that predates the write still lists it: the in-flight
    // removal keeps the row hidden.
    await act(async () => view.root.render(noopPanel(servers)));
    assert.deepEqual(rowNames(), ['webdocs']);
    // The removal succeeds but its refresh fails: no new snapshot arrives.
    await act(async () => {
      removal.resolve({});
      await settled;
    });
    assert.deepEqual(rowNames(), ['webdocs']);
    // The next authoritative snapshot lists the server, so it shows.
    await act(async () => view.root.render(noopPanel(servers)));
    assert.deepEqual(rowNames(), ['rea', 'webdocs']);
  } finally {
    await view.cleanup();
  }
});

test('a failed MCP removal brings the row back', async () => {
  let confirmation = null;
  const view = await mount(
    skillsPanel({
      // run() reports the error itself and resolves undefined.
      run: async () => undefined,
      confirm: (options) => {
        confirmation = options;
      },
    })
  );
  try {
    await removeFromMenu('rea');
    await act(async () => {
      await confirmation.onConfirm();
    });
    assert.deepEqual(rowNames(), ['rea', 'webdocs']);
  } finally {
    await view.cleanup();
  }
});
