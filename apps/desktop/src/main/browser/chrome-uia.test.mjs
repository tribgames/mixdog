import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chromeNativeAddressField,
  chromeOwnedConsentAllowRef,
  chromeSetupControl,
  CHROME_REMOTE_DEBUGGING_URL,
} from './chrome-uia';

function element(overrides = {}) {
  return {
    ref: 's1:e0',
    source: 'uia',
    role: 'Text',
    name: '',
    value: '',
    state: '',
    enabled: true,
    x: 0,
    y: 0,
    width: 100,
    height: 30,
    actions: [],
    runtime_id: '',
    parent_runtime_id: '',
    class_name: '',
    has_keyboard_focus: false,
    in_document: false,
    ancestors: [],
    ...overrides,
  };
}

test('selects only Chrome native editable address field outside web content', () => {
  const native = element({
    ref: 'address',
    role: 'Edit',
    value: 'chrome://newtab/',
    actions: ['set_value'],
  });
  const pageInput = element({
    ref: 'page-input',
    role: 'Edit',
    actions: ['set_value'],
    in_document: true,
  });
  assert.deepEqual(chromeNativeAddressField([native, pageInput]), {
    ref: 'address',
    value: 'chrome://newtab/',
  });
});

test('selects the unique checkbox only on the exact Chrome setup document', () => {
  const elements = [
    element({
      ref: 'address',
      role: 'Edit',
      value: CHROME_REMOTE_DEBUGGING_URL,
      actions: ['set_value'],
      runtime_id: 'address',
    }),
    element({
      ref: 'document',
      role: 'Document',
      runtime_id: 'document',
    }),
    element({
      ref: 'toggle',
      role: 'CheckBox',
      state: 'toggle=Off',
      actions: ['toggle'],
      runtime_id: 'toggle',
      parent_runtime_id: 'document',
      in_document: true,
      ancestors: [{ runtime_id: 'document', role: 'Document', name: '' }],
    }),
  ];
  assert.deepEqual(chromeSetupControl(elements), {
    ref: 'toggle',
    enabled: false,
  });
  elements[2].state = 'toggle=On';
  assert.deepEqual(chromeSetupControl(elements), {
    ref: 'toggle',
    enabled: true,
  });
});

test('selects Chrome native allow by structural surface and button geometry', () => {
  const paneAncestor = { runtime_id: 'pane', role: 'Pane', name: 'opaque-title' };
  const surfaceAncestor = { runtime_id: 'surface', role: 'Window', name: 'opaque-title' };
  const descendants = [surfaceAncestor, paneAncestor];
  const elements = [
    element({
      ref: 'pane',
      role: 'Pane',
      name: 'opaque-title',
      runtime_id: 'pane',
    }),
    element({
      ref: 'surface',
      role: 'Window',
      name: 'opaque-title',
      runtime_id: 'surface',
      parent_runtime_id: 'pane',
      ancestors: [paneAncestor],
    }),
    element({
      ref: 'title',
      role: 'Text',
      name: 'opaque-title',
      runtime_id: 'title',
      parent_runtime_id: 'surface',
      ancestors: descendants,
    }),
    element({
      ref: 'extra',
      role: 'Button',
      runtime_id: 'extra',
      class_name: 'MdTextButton',
      actions: ['invoke'],
      x: 0,
      y: 100,
      width: 80,
      height: 30,
      ancestors: descendants,
    }),
    element({
      ref: 'allow',
      role: 'Button',
      runtime_id: 'allow',
      class_name: 'MdTextButton',
      actions: ['invoke'],
      x: 180,
      y: 100,
      width: 80,
      height: 30,
      ancestors: descendants,
    }),
    element({
      ref: 'cancel',
      role: 'Button',
      runtime_id: 'cancel',
      class_name: 'MdTextButton',
      has_keyboard_focus: true,
      actions: ['invoke'],
      x: 270,
      y: 100,
      width: 80,
      height: 30,
      ancestors: descendants,
    }),
  ];
  assert.equal(chromeOwnedConsentAllowRef(elements.filter((candidate) => candidate.ref !== 'pane')), 'allow');
});

test('owned Chrome consent ignores web-content buttons even when they duplicate native geometry', () => {
  const native = [
    { ref: 'extra', x: 0 },
    { ref: 'allow', x: 180 },
    { ref: 'cancel', x: 270, has_keyboard_focus: true },
  ].map((button) =>
    element({
      role: 'Button',
      class_name: 'MdTextButton',
      actions: ['invoke'],
      y: 100,
      width: 80,
      height: 30,
      ...button,
    })
  );
  const webContent = native.map((button) => ({
    ...button,
    ref: `web-${button.ref}`,
    in_document: true,
    ancestors: [{ runtime_id: 'document', role: 'Document', name: '' }],
  }));

  assert.equal(chromeOwnedConsentAllowRef(webContent), null);
  assert.equal(chromeOwnedConsentAllowRef([...webContent, ...native]), 'allow');
  assert.equal(chromeOwnedConsentAllowRef([...native, ...webContent]), 'allow');
});
