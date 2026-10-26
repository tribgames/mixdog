import assert from 'node:assert/strict';
import test from 'node:test';

const { editorBreadcrumbMenuActions } = await import('./editor-pane-breadcrumb-actions.ts');

const formatDocument = () => {};
const base = {
  formattingAvailable: true,
  load: { binary: false, tooLarge: false, readOnly: false },
  preview: null,
  documentPreview: null,
  zoomable: false,
  formatDocument,
};
const ids = (overrides) => editorBreadcrumbMenuActions({ ...base, ...overrides }).map((action) => action.id);

test('Format Document is offered only for an editable, loaded text file with a formatter', () => {
  const [format] = editorBreadcrumbMenuActions(base);
  assert.deepEqual(format, { id: 'format', label: 'Format Document', onSelect: formatDocument });
  assert.deepEqual(ids({ formattingAvailable: false }), []);
  assert.deepEqual(ids({ load: null }), []);
  assert.deepEqual(ids({ load: { binary: true } }), []);
  assert.deepEqual(ids({ load: { tooLarge: true } }), []);
  assert.deepEqual(ids({ load: { readOnly: true } }), []);
  assert.deepEqual(ids({ preview: { kind: 'image' } }), []);
  assert.deepEqual(ids({ documentPreview: { pages: 1 } }), []);
});

test('zoomable previews append the zoom-bar toggle after a separator', () => {
  const actions = editorBreadcrumbMenuActions({ ...base, preview: { kind: 'image' }, zoomable: true });
  assert.deepEqual(
    actions.map((action) => [action.id, action.separatorBefore]),
    [['zoom-bar', true]]
  );
  assert.deepEqual(ids({ zoomable: true }), ['format', 'zoom-bar']);
});
