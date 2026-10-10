import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { useComposerAttachments } from './use-composer-attachments.ts';
import { localFilesFromPaths, MIXDOG_ABSOLUTE_PATHS_MIME, MIXDOG_PROJECT_PATHS_MIME } from './file-drag.ts';
import {
  MAX_COMPOSER_ATTACHMENTS,
  MAX_INLINE_FILE_BASE64_TOTAL,
  MAX_INLINE_FILE_BYTES,
  MAX_INLINE_TEXT_TOTAL,
  MAX_OFFICE_FILE_BYTES,
  MAX_PDF_FILE_BYTES,
} from './composer-support.tsx';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
const previous = new Map(
  ['window', 'document', 'navigator', 'FileReader', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ])
);
Object.defineProperty(dom.window.navigator, 'userAgent', { value: 'Electron' });
dom.window.HTMLElement.prototype.attachEvent = () => {};
dom.window.HTMLElement.prototype.detachEvent = () => {};
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  FileReader: {
    configurable: true,
    value: class {
      readAsDataURL(blob) {
        void blob.arrayBuffer().then(
          (buffer) => {
            this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
            this.onload?.();
          },
          () => this.onerror?.()
        );
      }
    },
  },
});
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

async function mountComposer(t, { api = {}, draft: initialDraft = '' } = {}) {
  window.mixdogDesktop = api;
  let current;
  function Harness() {
    const [draft, setDraft] = useState(initialDraft);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    const historyNavigation = useRef({ index: 2, seed: 'history' });
    const transitioningRef = useRef(false);
    const dropTargetRef = useRef(null);
    current = {
      draft,
      draftRef,
      textarea,
      historyNavigation,
      transitioningRef,
      ...useComposerAttachments({
        draftRef,
        setDraft,
        textarea,
        historyNavigation,
        transitioningRef,
        projectScope: 'C:/Project/demo',
        recoveryScope: 'attachment-fallback',
        submissionRecoveryVersion: 0,
        dropTargetRef,
      }),
    };
    return React.createElement(
      'div',
      { ref: dropTargetRef },
      React.createElement('textarea', { ref: textarea, value: draft, readOnly: true })
    );
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return {
    get current() {
      return current;
    },
    attach: (files, sourcePaths) => act(async () => current.attachFiles(files, sourcePaths)),
    async drop(dataTransfer) {
      const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      await act(async () => {
        host.firstChild.dispatchEvent(event);
        await setImmediate();
      });
      assert.equal(event.defaultPrevented, true);
    },
  };
}

function pathTransfer(paths, projectPath) {
  const mime = projectPath ? MIXDOG_PROJECT_PATHS_MIME : MIXDOG_ABSOLUTE_PATHS_MIME;
  const value = projectPath ? { projectPath, paths } : paths;
  return { types: [mime], getData: (type) => (type === mime ? JSON.stringify(value) : '') };
}

function localApi(paths, readLocalFile) {
  return {
    folderPathForFile: () => '',
    resolveLocalPaths: async () => paths.map((absolutePath) => ({ absolutePath, dir: false })),
    readLocalFile,
  };
}

test('unsupported native selections insert their real quoted path at the selection', async (t) => {
  const file = new File(['<svg/>'], 'pelican_bicycle.svg', { type: 'image/svg+xml' });
  const path = 'C:\\Project\\my art\\pelican_bicycle.svg';
  const harness = await mountComposer(t, {
    api: { folderPathForFile: (selected) => (selected === file ? path : '') },
    draft: 'review old please',
  });
  harness.current.textarea.current.setSelectionRange(7, 10);
  await harness.attach([file]);
  assert.equal(harness.current.draft, `review "${path}"  please`);
  assert.equal(harness.current.draftRef.current, harness.current.draft);
  assert.deepEqual(harness.current.historyNavigation.current, { index: -1, seed: '' });
  assert.equal(harness.current.attachments.length, 0);
  assert.equal(
    harness.current.attachmentError,
    "pelican_bicycle.svg: this file type can't be attached; its path was inserted so the AI can open it."
  );
});

test('native file-item drops fall back without needing a Files transfer entry', async (t) => {
  const file = new File(['<svg/>'], 'pelican.svg', { type: 'image/svg+xml' });
  const path = 'C:/art/pelican.svg';
  const harness = await mountComposer(t, { api: { folderPathForFile: () => path } });
  await harness.drop({
    types: ['image/svg+xml'],
    items: [{ kind: 'file', getAsFile: () => file }],
    files: [],
  });
  assert.equal(harness.current.draft, `${path} `);
  assert.equal(harness.current.attachments.length, 0);
  assert.match(
    harness.current.attachmentError,
    /pelican\.svg: this file type can't be attached; its path was inserted/
  );
});

test('native directories insert only their path without reading or attaching them', async (t) => {
  const folder = new File([], 'folder.png', { type: 'image/png' });
  const path = 'C:/my folders/folder.png';
  const harness = await mountComposer(t, { api: { folderPathForFile: () => path } });
  await harness.drop({
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) }],
    files: [folder],
  });
  assert.equal(harness.current.draft, `"${path}" `);
  assert.equal(harness.current.attachments.length, 0);
  assert.equal(harness.current.attachmentError, '');
});

