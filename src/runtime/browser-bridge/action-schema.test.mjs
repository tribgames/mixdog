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

test('drag addresses both ends the same way: two refs, two targets, or two points', () => {
  ok('drag', { ref: 'p1-s1-e1', targetRef: 'p1-s1-e2' });
  ok('drag', { target: { selector: '#card' }, dropTarget: { selector: '#done' } });
  ok('drag', { snapshotId: 'p1-s1', x: 10, y: 20, targetX: 30, targetY: 40 });
  // A drop zone with no accessible name is still an element spec, not a ref.
  bad('drag', { target: { selector: '#card' } }, /requires/);
  bad('drag', { target: { selector: '#card' }, dropTarget: 'p1-s1-e2' }, /input\.dropTarget must be an object/);
  bad('drag', { target: { selector: '#card' }, dropTarget: { css: '#done' } }, /input\.dropTarget does not accept/);
});

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

test('a snapshot target crops the visual image and refuses the forms with nothing to crop', () => {
  ok('snapshot', { mode: 'visual', ref: 'p1-s1-e1' });
  ok('snapshot', { mode: 'visual', ref: 'p1-s1-e1', format: 'png' });
  ok('snapshot', { mode: 'visual', target: { role: 'table', name: 'Invoices' } });
  bad('snapshot', { ref: 'p1-s1-e1' }, /requires input.mode=visual/);
  bad('snapshot', { mode: 'both', target: { name: 'Chart' } }, /requires input.mode=visual/);
  bad('snapshot', { mode: 'visual', ref: 'p1-s1-e1', fullPage: true }, /cannot be combined with fullPage/);
  bad('snapshot', { mode: 'visual', ref: 'p1-s1-e1', format: 'pdf' }, /prints the whole page/);
  bad(
    'snapshot',
    { mode: 'visual', ref: 'p1-s1-e1', target: { name: 'Chart' } },
    /only one input target form/
  );
});

test('ref forms that share a field with the target form still validate', () => {
  ok('fill', { ref: 'p1-s1-e1', text: 'value' });
  ok('type', { ref: 'p1-s1-e1', text: 'value', submit: true });
  bad('fill', { ref: 'p1-s1-e1', target: { name: 'x' }, text: 'value' }, /only one input target form/);
  bad(
    'fill',
    { text: 'value' },
    /requires input.ref\+text or input.target\+text or input.ref\+checked or input.target\+checked or input.fields/
  );
});

test('a stored login is its own fill form and never mixes with a typed value', () => {
  ok('fill', { savedAccount: 'ada@example.test' });
  ok('fill', { savedAccount: 'a•••a@example.test', submit: true, expect: { url: '/home' } });
  bad('fill', { savedAccount: 'ada@example.test', text: 'secret' }, /only one input target form/);
  bad('fill', { savedAccount: 'ada@example.test', ref: 'p1-s1-e1', text: 'x' }, /only one input target form/);
  bad('fill', { savedAccount: 'a'.repeat(321) }, /savedAccount must be a string of at most 320/);
  bad('type', { savedAccount: 'ada@example.test' }, /does not accept input field\(s\): savedAccount/);
  ok('sequence', {
    steps: [
      { action: 'fill', savedAccount: 'ada@example.test' },
      { action: 'click', target: { role: 'button', name: 'Sign in' } },
    ],
  });
  bad(
    'sequence',
    {
      steps: [
        { action: 'fill', savedAccount: 'ada@example.test', text: 'x' },
        { action: 'press', key: 'Enter' },
      ],
    },
    /savedAccount fills the whole sign-in form/
  );
});

test('fill fields are addressed all by ref or all by target', () => {
  ok('fill', {
    fields: [
      { target: { name: 'Email' }, text: 'a' },
      { target: { name: 'Agree' }, checked: true },
    ],
  });
  bad(
    'fill',
    {
      fields: [
        { target: { name: 'Email' }, text: 'a' },
        { ref: 'p1-s1-e2', checked: true },
      ],
    },
    /must use ref for every item or target for every item/
  );
  bad(
    'fill',
    { fields: [{ ref: 'p1-s1-e1', target: { name: 'Email' }, text: 'a' }] },
    /requires ref or target, not both/
  );
  bad('fill', { fields: [{ text: 'a' }] }, /requires ref or target/);
  bad('fill', { fields: [{ target: { nth: 2 }, text: 'a' }] }, /fields\[0\].target requires role, name/);
});

test('sequence steps take a target in place of a ref', () => {
  ok('sequence', {
    steps: [
      { action: 'fill', target: { name: 'Email' }, text: 'a' },
      { action: 'click', target: { role: 'button', name: 'Sign in' } },
    ],
  });
  bad(
    'sequence',
    {
      steps: [
        { action: 'click', ref: 'p1-s1-e1', target: { name: 'x' } },
        { action: 'press', key: 'Enter' },
      ],
    },
    /accepts ref or target, not both/
  );
  bad(
    'sequence',
    {
      steps: [
        { action: 'click', target: { role: '' } },
        { action: 'press', key: 'Enter' },
      ],
    },
    /steps\[0\].target requires role, name/
  );
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
