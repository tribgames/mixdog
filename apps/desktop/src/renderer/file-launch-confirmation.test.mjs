import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { openConfirmedFile } from './file-launch-confirmation.tsx';

function fixture(t) {
  const { dom } = installTestDom(t);
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  return dom.window.document;
}

for (const choice of ['cancel', 'escape', 'run']) {
  test(`file launch ${choice} uses the app dialog and defaults to cancellation`, async (t) => {
    const document = fixture(t);
    const path = 'C:\\Downloads\\setup.exe';
    const calls = [];
    let work;
    await act(async () => {
      work = openConfirmedFile(async (confirmedPath) => {
        calls.push(confirmedPath);
        return confirmedPath === path ? 'file' : { confirmationPath: path };
      });
    });
    const dialog = document.querySelector('dialog');
    assert.ok(dialog.open);
    assert.ok(dialog.textContent.includes('setup.exe'));
    assert.ok(dialog.textContent.includes(path));
    assert.equal(document.getElementById('file-launch-path').textContent, path);
    assert.equal(document.getElementById('file-launch-warning').textContent, 'Only run files you trust.');
    assert.equal(dialog.querySelector('svg, [aria-hidden="true"]')?.getAttribute('aria-hidden'), 'true');
    const buttons = dialog.querySelectorAll('button');
    assert.equal(document.activeElement, buttons[0]);
    assert.deepEqual(calls, [undefined], 'no confirmed call before an explicit Run');
    await act(async () => {
      if (choice === 'escape') dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
      else buttons[choice === 'run' ? 1 : 0].click();
      await work;
    });
    assert.deepEqual(calls, choice === 'run' ? [undefined, path] : [undefined]);
    assert.equal(document.querySelector('dialog'), null);
  });
}

test('documents open without a confirmation dialog', async (t) => {
  const document = fixture(t);
  assert.equal(await openConfirmedFile(async () => 'file'), 'file');
  assert.equal(document.querySelector('dialog'), null);
});
