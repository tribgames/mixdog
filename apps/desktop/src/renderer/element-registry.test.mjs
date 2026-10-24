import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './test-support/test-dom.mjs';

/** Counts document-wide discovery (a query on the document, <html> or <body>)
 *  while `run` runs. */
function countDocumentQueries(window, run) {
  const { document } = window;
  const wide = (self) => self === document || self === document.documentElement || self === document.body;
  let count = 0;
  const restore = [];
  for (const proto of [window.Document.prototype, window.Element.prototype]) {
    for (const name of ['querySelectorAll', 'querySelector', 'getElementsByTagName', 'getElementsByClassName']) {
      const original = proto[name];
      if (!original) continue;
      proto[name] = function (...args) {
        if (wide(this)) count += 1;
        return original.apply(this, args);
      };
      restore.push(() => {
        proto[name] = original;
      });
    }
  }
  try {
    run();
  } finally {
    for (const undo of restore) undo();
  }
  return count;
}

const element = (document, html) => {
  const host = document.createElement('div');
  host.innerHTML = html.trim();
  return host.firstElementChild;
};

test('a modal dialog counts from the moment it mounts or flips aria-modal, with no await between', async (t) => {
  const { document } = installTestDom(t);
  const { presentedModalDialog, modalDialogPresented } = await import('./surface-input-focus.ts');
  assert.equal(presentedModalDialog(), null);
  const dialog = element(document, '<section role="dialog" aria-modal="true"></section>');
  document.body.append(dialog);
  assert.equal(presentedModalDialog(), dialog, 'mounted: presented at once');
  dialog.setAttribute('aria-modal', 'false');
  assert.equal(modalDialogPresented(), false, 'aria-modal off: closed');
  dialog.setAttribute('aria-modal', 'true');
  assert.equal(presentedModalDialog(), dialog, 'aria-modal back on');
  dialog.remove();
  assert.equal(presentedModalDialog(), null, 'unmounted');
  // A dialog that arrives inside an inserted wrapper (a portal) counts too.
  const portal = element(document, '<div><div><section aria-modal="true"></section></div></div>');
  document.body.append(portal);
  assert.equal(presentedModalDialog(), portal.querySelector('section'));
  portal.remove();
  assert.equal(presentedModalDialog(), null);
});

test('nested and stacked dialogs: the last presented one in document order owns the keyboard', async (t) => {
  const { document } = installTestDom(t);
  const { presentedModalDialog } = await import('./surface-input-focus.ts');
  const outer = element(document, '<section id="outer" aria-modal="true"><div class="body"></div></section>');
  document.body.append(outer);
  const inner = element(document, '<section id="inner" aria-modal="true"></section>');
  outer.querySelector('.body').append(inner);
  assert.equal(presentedModalDialog(), inner, 'a confirmation inside a dialog is on top');
  inner.setAttribute('aria-modal', 'false');
  assert.equal(presentedModalDialog(), outer, 'the confirmation closed: the dialog again');
  inner.setAttribute('aria-modal', 'true');
  const sibling = element(document, '<section id="sibling" aria-modal="true"></section>');
  document.body.append(sibling);
  assert.equal(presentedModalDialog(), sibling, 'a later portal stacks above');
  // Moved to the end of the body (re-portaled): the order follows the move.
  document.body.append(outer);
  assert.equal(presentedModalDialog(), inner, 'the moved dialog is last again');
  outer.remove();
  assert.equal(presentedModalDialog(), sibling, 'the subtree removed with its nested dialog');
  sibling.remove();
  assert.equal(presentedModalDialog(), null);
});

test('a parked surface keeps its static aria-modal without owning the keyboard; presenting it needs no mutation of the dialog', async (t) => {
  const { document } = installTestDom(t);
  const { presentedModalDialog } = await import('./surface-input-focus.ts');
  for (const parked of ['inert', 'aria-hidden="true"', 'data-surface-active="false"']) {
    const layer = element(document, `<div ${parked}><div><section aria-modal="true"></section></div></div>`);
    const dialog = layer.querySelector('section');
    document.body.append(layer);
    assert.equal(presentedModalDialog(), null, `parked by ${parked}`);
    const name = parked.split('=')[0];
    layer.removeAttribute(name);
    assert.equal(presentedModalDialog(), dialog, `${name} lifted: presented at once`);
    layer.setAttribute(name, name === 'inert' ? '' : parked.split('=')[1].replaceAll('"', ''));
    assert.equal(presentedModalDialog(), null, `${name} back: parked again`);
    layer.remove();
  }
  // A parked surface after a presented one does not hide the presented one.
  const open = element(document, '<section id="open" aria-modal="true"></section>');
  const parked = element(document, '<div aria-hidden="true"><section aria-modal="true"></section></div>');
  document.body.append(open, parked);
  assert.equal(presentedModalDialog(), open);
  open.remove();
  parked.remove();
});

