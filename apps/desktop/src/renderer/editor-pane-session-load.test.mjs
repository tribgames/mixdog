import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event', 'Node', 'Element'],
  actEnvironment: false,
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { useEditorSessionLoad } = await import('./editor-pane-session-load.ts');
const { notifyMediaSessionChanged } = await import('./remote-file-preview.ts');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('a media-session change refreshes an SVG preview URL without touching its unsaved source', async (t) => {
  let session = 1;
  let reads = 0;
  const api = {
    readProjectFile: async () => {
      reads += 1;
      return { content: '<svg>disk</svg>', mtimeMs: 1, binary: false, tooLarge: false, encoding: 'utf8' };
    },
    previewProjectFile: async () => ({
      url: `https://host.test/m?sid=${session}`,
      kind: 'image',
      mime: 'image/svg+xml',
      mtimeMs: 1,
      size: 1,
    }),
  };
  const model = { value: '<svg>disk</svg>', setValue(v) { this.value = v; }, getValue() { return this.value; } };
  const ref = (current) => ({ current });
  let dirty = false;
  let previewState = null;
  const noop = () => undefined;
  const stable = { notifyReady: noop, readModel: () => model, markDirty: (d) => { dirty = d; }, deleteBackup: async () => undefined, resetDocument: () => 0, setError: noop, setSaveError: noop, setRevertError: noop, setPreviewLoaded: noop, setPreviewError: noop, setRecovery: noop, setDiskChanged: noop, setContentRevision: noop, setDocumentPreview: noop, setDocumentError: noop };
  function Probe() {
    const [preview, setPreview] = React.useState(null);
    previewState = preview;
    const [load, setLoad] = React.useState(null);
    const refs = React.useRef({ loaded: ref(false), readOnly: ref(false), mtime: ref(0), disk: ref(''), text: ref(''), generation: ref(0) });
    useEditorSessionLoad({
      ...stable,
      api,
      projectPath: '/p',
      relPath: 'a.svg',
      loadedRef: refs.current.loaded,
      readOnlyRef: refs.current.readOnly,
      savedMtime: refs.current.mtime,
      savedDiskText: refs.current.disk,
      savedText: refs.current.text,
      documentGeneration: refs.current.generation,
      load,
      preview,
      documentPreview: null,
      error: '',
      setLoad,
      setPreview,
    });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  t.after(async () => { await act(async () => root.unmount()); });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  await act(async () => root.render(React.createElement(Probe)));
  await settle();
  assert.equal(previewState.url, 'https://host.test/m?sid=1');
  model.value = '<svg>unsaved</svg>';
  dirty = true;
  const readsBefore = reads;
  session = 2;
  await act(async () => notifyMediaSessionChanged());
  await settle();
  assert.equal(previewState.url, 'https://host.test/m?sid=2');
  assert.equal(model.value, '<svg>unsaved</svg>');
  assert.equal(dirty, true);
  assert.equal(reads, readsBefore, 'the source is not read again');
});