test('internal directory drops clear an earlier error and insert only the path', async (t) => {
  const path = 'C:/folders/art';
  const harness = await mountComposer(t, {
    api: {
      resolveLocalPaths: async () => [{ absolutePath: path, dir: true }],
      readLocalFile: async () => assert.fail('directories must not be read'),
    },
  });
  await harness.attach([new File(['<svg/>'], 'missing.svg', { type: 'image/svg+xml' })]);
  assert.match(harness.current.attachmentError, /missing\.svg: this file type can't be attached\./);
  assert.doesNotMatch(harness.current.attachmentError, /path was inserted|unavailable/);
  await harness.drop(pathTransfer([path]));
  assert.equal(harness.current.draft, `${path} `);
  assert.equal(harness.current.attachments.length, 0);
  assert.equal(harness.current.attachmentError, '');
});

test('mixed files retain successful image, PDF and text attachments and every rejected path', async (t) => {
  const files = [
    new File(['png'], 'photo.png', { type: 'image/png' }),
    new File(['<svg/>'], 'vector.svg', { type: 'image/svg+xml' }),
    new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' }),
    new File([new Uint8Array([0, 1, 2])], 'data.bin', { type: 'application/octet-stream' }),
    new File(['notes'], 'notes.txt', { type: 'text/plain' }),
  ];
  const harness = await mountComposer(t, {
    api: { folderPathForFile: (file) => `C:/files/${file.name}` },
  });
  await harness.attach(files);
  assert.deepEqual(
    harness.current.attachments.map(({ name, kind, data }) => ({ name, kind, data })),
    [
      { name: 'photo.png', kind: 'image', data: Buffer.from('png').toString('base64') },
      { name: 'report.pdf', kind: 'pdf', data: Buffer.from('%PDF-1.4').toString('base64') },
      { name: 'notes.txt', kind: 'text', data: 'notes' },
    ]
  );
  assert.equal(harness.current.draft.match(/C:\/files\/vector\.svg/g)?.length, 1);
  assert.equal(harness.current.draft.match(/C:\/files\/data\.bin/g)?.length, 1);
  assert.doesNotMatch(harness.current.draft, /C:\/files\/(?:photo\.png|report\.pdf|notes\.txt)/);
  assert.match(harness.current.attachmentError, /vector\.svg: this file type can't be attached; its path was inserted/);
  assert.match(harness.current.attachmentError, /data\.bin: this file type can't be attached; its path was inserted/);
});

test('files without an accessible local path show the limitation without inventing a path', async (t) => {
  const harness = await mountComposer(t, { draft: 'keep this' });
  await harness.attach([new File(['<svg/>'], 'pelican.svg', { type: 'image/svg+xml' })]);
  assert.equal(harness.current.draft, 'keep this');
  assert.equal(harness.current.attachments.length, 0);
  assert.equal(harness.current.attachmentError, "pelican.svg: this file type can't be attached.");
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSM_MIME = 'application/vnd.ms-excel.sheet.macroEnabled.12';

test('Office files attach as file attachments with OOXML MIME types and [File #n] tokens', async (t) => {
  const harness = await mountComposer(t);
  await harness.attach([
    new File(['PK'], 'brief.docx', { type: '' }),
    new File(['PK'], 'macro.xlsm', { type: 'application/octet-stream' }),
  ]);
  assert.deepEqual(
    harness.current.attachments.map(({ name, kind, mimeType, token }) => ({ name, kind, mimeType, token })),
    [
      { name: 'brief.docx', kind: 'office', mimeType: DOCX_MIME, token: '[File #1: brief.docx]' },
      { name: 'macro.xlsm', kind: 'office', mimeType: XLSM_MIME, token: '[File #2: macro.xlsm]' },
    ]
  );
  assert.ok(harness.current.draft.includes('[File #1: brief.docx]'));
  assert.ok(harness.current.draft.includes('[File #2: macro.xlsm]'));
  assert.equal(harness.current.attachmentError, '');
});

test('an empty or octet-stream File.type is inferred from the extension and the filename is kept', async (t) => {
  const harness = await mountComposer(t);
  await harness.attach([
    new File(['PK'], 'Q3 plan.pptx', { type: 'application/octet-stream' }),
    new File(['%PDF-1.7'], 'scan.PDF', { type: '' }),
    new File(['hello'], 'readme.md', { type: 'application/octet-stream' }),
  ]);
  assert.deepEqual(
    harness.current.attachments.map(({ name, kind, mimeType }) => ({ name, kind, mimeType })),
    [
      {
        name: 'Q3 plan.pptx',
        kind: 'office',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
      { name: 'scan.PDF', kind: 'pdf', mimeType: 'application/pdf' },
      { name: 'readme.md', kind: 'text', mimeType: 'text/plain' },
    ]
  );
});

test('Office files count toward the attachment limit and the combined file budget', async (t) => {
  const harness = await mountComposer(t, { api: { folderPathForFile: (file) => `C:/o/${file.name}` } });
  await act(async () =>
    harness.current.replaceAttachments([
      {
        id: 1,
        name: 'big.pdf',
        kind: 'pdf',
        mimeType: 'application/pdf',
        data: 'A'.repeat(MAX_INLINE_FILE_BASE64_TOTAL),
        token: '',
      },
    ])
  );
  await harness.attach([new File(['PK'], 'more.pptx')]);
  assert.equal(harness.current.attachments.length, 1);
  assert.match(harness.current.attachmentError, /too large together/);
  assert.match(harness.current.draft, /C:\/o\/more\.pptx/);

  await act(async () =>
    harness.current.replaceAttachments(
      Array.from({ length: MAX_COMPOSER_ATTACHMENTS }, (_, index) => ({
        id: index + 1,
        name: `${index}.docx`,
        kind: 'office',
        mimeType: DOCX_MIME,
        data: 'UEs=',
        token: '',
      }))
    )
  );
  await harness.attach([new File(['PK'], 'extra.docx')]);
  assert.equal(harness.current.attachments.length, MAX_COMPOSER_ATTACHMENTS);
  assert.match(harness.current.attachmentError, /Attach up to 8 items/);
});

test('Office size cap, legacy formats, empty files and fake PDFs get clear rejections', async (t) => {
  const harness = await mountComposer(t, { api: { folderPathForFile: (file) => `C:/r/${file.name}` } });
  const cases = [
    [
      { name: 'huge.docx', type: '', size: MAX_OFFICE_FILE_BYTES + 1 },
      /huge\.docx: Office files must be under 20 MB/,
      true,
    ],
    [new File(['x'], 'old.doc'), /old\.doc: legacy Office files can't be attached\. Save it as \.docx/, false],
    [new File(['x'], 'sheet.xls'), /sheet\.xls: legacy Office files can't be attached\. Save it as \.xlsx/, false],
    [new File(['x'], 'deck.ppt'), /deck\.ppt: legacy Office files can't be attached\. Save it as \.pptx/, false],
    [new File([], 'empty.txt', { type: 'text/plain' }), /empty\.txt: the file is empty\./, false],
    [new File([], 'empty.docx'), /empty\.docx: the file is empty\./, false],
    [new File(['<html>'], 'fake.pdf', { type: 'application/pdf' }), /fake\.pdf: this file is not a valid PDF\./, true],
  ];
  for (const [file, message, keepsPath] of cases) {
    const before = harness.current.draft;
    await harness.attach([file]);
    assert.equal(harness.current.attachments.length, 0);
    assert.match(harness.current.attachmentError, message);
    assert.equal(harness.current.draft !== before, keepsPath, file.name);
  }
});

test('oversized files fall back before reading their contents', async (t) => {
  const harness = await mountComposer(t, {
    api: { folderPathForFile: (file) => `C:/large/${file.name}` },
  });
  await harness.attach([
    { name: 'large.png', type: 'image/png', size: 12_000_001 },
    { name: 'large.pdf', type: 'application/pdf', size: MAX_PDF_FILE_BYTES + 1 },
    { name: 'large.txt', type: 'text/plain', size: MAX_INLINE_FILE_BYTES + 1 },
  ]);
  assert.equal(harness.current.draft, 'C:/large/large.png C:/large/large.pdf C:/large/large.txt ');
  assert.equal(harness.current.attachments.length, 0);
});

test('image processing failures preserve both the source path and the failure', async (t) => {
  const harness = await mountComposer(t, {
    api: {
      folderPathForFile: () => 'C:/broken.png',
      invokeCapability: async () => {
        throw new Error('image decoding failed');
      },
    },
  });
  await harness.attach([new File(['bad'], 'broken.png', { type: 'image/png' })]);
  assert.equal(harness.current.draft, 'C:/broken.png ');
  assert.match(harness.current.attachmentError, /image decoding failed/);
});

test('attachment count overflow preserves every remaining file as a path', async (t) => {
  const harness = await mountComposer(t, {
    api: { folderPathForFile: (file) => `C:/files/${file.name}` },
  });
  const files = Array.from(
    { length: MAX_COMPOSER_ATTACHMENTS + 2 },
    (_, index) => new File(['notes'], `${index}.txt`, { type: 'text/plain' })
  );
  await harness.attach(files);
  assert.equal(harness.current.attachments.length, MAX_COMPOSER_ATTACHMENTS);
  for (const file of files.slice(MAX_COMPOSER_ATTACHMENTS)) {
    assert.ok(harness.current.draft.includes(`C:/files/${file.name}`));
  }
  await harness.attach([new File(['<svg/>'], 'extra.svg', { type: 'image/svg+xml' })]);
  assert.ok(harness.current.draft.includes('C:/files/extra.svg'));
  assert.equal(harness.current.attachments.length, MAX_COMPOSER_ATTACHMENTS);
});

test('aggregate attachment budget rejection also falls back to the path', async (t) => {
  const harness = await mountComposer(t, { api: { folderPathForFile: () => '/tmp/notes.txt' } });
  await act(async () =>
    harness.current.replaceAttachments([
      { id: 1, name: 'existing', kind: 'text', data: 'x'.repeat(MAX_INLINE_TEXT_TOTAL), token: '' },
    ])
  );
  await harness.attach([new File(['more'], 'notes.txt', { type: 'text/plain' })]);
  assert.equal(harness.current.draft, '/tmp/notes.txt ');
  assert.equal(harness.current.attachments.length, 1);
  assert.match(harness.current.attachmentError, /Inline text attachments are too large together/);
});

test('internal absolute drops preserve source paths even for files with identical names', async (t) => {
  const paths = ['C:/first/pelican.svg', 'D:/second/pelican.svg'];
  const harness = await mountComposer(t, {
    api: localApi(paths, async () => ({
      name: 'pelican.svg',
      mimeType: 'image/svg+xml',
      data: Buffer.from('<svg/>').toString('base64'),
    })),
  });
  await harness.drop(pathTransfer(paths));
  assert.equal(harness.current.draft, `${paths.join(' ')} `);
  assert.equal(harness.current.attachments.length, 0);
  assert.match(
    harness.current.attachmentError,
    /pelican\.svg: this file type can't be attached; its path was inserted/
  );
});

test('project SVG drops retain their existing project mention behavior', async (t) => {
  const harness = await mountComposer(t);
  await harness.drop(pathTransfer(['art/pelican.svg'], 'C:/Project/demo'));
  assert.equal(harness.current.draft, '@art/pelican.svg ');
  assert.equal(harness.current.attachmentError, '');
});

test('read failures preserve the path without losing the original error', async (t) => {
  const paths = ['C:/unreadable.svg'];
  const harness = await mountComposer(t, {
    api: localApi(paths, async () => {
      throw new Error('Permission denied');
    }),
  });
  await harness.drop(pathTransfer(paths));
  assert.equal(harness.current.draft, 'C:/unreadable.svg ');
  assert.match(harness.current.attachmentError, /Permission denied/);
});

test('path resolution failures retain the supplied paths and error', async (t) => {
  const paths = ['C:/unresolved.svg'];
  const harness = await mountComposer(t, {
    api: {
      ...localApi(paths, async () => assert.fail('must not read after resolution fails')),
      resolveLocalPaths: async () => {
        throw new Error('Path resolution failed');
      },
    },
  });
  await harness.drop(pathTransfer(paths));
  assert.equal(harness.current.draft, 'C:/unresolved.svg ');
  assert.match(harness.current.attachmentError, /Path resolution failed/);
});

test('materialization retains exact source identity and paths beyond its read limit', async () => {
  const paths = ['C:/first/file.svg', 'C:/second/file.svg'];
  const api = localApi(paths, async () => ({
    name: 'file.svg',
    mimeType: 'image/svg+xml',
    data: Buffer.from('<svg/>').toString('base64'),
  }));
  const loaded = await localFilesFromPaths(api, paths, 1);
  assert.equal(loaded.files.length, 1);
  assert.equal(loaded.sourcePaths.get(loaded.files[0]), paths[0]);
  assert.deepEqual(loaded.unattachedPaths, [paths[1]]);
  assert.deepEqual(loaded.errors, []);
});

test('cancelled ingestion does not insert fallback paths into a transitioning draft', async (t) => {
  let harness;
  harness = await mountComposer(t, {
    draft: 'unchanged',
    api: {
      folderPathForFile: () => 'C:/cancelled.png',
      invokeCapability: async () => {
        harness.current.transitioningRef.current = true;
        throw new Error('read interrupted');
      },
    },
  });
  await harness.attach([new File(['png'], 'cancelled.png', { type: 'image/png' })]);
  assert.equal(harness.current.draft, 'unchanged');
  assert.equal(harness.current.attachments.length, 0);
  assert.equal(harness.current.attachmentError, '');
});
