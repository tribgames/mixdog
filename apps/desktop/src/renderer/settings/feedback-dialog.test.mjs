import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'File', 'FileReader'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia =() => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { createRoot } = await import('react-dom/client');
const { AboutPanel } =await import('./about-panel.tsx');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

async function setup(t, submitFeedback) {
  const previous = window.mixdogDesktop;
  window.mixdogDesktop = { ...previous, ...(submitFeedback ? { submitFeedback } : {}) };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(AboutPanel)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.mixdogDesktop = previous;
  });
  const opener = [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Give feedback');
  opener.focus();
  return { host, opener };
}

const dialog = () => document.querySelector('[data-settings-nested-dialog]');
const button = (label) =>
  [...dialog().querySelectorAll('button')].find((b) => (b.textContent.trim() || b.getAttribute('aria-label')) === label);
const field = (selector) => dialog().querySelector(selector);

async function type(element, value) {
  const proto = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement : window.HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function openDialog(opener) {
  await act(async () => opener.click());
}

test('Feedback row replaces email support and opens an accessible popup without submitting', async (t) => {
  const calls = [];
  const opened = [];
  window.mixdogDesktop.openExternal = async (url) => opened.push(url);
  const { host, opener } = await setup(t, async (input) => calls.push(input));
  assert.doesNotMatch(host.textContent, /Contact support|Email|Copy/);
  assert.equal(dialog(), null);
  await openDialog(opener);
  const d = dialog();
  assert.equal(d.getAttribute('role'), 'dialog');
  assert.equal(d.getAttribute('aria-modal'), 'true');
  assert.equal(document.getElementById(d.getAttribute('aria-labelledby')).textContent, 'Feedback');
  assert.equal(d.getAttribute('aria-describedby'), null);
  assert.doesNotMatch(d.textContent, /optional|sent to the Mixdog server|MB total/);
  assert.ok(d.closest('.settings-confirm-layer'));
  assert.ok(field('[data-settings-nested-close]'));
  assert.equal(document.activeElement, field('textarea'));
  assert.deepEqual([...d.querySelectorAll('input[type=radio]')].map((r) => r.value), ['bug', 'suggestion', 'other']);
  assert.equal(calls.length, 0);
  assert.equal(opened.length, 0);
});

test('validation blocks empty, oversized and malformed input', async (t) => {
  const calls = [];
  const { opener } = await setup(t, async (input) => calls.push(input));
  await openDialog(opener);
  await act(async () => button('Send feedback').click());
  assert.match(dialog().textContent, /Enter a message\./);
  assert.equal(field('textarea').getAttribute('aria-invalid'), 'true');
  await type(field('textarea'), '   ');
  await act(async () => button('Send feedback').click());
  assert.match(dialog().textContent, /Enter a message\./);
  await type(field('textarea'), 'x'.repeat(8001));
  await act(async () => button('Send feedback').click());
  assert.match(dialog().textContent, /8000 characters or fewer/);
  await type(field('textarea'), 'ok');
  await type(field('input[type=email]'), 'not-an-email');
  await act(async () => button('Send feedback').click());
  assert.match(dialog().textContent, /valid email address/);
  assert.equal(field('input[type=email]').getAttribute('aria-invalid'), 'true');
  await type(field('input[type=email]'), `${'a'.repeat(250)}@b.co`);
  await act(async () => button('Send feedback').click());
  assert.match(dialog().textContent, /valid email address/);
  await type(field('input[type=email]'), 'a,b@example.com');
  await act(async () => button('Send feedback').click());
  assert.match(dialog().textContent, /valid email address/);
  assert.equal(calls.length, 0);
});

test('submit sends a normalized payload, blocks duplicates while pending, and reports receipt', async (t) => {
  const pending = deferred();
  const calls = [];
  const { opener } = await setup(t, (input) => {
    calls.push(input);
    return pending.promise;
  });
  await openDialog(opener);
  await act(async () => field('input[value=suggestion]').click());
  await type(field('textarea'), '  Add a dark mode  ');
  await type(field('input[type=email]'), ' me@example.com ');
  const form = field('form');
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual({ ...calls[0], id: undefined }, {
    id: undefined,
    kind: 'suggestion',
    message: 'Add a dark mode',
    replyTo: 'me@example.com',
  });
  assert.equal(button('Sending…').disabled, true);
  assert.equal(field('[data-settings-nested-close]').disabled, true);
  await act(async () => pending.resolve({ id: calls[0].id, status: 'accepted' }));
  assert.match(dialog().textContent, /Feedback received/);
  assert.match(document.getElementById(dialog().getAttribute('aria-describedby')).textContent, /Feedback received/);
  assert.doesNotMatch(dialog().textContent, /delivered|emailed/i);
  await act(async () => button('Close').click());
  assert.equal(dialog(), null);
  assert.equal(document.activeElement, opener);
});

test('blank reply email is omitted from the payload', async (t) => {
  const calls = [];
  const { opener } = await setup(t, async (input) => {
    calls.push(input);
    return { id: input.id, status: 'accepted' };
  });
  await openDialog(opener);
  await type(field('textarea'), 'Crash on start');
  await act(async () => button('Send feedback').click());
  assert.equal('replyTo' in calls[0], false);
  assert.equal(calls[0].kind, 'bug');
});

test('failure keeps the draft and id for retry; an edit gets a new id; success rotates the id', async (t) => {
  const calls = [];
  let fail = true;
  const { opener } = await setup(t, async (input) => {
    calls.push(input);
    if (fail) throw new Error('secret server detail');
    return { id: input.id, status: 'accepted' };
  });
  await openDialog(opener);
  await type(field('textarea'), 'Something broke');
  await type(field('input[type=email]'), 'me@example.com');
  await act(async () => button('Send feedback').click());
  assert.match(dialog().textContent, /could not be sent/);
  assert.doesNotMatch(dialog().textContent, /secret server detail/);
  assert.equal(field('textarea').value, 'Something broke');
  assert.equal(field('input[type=email]').value, 'me@example.com');
  await act(async () => button('Send feedback').click());
  assert.equal(calls[1].id, calls[0].id);
  await type(field('textarea'), 'Something broke badly');
  await act(async () => button('Send feedback').click());
  assert.notEqual(calls[2].id, calls[0].id);
  fail = false;
  await act(async () => button('Send feedback').click());
  assert.equal(calls[3].id, calls[2].id);
  assert.match(dialog().textContent, /Feedback received/);
});

test('Cancel and the close control dismiss without sending and return focus', async (t) => {
  const calls = [];
  const { opener } = await setup(t, async (input) => calls.push(input));
  await openDialog(opener);
  await type(field('textarea'), 'draft');
  await act(async () => button('Cancel').click());
  assert.equal(dialog(), null);
  assert.equal(document.activeElement, opener);
  await openDialog(opener);
  assert.equal(field('textarea').value, '');
  await act(async () => field('[data-settings-nested-close]').click());
  assert.equal(dialog(), null);
  assert.equal(document.activeElement, opener);
  await openDialog(opener);
  await act(async () => {
    field('textarea').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  });
  assert.ok(dialog(), 'a press inside the card keeps it open');
  await act(async () => {
    dialog().closest('.settings-confirm-layer').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  });
  assert.equal(dialog(), null);
  assert.equal(document.activeElement, opener);
  assert.equal(calls.length, 0);
});

const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A valid PNG padded to exactly `size` bytes with an ancillary chunk before IEND. */
function pngOfSize(size) {
  const body = PNG.subarray(0, PNG.length - 12);
  const iend = PNG.subarray(PNG.length - 12);
  const dataLength = size - PNG.length - 12;
  const chunk = Buffer.alloc(dataLength + 12);
  chunk.writeUInt32BE(dataLength, 0);
  chunk.write('prVt', 4, 'latin1');
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + dataLength)), 8 + dataLength);
  return Uint8Array.from(Buffer.concat([body, chunk, iend]));
}
const MIB = 1024 * 1024;
const png = (name = 'a.png', bytes = PNG, type = 'image/png') =>
  Object.assign(new window.File([bytes], name, { type }), { bytes });

