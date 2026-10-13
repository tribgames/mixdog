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

test('joinHostPath keeps the base separator style', () => {
  assert.equal(joinHostPath('/home/me', 'app'), '/home/me/app');
  assert.equal(joinHostPath('/', 'etc'), '/etc');
  assert.equal(joinHostPath('C:\\Users', 'me'), 'C:\\Users\\me');
  assert.equal(joinHostPath('C:\\', 'Users'), 'C:\\Users');
});
