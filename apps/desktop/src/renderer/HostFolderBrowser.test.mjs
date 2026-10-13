import assert from 'node:assert/strict';
import test from 'node:test';
import { joinHostPath, parentHostPath } from './HostFolderBrowser.tsx';

test('parentHostPath walks up POSIX and Windows paths and stops at roots', () => {
  assert.equal(parentHostPath('/home/me/app'), '/home/me');
  assert.equal(parentHostPath('/home'), '/');
  assert.equal(parentHostPath('/'), null);
  assert.equal(parentHostPath('C:\\Users\\me\\app'), 'C:\\Users\\me');
  assert.equal(parentHostPath('C:\\Users'), 'C:\\');
  assert.equal(parentHostPath('C:\\'), null);
});

test('HostFolderBrowser still lets a typed folder be selected when listing is refused (no project yet)', async () => {
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { dom } = installTestDom(null, {
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event'],
  });
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { HostFolderBrowser } = await import('./HostFolderBrowser.tsx');
  window.mixdogDesktop = {
    listProjectDir: async () => {
      throw new Error('Project is not available.');
    },
  };
  const picked = [];
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(HostFolderBrowser, { startPath: '/home/me', onSelect: (p) => picked.push(p), onCancel() {} })
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.ok(dom.window.document.querySelector('[role="alert"]'));
  const select = [...dom.window.document.querySelectorAll('button')].find(
    (b) => b.textContent === 'Select this folder'
  );
  assert.equal(select.disabled, false);
  await act(async () => select.click());
  assert.deepEqual(picked, ['/home/me']);
  await act(async () => root.unmount());
});

test('HostFolderBrowser lists through listHostDirectories with no project and selects the canonical host path', async () => {
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { dom } = installTestDom(null, {
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event'],
  });
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { HostFolderBrowser } = await import('./HostFolderBrowser.tsx');
  const asked = [];
  window.mixdogDesktop = {
    listProjectDir: async () => {
      throw new Error('Project is not available.');
    },
    listHostDirectories: async (path) => {
      asked.push(path);
      return path === ''
        ? { path: '/home/me', folders: ['code'], truncated: false }
        : { path, folders: [], truncated: false };
    },
  };
  const picked = [];
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(HostFolderBrowser, { startPath: '', onSelect: (p) => picked.push(p), onCancel() {} })
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.deepEqual(asked, ['']);
  assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
  const folder = [...dom.window.document.querySelectorAll('.host-folder-list button')][0];
  assert.match(folder.textContent, /code/);
  await act(async () => folder.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.deepEqual(asked, ['', '/home/me/code']);
  const select = [...dom.window.document.querySelectorAll('button')].find(
    (b) => b.textContent === 'Select this folder'
  );
  await act(async () => select.click());
  assert.deepEqual(picked, ['/home/me/code']);
  await act(async () => root.unmount());
});

test('phone layout: the host browser and the selected path fit the add dialog field', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./desktop/20-automation.css', import.meta.url), 'utf8');
  const rule = (selector) => {
    const escaped = selector.replace(/[.>*[\]]/g, '\\$&');
    const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
    assert.ok(match, `rule ${selector}`);
    return match[1];
  };
  // The field's implicit grid track must not grow to its widest child.
  assert.match(rule('.projects-add-dialog .schedules-field'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  for (const selector of ['.projects-folder-row', '.host-folder-browser', '.host-folder-list li']) {
    assert.match(rule(selector), /min-width:\s*0/, `${selector} may shrink below its content`);
  }
  assert.match(rule('.host-folder-browser .projects-folder-row input'), /min-width:\s*0/);
  assert.match(rule('.projects-folder-row > button'), /flex:\s*none/, 'Browse/Up/Select keep their own width');
  // The chosen path truncates with an ellipsis at its start, keeping its end readable.
  const path = rule('.projects-folder-row code');
  assert.match(path, /display:\s*block/);
  assert.match(path, /direction:\s*rtl/);
  assert.match(path, /text-overflow:\s*ellipsis/);
  assert.match(path, /overflow:\s*hidden/);
  const source = readFileSync(new URL('./ProjectAddDialogHost.tsx', import.meta.url), 'utf8');
  assert.match(source, /<code>\s*<bdi>\{addPath \|\| t\('No folder selected'\)\}<\/bdi>\s*<\/code>/);
});

test('joinHostPath keeps the base separator style', () => {
  assert.equal(joinHostPath('/home/me', 'app'), '/home/me/app');
  assert.equal(joinHostPath('/', 'etc'), '/etc');
  assert.equal(joinHostPath('C:\\Users', 'me'), 'C:\\Users\\me');
  assert.equal(joinHostPath('C:\\', 'Users'), 'C:\\Users');
});