/** A FileReader whose reads complete only when the test says so. */
function controlReader(t) {
  const Real = globalThis.FileReader;
  const queue = [];
  globalThis.FileReader = class {
    readAsDataURL(file) {
      this.file = file;
      queue.push(this);
    }
  };
  t.after(() => {
    globalThis.FileReader = Real;
  });
  const settle = async (fn) => {
    const batch = queue.splice(0);
    await act(async () => batch.forEach(fn));
  };
  return {
    get pending() {
      return queue.length;
    },
    finish: () =>
      settle((r) => {
        r.result = `data:${r.file.type};base64,${Buffer.from(r.file.bytes).toString('base64')}`;
        r.onload();
      }),
    fail: () =>
      settle((r) => {
        r.error = new Error('unreadable');
        r.onerror();
      }),
  };
}

async function choose(files) {
  const input = field('input[type=file]');
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
const names = () => [...dialog().querySelectorAll('.settings-feedback-attachment-name')].map((n) => n.textContent);

test('images: select, preview, remove, and send with the payload', async (t) => {
  const reader = controlReader(t);
  const calls = [];
  const { opener } = await setup(t, async (input) => {
    calls.push(input);
    return { id: input.id, status: 'accepted' };
  });
  await openDialog(opener);
  assert.match(dialog().textContent, /Attach images/);
  await choose([png('a.png'), png('b.png')]);
  assert.equal(reader.pending, 2);
  await reader.finish();
  assert.deepEqual(names(), ['a.png', 'b.png']);
  assert.equal(dialog().querySelectorAll('.settings-feedback-attachments img').length, 2);
  await act(async () => field('button[aria-label="Remove a.png"]').click());
  assert.deepEqual(names(), ['b.png']);
  await type(field('textarea'), 'with image');
  await act(async () => button('Send feedback').click());
  assert.deepEqual(calls[0].attachments, [
    { name: 'b.png', mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') },
  ]);
});

test('images: invalid type, oversize and count are rejected; exact 2 MiB images are accepted', async (t) => {
  const reader = controlReader(t);
  const { opener } = await setup(t, async () => ({ status: 'accepted' }));
  await openDialog(opener);
  await choose([png('x.gif', PNG, 'image/gif')]);
  assert.equal(reader.pending, 0);
  assert.match(dialog().textContent, /only PNG, JPEG or WebP/);
  assert.deepEqual(names(), []);
  await choose([png('big.png', pngOfSize(2 * MIB + 1))]);
  assert.equal(reader.pending, 0);
  assert.match(dialog().textContent, /2 MB or smaller/);
  assert.deepEqual(names(), []);
  const exact = pngOfSize(2 * MIB);
  assert.equal(exact.length, 2 * MIB);
  await choose([png('1.png', exact), png('2.png', exact), png('3.png', exact), png('4.png')]);
  assert.equal(reader.pending, 3);
  await reader.finish();
  assert.match(dialog().textContent, /up to 3 images/);
  assert.deepEqual(names(), ['1.png', '2.png', '3.png']);
  assert.equal(button('Add images').disabled, true);
});

test('images: send, add and remove are blocked until a pending read completes', async (t) => {
  const reader = controlReader(t);
  const calls = [];
  const { opener } = await setup(t, async (input) => calls.push(input));
  await openDialog(opener);
  await type(field('textarea'), 'msg');
  await choose([png('a.png')]);
  assert.equal(reader.pending, 1);
  assert.equal(button('Send feedback').disabled, true);
  assert.equal(button('Reading images…').disabled, true);
  await act(async () => {
    field('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(calls.length, 0);
  await reader.finish();
  assert.deepEqual(names(), ['a.png']);
  assert.equal(button('Send feedback').disabled, false);
});

test('images: an unreadable file shows an error and adds nothing', async (t) => {
  const reader = controlReader(t);
  const { opener } = await setup(t, async () => ({ status: 'accepted' }));
  await openDialog(opener);
  await choose([png('a.png')]);
  await reader.fail();
  assert.match(dialog().textContent, /could not be read/);
  assert.deepEqual(names(), []);
  assert.equal(button('Add images').disabled, false);
});

test('images: draft survives failure, retry keeps id, image edits rotate it, sending disables edits', async (t) => {
  const reader = controlReader(t);
  const calls = [];
  const gate = deferred();
  let mode = 'fail';
  const { opener } = await setup(t, (input) => {
    calls.push(input);
    if (mode === 'hold') return gate.promise;
    if (mode === 'fail') return Promise.reject(new Error('x'));
    return Promise.resolve({ id: input.id, status: 'accepted' });
  });
  await openDialog(opener);
  await type(field('textarea'), 'msg');
  await choose([png('a.png')]);
  await reader.finish();
  await act(async () => button('Send feedback').click());
  assert.match(dialog().textContent, /could not be sent/);
  assert.deepEqual(names(), ['a.png']);
  await act(async () => button('Send feedback').click());
  assert.equal(calls[1].id, calls[0].id);
  await choose([png('b.png')]);
  await reader.finish();
  await act(async () => button('Send feedback').click());
  assert.notEqual(calls[2].id, calls[1].id);
  await act(async () => field('button[aria-label="Remove b.png"]').click());
  mode = 'hold';
  await act(async () => button('Send feedback').click());
  assert.notEqual(calls[3].id, calls[2].id);
  assert.equal(button('Add images').disabled, true);
  assert.equal(field('button[aria-label="Remove a.png"]').disabled, true);
  await act(async () => gate.resolve({ id: calls[3].id, status: 'accepted' }));
  assert.match(dialog().textContent, /Feedback received/);
});

test('images: closing while reading discards the result without error', async (t) => {
  const reader = controlReader(t);
  const { opener } = await setup(t, async () => ({ status: 'accepted' }));
  await openDialog(opener);
  await choose([png('a.png')]);
  await act(async () => button('Cancel').click());
  await reader.finish();
  assert.equal(dialog(), null);
  await openDialog(opener);
  assert.deepEqual(names(), []);
});



test('missing host method shows an unavailable state and cannot submit', async (t) => {
  const { opener } = await setup(t, undefined);
  await openDialog(opener);
  assert.match(dialog().textContent, /not available in this version/);
  assert.equal(button('Send feedback').disabled, true);
});
