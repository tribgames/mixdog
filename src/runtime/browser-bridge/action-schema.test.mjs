import assert from 'node:assert/strict';
import test from 'node:test';

import { validateBrowserToolArgs } from './action-schema.mjs';

const ok = (action, input) => {
  const result = validateBrowserToolArgs({ action, input });
  assert.equal(result.ok, true, result.error);
  return result;
};
const bad = (action, input, pattern) => {
  const result = validateBrowserToolArgs({ action, input });
  assert.equal(result.ok, false, `expected ${action} to be rejected`);
  assert.match(result.error, pattern);
};

test('a snapshot-free target replaces ref on gestures and is validated as one element spec', () => {
  ok('click', { target: { role: 'button', name: 'Save' } });
  ok('fill', { target: { name: 'Email' }, text: 'ada@example.test' });
  ok('type', { target: { selector: '#editor' }, text: 'draft' });
  ok('select', { target: { role: 'combobox', name: 'Country' }, values: ['KR'] });
  ok('fill', { target: { selector: 'input[name=agree]' }, checked: true });
  ok('hover', { target: { name: 'Menu', exact: true, nth: 1 } });
  ok('upload', { target: { role: 'button', name: 'Choose file' }, paths: ['C:\\file.png'] });
  ok('scroll', { target: { role: 'list', name: 'Results' }, dy: 300 });
  bad('click', { target: {} }, /requires role, name, and\/or selector/);
  bad('click', { target: { text: 'Save' } }, /does not accept field\(s\): text/);
  bad('click', { target: { role: 'button', exact: true } }, /exact applies to name/);
  bad('click', { target: { name: 'Save', nth: 0 } }, /nth must be an integer from 1 to 500/);
  bad('click', { target: { name: 'Save' }, ref: 'p1-s1-e1' }, /only one input target form/);
  bad('click', { ref: 'p1-s1-e1', x: 1 }, /only one input target form/);
  bad('press', { target: { name: 'Save' }, key: 'Enter' }, /does not accept input field\(s\): target/);
});

test('ref forms that share a field with the target form still validate', () => {
  ok('fill', { ref: 'p1-s1-e1', text: 'value' });
  ok('type', { ref: 'p1-s1-e1', text: 'value', submit: true });
  bad('fill', { ref: 'p1-s1-e1', target: { name: 'x' }, text: 'value' }, /only one input target form/);
  bad('fill', { text: 'value' },
    /requires input.ref\+text or input.target\+text or input.ref\+checked or input.target\+checked or input.fields/);
});

test('fill fields are addressed all by ref or all by target', () => {
  ok('fill', { fields: [{ target: { name: 'Email' }, text: 'a' }, { target: { name: 'Agree' }, checked: true }] });
  bad('fill', { fields: [{ target: { name: 'Email' }, text: 'a' }, { ref: 'p1-s1-e2', checked: true }] },
    /must use ref for every item or target for every item/);
  bad('fill', { fields: [{ ref: 'p1-s1-e1', target: { name: 'Email' }, text: 'a' }] }, /requires ref or target, not both/);
  bad('fill', { fields: [{ text: 'a' }] }, /requires ref or target/);
  bad('fill', { fields: [{ target: { nth: 2 }, text: 'a' }] }, /fields\[0\].target requires role, name/);
});

test('sequence steps take a target in place of a ref', () => {
  ok('sequence', { steps: [{ action: 'fill', target: { name: 'Email' }, text: 'a' }, { action: 'click', target: { role: 'button', name: 'Sign in' } }] });
  bad('sequence', { steps: [{ action: 'click', ref: 'p1-s1-e1', target: { name: 'x' } }, { action: 'press', key: 'Enter' }] },
    /accepts ref or target, not both/);
  bad('sequence', { steps: [{ action: 'click', target: { role: '' } }, { action: 'press', key: 'Enter' }] },
    /steps\[0\].target requires role, name/);
});

test('query regular expressions must compile and may only carry the i flag', () => {
  ok('snapshot', { query: 'save draft' });
  ok('snapshot', { query: '/save|publish/i' });
  ok('read', { query: '/^total/' });
  bad('snapshot', { query: '/save/g' }, /only the i flag/);
  bad('read', { query: '/(/' }, /regular expression is invalid/);
  ok('network', { query: '/api/v1/' }, 'network keeps substring semantics');
});

test('brief is accepted on state-changing actions only', () => {
  ok('click', { ref: 'p1-s1-e1', brief: true });
  ok('navigate', { url: 'https://example.test/', brief: true });
  bad('snapshot', { brief: true }, /does not accept input field\(s\): brief/);
});