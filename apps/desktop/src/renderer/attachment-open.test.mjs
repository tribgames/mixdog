// Opening and saving a sent attachment by id: the desktop reads the host's
// stored file and opens it in the side panel (never the OS viewer, never a
// blob tab); a paired device opens the same file through the remote preview
// grant and downloads it through the download grant.
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './test-support/test-dom.mjs';

const stored = { sessionId: 's1', id: 'b'.repeat(64) };
const source = { kind: 'pdf', name: 'spec.pdf', stored };

async function setup(t, { remote = false, api = {} } = {}) {
  const { window } = installTestDom(t, { globals: { navigator: { userAgent: 'Mozilla/5.0' } } });
  if (remote) window.mixdogRemoteServer = 'wss://relay.example';
  const calls = [];
  window.mixdogDesktop = {
    openAttachmentImage: async () => void calls.push(['openAttachmentImage']),
    openAttachmentFile: async () => void calls.push(['openAttachmentFile']),
    openFilePath: async () => void calls.push(['openFilePath']),
    saveFileAs: async (...args) => void calls.push(['saveFileAs', ...args]),
    ...api(calls),
  };
  const { openAttachmentSource, desktopAttachmentActions } = await import('./attachment-context-menu.tsx');
  return { calls, openAttachmentSource, desktopAttachmentActions, window };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('desktop: a previewable attachment opens the host file in the side panel', async (t) => {
  const { calls, openAttachmentSource } = await setup(t, {
    api: (log) => ({
      readSessionAttachment: async (...args) => {
        log.push(['readSessionAttachment', ...args]);
        return { name: 'spec.pdf', mimeType: 'application/pdf', size: 3, dataUrl: 'data:application/pdf;base64,AAAA' };
      },
      stageAttachmentFile: async (dataUrl, name) => {
        log.push(['stage', dataUrl, name]);
        return { projectPath: '/tmp/mixdog-attachments', relPath: 'x-spec.pdf', accessToken: 'tok' };
      },
    }),
  });
  const opened = [];
  openAttachmentSource(source, (...args) => opened.push(args));
  await settle();
  assert.deepEqual(opened, [['/tmp/mixdog-attachments', 'x-spec.pdf', undefined, 'tok']]);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['readSessionAttachment', 'stage'],
    'neither the OS viewer nor the OS app was involved'
  );
  assert.deepEqual(calls[0], ['readSessionAttachment', 's1', stored.id]);
});

test('desktop: a type the app cannot preview keeps the default app', async (t) => {
  const { calls, openAttachmentSource } = await setup(t, {
    api: (log) => ({
      readSessionAttachment: async () => ({
        name: 'bundle.zip',
        mimeType: 'application/zip',
        size: 3,
        dataUrl: 'data:application/zip;base64,AAAA',
      }),
    }),
  });
  openAttachmentSource({ kind: 'office', name: 'bundle.zip', stored }, () => {});
  await settle();
  assert.deepEqual(
    calls.map(([name]) => name),
    ['openAttachmentFile']
  );
});

test('remote: the same file opens through the session-scoped preview grant, not bytes over RPC', async (t) => {
  const { calls, openAttachmentSource } = await setup(t, {
    remote: true,
    api: (log) => ({
      openSessionAttachment: async (...args) => {
        log.push(['openSessionAttachment', ...args]);
        return { projectPath: '/tmp/mixdog-attachments', relPath: 'x-spec.pdf', accessToken: 'grant-1' };
      },
    }),
  });
  const opened = [];
  openAttachmentSource(source, (...args) => opened.push(args));
  await settle();
  assert.deepEqual(opened, [['/tmp/mixdog-attachments', 'x-spec.pdf', undefined, 'grant-1']]);
  assert.deepEqual(calls, [['openSessionAttachment', 's1', stored.id]]);
});

test('remote: a type the app cannot preview is Download / Share through the download grant, never the OS', async (t) => {
  const { calls, openAttachmentSource } = await setup(t, { remote: true, api: () => ({}) });
  // The only item for it is the save one (which starts a download row).
  const { attachmentMenuItems } = await import('./attachment-menu.ts');
  const labels = attachmentMenuItems(
    { kind: 'office', name: 'bundle.zip', stored },
    { deviceSave: true, saveStored: async () => {} }
  ).map((item) => item.label);
  assert.deepEqual(labels, ['Download / Share']);
  openAttachmentSource({ kind: 'office', name: 'bundle.zip', stored }, () => {});
  await settle();
  assert.equal(
    calls.some(([name]) => name === 'openAttachmentFile' || name === 'openFilePath'),
    false
  );
});

test('desktop save asks the save dialog with the host file; a legacy chip with no stored file does nothing', async (t) => {
  const { calls, openAttachmentSource, desktopAttachmentActions } = await setup(t, {
    api: () => ({
      readSessionAttachment: async () => ({
        name: 'spec.pdf',
        mimeType: 'application/pdf',
        size: 3,
        dataUrl: 'data:application/pdf;base64,AAAA',
      }),
    }),
  });
  await desktopAttachmentActions().saveStored(stored, 'spec.pdf');
  assert.deepEqual(calls.at(-1), ['saveFileAs', 'data:application/pdf;base64,AAAA', 'spec.pdf']);
  calls.length = 0;
  // A chip with no stored file and no bytes has nothing to open: no error.
  openAttachmentSource({ kind: 'pdf', name: 'old.pdf' }, () => {});
  await settle();
  assert.deepEqual(calls, []);
});