test('after the first read, typing-time checks run no document-wide query', async (t) => {
  const { window, document } = installTestDom(t, { expose: ['Element'] });
  const { modalDialogPresented, shouldFocusComposerFromWindowKey } = await import('./surface-input-focus.ts');
  document.body.innerHTML = '<main><form class="composer"><textarea></textarea></form></main>';
  const parked = element(document, '<div inert><section aria-modal="true"></section></div>');
  document.body.append(parked);
  modalDialogPresented();
  const form = document.querySelector('form');
  const queries = countDocumentQueries(window, () => {
    for (let index = 0; index < 40; index += 1) {
      // Unrelated mutations between keystrokes (the composer re-rendering).
      form.append(document.createElement('span'));
      assert.equal(modalDialogPresented(), false);
      const event = new window.KeyboardEvent('keydown', { key: 'a' });
      Object.defineProperty(event, 'target', { value: document.body });
      assert.equal(shouldFocusComposerFromWindowKey(event), true);
    }
  });
  assert.equal(queries, 0);
});

test('a registry lists exactly what querySelectorAll lists, in document order, through mounts, moves and attribute flips', async (t) => {
  const { document } = installTestDom(t);
  const { registerElements } = await import('./element-registry.ts');
  const selector = '[role="menu"], [role="listbox"], .mx-menu, .pane-side-dock';
  const registry = registerElements(selector, ['role', 'class']);
  let seed = 7;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const roles = [null, 'menu', 'listbox', 'option', 'dialog'];
  const classes = ['', 'mx-menu', 'pane-side-dock', 'row', 'mx-menu open'];
  const nodes = () => Array.from(document.body.querySelectorAll('*'));
  for (let step = 0; step < 400; step += 1) {
    const all = nodes();
    const pick = () => all[random(all.length)] ?? document.body;
    switch (random(6)) {
      case 0: {
        const fresh = document.createElement('div');
        fresh.innerHTML = '<div role="menu"><span class="mx-menu"></span></div><p></p>';
        pick().append(fresh);
        break;
      }
      case 1:
        if (all.length) pick().remove();
        break;
      case 2: {
        const node = pick();
        const role = roles[random(roles.length)];
        if (node !== document.body) {
          if (role) node.setAttribute('role', role);
          else node.removeAttribute('role');
        }
        break;
      }
      case 3: {
        const node = pick();
        if (node !== document.body) node.className = classes[random(classes.length)];
        break;
      }
      case 4: {
        // A move: append an existing node somewhere else (not into itself).
        const node = pick();
        const target = pick();
        if (node !== document.body && !node.contains(target)) target.prepend(node);
        break;
      }
      default:
        document.body.append(document.createElement('section'));
    }
    if (step % 3 === 0) {
      assert.deepEqual(registry.list(), Array.from(document.querySelectorAll(selector)), `step ${step}`);
    }
  }
  assert.deepEqual(registry.list(), Array.from(document.querySelectorAll(selector)));
});

test('an element that leaves the document tree for a shadow root or an iframe leaves the registry, as querySelectorAll sees it', async (t) => {
  const { document } = installTestDom(t);
  const { registerElements } = await import('./element-registry.ts');
  const selector = '[role="menu"], .mx-menu';
  const registry = registerElements(selector, ['role', 'class']);
  const same = (label) => assert.deepEqual(registry.list(), Array.from(document.querySelectorAll(selector)), label);
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const menu = element(document, '<div role="menu"><span class="mx-menu"></span></div>');
  document.body.append(menu);
  same('registered in the light DOM');
  assert.equal(registry.list().length, 2);
  shadow.append(menu);
  same('moved into a shadow root');
  assert.deepEqual(registry.list(), []);
  // Changed and removed inside the shadow root: never registered again.
  menu.setAttribute('role', 'menu');
  menu.firstElementChild.className = 'mx-menu open';
  same('attributes flipped inside the shadow root');
  menu.remove();
  same('removed inside the shadow root');
  // Back into the document: registered again.
  document.body.append(menu);
  same('back in the light DOM');
  assert.equal(registry.list().length, 2);
  // A wrapper carrying it into the shadow root, with a flip in the same batch.
  const wrapper = document.createElement('section');
  document.body.append(wrapper);
  wrapper.append(menu);
  registry.list();
  shadow.append(wrapper);
  menu.setAttribute('role', 'menu');
  same('an ancestor moved into the shadow root');
  wrapper.remove();
  same('and removed there');
  // Adopted by an iframe's document.
  const frame = document.createElement('iframe');
  document.body.append(frame);
  document.body.append(menu);
  same('in the document again');
  assert.equal(registry.list().length, 2);
  frame.contentDocument.body.append(menu);
  same('moved into the iframe');
  assert.deepEqual(registry.list(), []);
  menu.remove();
  same('removed inside the iframe');
  host.remove();
  frame.remove();
});

