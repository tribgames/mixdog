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
const { _runIdleReclaimForTest } = await import('./idle-reclaim.ts');
const { enforceRendererCacheBudget, totalBudgetedChars } = await import('./renderer-cache-budget.ts');
const { createRemotePreviewApi, notifyMediaSessionChanged } = await import('./remote-file-preview.ts');
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
  const model = {
    value: '<svg>disk</svg>',
    setValue(v) {
      this.value = v;
    },
    getValue() {
      return this.value;
    },
  };
  const ref = (current) => ({ current });
  let dirty = false;
  let previewState = null;
  const noop = () => undefined;
  const stable = {
    notifyReady: noop,
    readModel: () => model,
    markDirty: (d) => {
      dirty = d;
    },
    deleteBackup: async () => undefined,
    resetDocument: () => 0,
    setError: noop,
    setSaveError: noop,
    setRevertError: noop,
    setPreviewLoaded: noop,
    setPreviewError: noop,
    setRecovery: noop,
    setDiskChanged: noop,
    setContentRevision: noop,
    setDocumentPreview: noop,
    setDocumentError: noop,
    setDocumentOfficeMissing: noop,
  };
  function Probe() {
    const [preview, setPreview] = React.useState(null);
    previewState = preview;
    const [load, setLoad] = React.useState(null);
    const refs = React.useRef({
      loaded: ref(false),
      readOnly: ref(false),
      mtime: ref(0),
      disk: ref(''),
      text: ref(''),
      generation: ref(0),
    });
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
  t.after(async () => {
    await act(async () => root.unmount());
  });
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

test('a 50 MiB over-budget preview stays pinned across idle reclaim, backgrounding, and budget trim before React commits', async (t) => {
  _runIdleReclaimForTest();
  await Promise.resolve();
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  const prevVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  let seq = 0;
  const revoked = [];
  URL.createObjectURL = () => `blob:50m-${++seq}`;
  URL.revokeObjectURL = (value) => {
    revoked.push(value);
  };
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  t.after(() => {
    _runIdleReclaimForTest();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    if (prevVisibility) Object.defineProperty(document, 'visibilityState', prevVisibility);
    else delete document.visibilityState;
  });

  const fiftyMiB = 50 * 1024 * 1024;
  const chunk = Buffer.alloc(16).toString('base64');
  let fetchCount = 0;
  let releaseRange;
  const rangeStarted = new Promise((resolve) => {
    releaseRange = resolve;
  });
  let gateResolve;
  const remoteApi = createRemotePreviewApi(async (method) => {
    if (method === 'previewProjectFile') {
      fetchCount += 1;
      return { kind: 'image', mime: 'image/png', mtimeMs: 1, size: fiftyMiB };
    }
    releaseRange();
    await new Promise((resolve) => {
      gateResolve = resolve;
    });
    return { data: chunk, mime: 'image/png', offset: 0, size: 16, mtimeMs: 1 };
  });

  const noop = () => undefined;
  const ref = (current) => ({ current });
  let previewState = null;
  let commitDeferredPreview = null;
  let settledPreviewResult = null;
  const settledPromise = new Promise((resolve) => {
    settledPreviewResult = resolve;
  });

  const stable = {
    notifyReady: noop,
    readModel: () => null,
    markDirty: noop,
    deleteBackup: async () => undefined,
    resetDocument: () => 0,
    setError: noop,
    setSaveError: noop,
    setRevertError: noop,
    setPreviewLoaded: noop,
    setPreviewError: noop,
    setRecovery: noop,
    setDiskChanged: noop,
    setContentRevision: noop,
    setDocumentPreview: noop,
    setDocumentError: noop,
    setDocumentOfficeMissing: noop,
    setDocumentPassword: noop,
  };

  function Probe() {
    const [preview, setPreviewState] = React.useState(null);
    previewState = preview;
    const [load, setLoad] = React.useState(null);
    const refs = React.useRef({
      loaded: ref(false),
      readOnly: ref(false),
      mtime: ref(0),
      disk: ref(''),
      text: ref(''),
      generation: ref(0),
    });
    const setPreview = React.useCallback((next) => {
      if (next && !commitDeferredPreview) {
        commitDeferredPreview = () => setPreviewState(next);
        settledPreviewResult(next);
        return;
      }
      setPreviewState(next);
    }, []);
    useEditorSessionLoad({
      ...stable,
      api: remoteApi,
      projectPath: '/p',
      relPath: 'huge.png',
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

  const beforeChars = totalBudgetedChars();
  const root = createRoot(document.querySelector('main'));
  let unmounted = false;
  t.after(async () => {
    if (!unmounted) await act(async () => root.unmount());
  });

  await act(async () => root.render(React.createElement(Probe)));
  await rangeStarted;
  let resolved;
  await act(async () => {
    gateResolve();
    resolved = await settledPromise;
  });
  assert.equal(resolved.url, 'blob:50m-1');
  assert.equal(previewState, null, 'React has not yet committed setPreview(result)');

  // Delay past multiple macrotasks and hammer every eviction path before React commits.
  await new Promise((resolve) => setTimeout(resolve, 15));
  enforceRendererCacheBudget();
  _runIdleReclaimForTest();
  visibility = 'hidden';
  document.dispatchEvent(new window.Event('visibilitychange'));
  visibility = 'visible';
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.deepEqual(
    revoked,
    [],
    'synchronous handoff lease pins the 50 MiB blob across budget trim, idle reclaim, and backgrounding before commit'
  );

  // Commit the preview into React and confirm no duplicate download occurs.
  await act(async () => {
    commitDeferredPreview();
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
  assert.equal(previewState?.url, 'blob:50m-1');
  assert.deepEqual(revoked, [], '50 MiB blob remains live after commit');
  assert.equal(fetchCount, 1, '50 MiB preview is not re-downloaded after handoff to React');

  // Unmounting releases the active lease and immediately enforces the 24M cap.
  unmounted = true;
  await act(async () => root.unmount());
  assert.deepEqual(revoked, ['blob:50m-1'], 'unmounting immediately revokes the over-budget 50 MiB blob');
  assert.equal(totalBudgetedChars() - beforeChars, 0, 'retained chars return to baseline after unmount');
});