test('overlapping insertions in one batch scan the outer subtree once and still register everything', async (t) => {
  const { window, document } = installTestDom(t);
  const { registerElements } = await import('./element-registry.ts');
  const selector = '[role="listbox"]';
  const registry = registerElements(selector, ['role']);
  registry.list();
  const outer = element(document, '<div><div role="listbox"></div></div>');
  const inner = element(document, '<div><div role="listbox"></div></div>');
  const moved = element(document, '<div role="listbox"></div>');
  document.body.append(outer, moved);
  outer.append(inner);
  // Inserted inside `outer`, then moved out again: scanned on its own.
  outer.append(moved);
  document.body.append(moved);
  const scanned = [];
  const original = window.Element.prototype.querySelectorAll;
  window.Element.prototype.querySelectorAll = function (...args) {
    scanned.push(this);
    return original.apply(this, args);
  };
  try {
    assert.deepEqual(registry.list(), Array.from(document.querySelectorAll(selector)));
  } finally {
    window.Element.prototype.querySelectorAll = original;
  }
  assert.equal(registry.list().length, 3);
  assert.deepEqual(scanned, [outer, moved], 'inner rides with outer; the moved one is scanned where it is now');
  outer.remove();
  moved.remove();
});

test('a registry tells its subscribers when an element joins or leaves', async (t) => {
  const { document } = installTestDom(t);
  const { registerElements } = await import('./element-registry.ts');
  const registry = registerElements('.mx-dialog-layer', ['class']);
  let calls = 0;
  const stop = registry.subscribe(() => {
    calls += 1;
  });
  const layer = document.createElement('div');
  document.body.append(layer);
  registry.list();
  assert.equal(calls, 0, 'an unrelated mount');
  layer.className = 'mx-dialog-layer';
  registry.list();
  assert.equal(calls, 1, 'joined in place');
  layer.remove();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2, 'left: reported by the observer without a read');
  stop();
  document.body.append(layer);
  registry.list();
  assert.equal(calls, 2, 'unsubscribed');
});

test("the pet's floating layers come from the registry: document order, in-place role flips, no document query per publish", async (t) => {
  const { window, document } = installTestDom(t, { expose: ['HTMLElement'] });
  const { floatingLayers } = await import('./desktop-pet-publisher');
  document.body.innerHTML = `
    <aside class="workbench-side-panel"></aside>
    <div id="menu" style="position: fixed"></div>
    <div class="mx-dialog-layer" style="position: fixed"><section role="dialog" style="position: absolute; z-index: 2"></section></div>`;
  const box = (node, rect) => {
    node.getBoundingClientRect = () => rect;
    return node;
  };
  box(document.querySelector('aside'), { left: 900, top: 0, width: 300, height: 700 });
  const menu = box(document.querySelector('#menu'), { left: 10, top: 20, width: 100, height: 50 });
  const layer = box(document.querySelector('.mx-dialog-layer'), { left: 0, top: 0, width: 1200, height: 800 });
  box(document.querySelector('[role="dialog"]'), { left: 400, top: 200, width: 400, height: 300 });
  assert.deepEqual(floatingLayers().rects, [
    { x: 900, y: 0, width: 300, height: 700 },
    { x: 0, y: 0, width: 1200, height: 800 },
    { x: 400, y: 200, width: 400, height: 300 },
  ]);
  const queries = countDocumentQueries(window, () => {
    menu.setAttribute('role', 'menu');
    assert.deepEqual(floatingLayers().rects[1], { x: 10, y: 20, width: 100, height: 50 }, 'a menu opened in place');
    layer.remove();
    assert.deepEqual(floatingLayers().rects, [
      { x: 900, y: 0, width: 300, height: 700 },
      { x: 10, y: 20, width: 100, height: 50 },
    ]);
  });
  assert.equal(queries, 0);
});
