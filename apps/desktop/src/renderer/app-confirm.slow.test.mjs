// The themed confirm helper with its real dialog: focus moves in, Tab stays
// inside, the page behind is inert, Escape cancels, focus returns to the
// opener, and a repeated or concurrent ask never stacks a second dialog.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom();
const { confirmAction, alertAction } = await import('./app-confirm.tsx');

// The dialog and React load on first use (a dynamic import); load them once,
// after the DOM is installed, so that every ask below resolves within a macro
// turn and a quiet DOM really means "settled".
await Promise.all([import('react-dom/client'), import('./settings/capability-controls.tsx')]);

// Settled = two macro turns in a row that left the DOM, the focus and the
// inert marks exactly as they were (a bounded count, never a fixed delay).
const turn = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const snapshot = () =>
  `${document.body.innerHTML}|${document.activeElement?.outerHTML ?? ''}|${[...document.querySelectorAll('*')]
    .map((el) => (el.inert ? '1' : '0'))
    .join('')}`;
const settle = async () => {
  let last = snapshot();
  for (let same = 0, turns = 0; same < 2; turns++) {
    assert.ok(turns < 500, 'the DOM never came to rest');
    await turn();
    const now = snapshot();
    same = now === last ? same + 1 : 0;
    last = now;
  }
};
const dialogs = () => [...document.querySelectorAll('.settings-confirm-dialog')];
const button = (label) => [...dialogs()[0].querySelectorAll('button')].find((el) => el.textContent === label);
const keydown = (key, init = {}) =>
  act(async () => {
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    );
  });

function mountPage() {
  document.body.innerHTML = '<main id="app"><button id="opener">Delete</button></main>';
  const opener = document.getElementById('opener');
  opener.focus();
  return opener;
}

test('focus goes in (Cancel when destructive), Tab wraps, the page is inert, and focus returns to the opener', async () => {
  const opener = mountPage();
  let result;
  await act(async () => {
    result = confirmAction('Delete it?\nGone for good.', { danger: true, confirmLabel: 'Delete' });
  });
  await settle();
  assert.equal(dialogs().length, 1);
  assert.equal(document.activeElement, button('Cancel'));
  assert.equal(document.getElementById('app').inert, true);
  const stops = [...dialogs()[0].querySelectorAll('button')];
  stops.at(-1).focus();
  await keydown('Tab');
  assert.equal(document.activeElement, stops[0]);
  await keydown('Tab', { shiftKey: true });
  assert.equal(document.activeElement, stops.at(-1));
  await act(async () => button('Delete').click());
  assert.equal(await result, true);
  await settle();
  assert.equal(dialogs().length, 0);
  assert.ok(!document.getElementById('app').inert);
  assert.equal(document.activeElement, opener);
});

test('a non-destructive ask focuses its primary action; Escape cancels and restores focus', async () => {
  const opener = mountPage();
  let result;
  await act(async () => {
    result = confirmAction('Continue?\nSure.');
  });
  await settle();
  assert.equal(document.activeElement, button('Continue'));
  await keydown('Escape');
  assert.equal(await result, false);
  await settle();
  assert.equal(document.activeElement, opener);
});

test('different actions with the same text both show, queue, and run independently', async () => {
  const opener = mountPage();
  const ran = [];
  let a;
  let b;
  await act(async () => {
    a = confirmAction('Delete it?\nSure.', { danger: true, key: 'x:1' }).then((ok) => ok && ran.push('x:1'));
    b = confirmAction('Delete it?\nSure.', { danger: false, key: 'x:2' }).then((ok) => ok && ran.push('x:2'));
  });
  await settle();
  assert.equal(dialogs().length, 1, 'one dialog at a time');
  const firstId = dialogs()[0].getAttribute('aria-labelledby');
  await act(async () => button('Cancel').click());
  await a;
  await settle();
  assert.equal(dialogs().length, 1, 'the queued ask shows next');
  assert.notEqual(dialogs()[0].getAttribute('aria-labelledby'), firstId);
  assert.equal(document.querySelectorAll(`[id="${dialogs()[0].getAttribute('aria-labelledby')}"]`).length, 1);
  assert.equal(document.activeElement, button('Continue'));
  await act(async () => button('Continue').click());
  await b;
  await settle();
  assert.deepEqual(ran, ['x:2']);
  assert.equal(dialogs().length, 0);
  assert.equal(document.activeElement, opener);
});

test('a keyed double click opens one dialog and its action runs once; the duplicate resolves false', async () => {
  mountPage();
  let runs = 0;
  const click = () =>
    confirmAction('Discard all?\nNo undo.', { danger: true, key: 'discard-all:/repo' }).then((ok) => {
      if (ok) runs += 1;
    });
  let first;
  let second;
  await act(async () => {
    first = click();
    second = click();
  });
  await settle();
  assert.equal(dialogs().length, 1);
  assert.equal(await confirmAction('x', { key: 'discard-all:/repo' }), false);
  await act(async () => button('Continue').click());
  await Promise.all([first, second]);
  assert.equal(runs, 1);
  await settle();
  // The key is free again once the first request settled.
  await act(async () => {
    first = click();
  });
  await settle();
  assert.equal(dialogs().length, 1);
  await keydown('Escape');
  await first;
  assert.equal(runs, 1);
});

test('scrim and Escape both cancel and clean up', async () => {
  const opener = mountPage();
  let result;
  await act(async () => {
    result = confirmAction('Delete it?\nSure.', { danger: true });
  });
  await settle();
  await act(async () => {
    const layer = document.querySelector('.settings-confirm-layer');
    layer.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    layer.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(await result, false);
  await settle();
  assert.equal(dialogs().length, 0);
  assert.ok(!document.getElementById('app').inert);
  assert.equal(document.activeElement, opener);
});

test('a disabled opener falls back to the focused pane composer, then another visible one, else nothing', async () => {
  mountPage();
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="pane-cell"><form class="composer"><textarea id="other"></textarea></form></div>
     <div class="pane-cell is-focused"><form class="composer"><textarea id="focused"></textarea></form></div>
     <div class="pane-cell"><form class="composer"><textarea id="hidden"></textarea></form></div>`
  );
  const shown = new Set(['other', 'focused']);
  for (const el of document.querySelectorAll('textarea')) {
    el.getClientRects = () => (shown.has(el.id) ? [{}] : []);
  }
  const closeWith = async () => {
    let result;
    await act(async () => {
      result = confirmAction('Delete it?\nSure.', { danger: true });
    });
    await settle();
    await keydown('Escape');
    await result;
    await settle();
  };
  document.getElementById('opener').disabled = true;
  await closeWith();
  assert.equal(document.activeElement.id, 'focused');
  document.getElementById('focused').disabled = true;
  document.getElementById('opener').focus?.();
  await closeWith();
  assert.equal(document.activeElement.id, 'other');
  document.getElementById('other').disabled = true;
  document.body.focus();
  await closeWith();
  assert.notEqual(document.activeElement?.tagName, 'TEXTAREA');
});

for (const order of ['surface first', 'confirm first']) {
  test(`a modal-layer surface under a confirm (${order}) leaves nothing inert and toasts stay live`, async () => {
    mountPage();
    document.body.insertAdjacentHTML('beforeend', '<div class="mx-toast-region"></div><div id="surface"><input></div>');
    const { acquireModalLayer } = await import('./modal-layer.ts');
    const shell = document.getElementById('app');
    const surface = document.getElementById('surface');
    const layer = acquireModalLayer([shell]);
    layer.attachSurface(surface);
    assert.equal(shell.inert, true);
    assert.ok(!surface.inert);
    let result;
    await act(async () => {
      result = confirmAction('Delete it?\nSure.', { danger: true });
    });
    await settle();
    assert.equal(surface.inert, true, 'the confirm on top locks the surface under it');
    assert.ok(!document.querySelector('.mx-toast-region').inert);
    if (order === 'surface first') {
      layer.release();
      assert.equal(shell.inert, true, 'the confirm still locks the page');
      await keydown('Escape');
      await result;
    } else {
      await keydown('Escape');
      await result;
      await settle();
      assert.equal(shell.inert, true, 'the surface still locks the page');
      assert.ok(!surface.inert);
      layer.release();
    }
    await settle();
    assert.equal(document.querySelectorAll('[inert]').length, 0);
    for (const element of [shell, surface, document.querySelector('.mx-toast-region')]) {
      assert.equal(element.getAttribute('aria-hidden'), null);
    }
    assert.ok(!document.querySelector('.mx-toast-region').inert);
  });
}

const hostIn = () => {
  const host = document.createElement('div');
  host.innerHTML = '<button>in</button>';
  document.body.append(host);
  return host;
};
const inertCount = () => document.querySelectorAll('[inert]').length;

for (const order of ['open A, open B; close A then B', 'open A, open B; close B then A']) {
  test(`nested modals (${order}) leave nothing inert and toasts stay live`, async () => {
    mountPage();
    document.body.insertAdjacentHTML('beforeend', '<div class="mx-toast-region"></div>');
    const { openModal } = await import('./settings/dialog-modality.ts');
    const hostA = hostIn();
    const hostB = hostIn();
    const closeA = openModal(hostA);
    const closeB = openModal(hostB);
    const toast = document.querySelector('.mx-toast-region');
    assert.ok(!toast.inert);
    assert.ok(!hostB.inert, 'the top modal is live');
    assert.equal(hostA.inert, true, 'the modal under it is inert');
    if (order.includes('A then B')) {
      closeA();
      assert.ok(!hostB.inert);
      assert.equal(document.getElementById('app').inert, true, 'still locked while B is open');
      closeB();
    } else {
      closeB();
      assert.ok(!hostA.inert);
      assert.equal(document.getElementById('app').inert, true);
      closeA();
    }
    closeA();
    assert.equal(inertCount(), 0);
    assert.ok(!toast.inert);
    assert.equal(document.querySelectorAll('[aria-hidden]').length, 0);
  });
}

test('a modal opened during a confirm does not inert itself, and closing it re-locks only the page', async () => {
  mountPage();
  let result;
  await act(async () => {
    result = confirmAction('Delete it?\nSure.', { danger: true });
  });
  await settle();
  const { openModal } = await import('./settings/dialog-modality.ts');
  const layer = document.querySelector('.settings-confirm-layer');
  const host = hostIn();
  const close = openModal(host);
  assert.ok(!host.inert);
  assert.equal(layer.parentElement.inert, true);
  close();
  assert.ok(!layer.parentElement.inert);
  assert.equal(document.getElementById('app').inert, true);
  await keydown('Escape');
  await result;
  await settle();
  assert.equal(inertCount(), 0);
});

test('an alert has one Close button and resolves', async () => {
  mountPage();
  let done = false;
  await act(async () => {
    void alertAction('Nothing to delete.').then(() => {
      done = true;
    });
  });
  await settle();
  assert.deepEqual(
    [...dialogs()[0].querySelectorAll('footer button')].map((el) => el.textContent),
    ['Close']
  );
  await act(async () => button('Close').click());
  await settle();
  assert.equal(done, true);
});

test('a dropdown portaled while a modal is open is live, locked only under a nested confirm; a background one stays inert', async () => {
  mountPage();
  const background = document.createElement('div');
  background.className = 'background-menu';
  document.body.append(background);
  const { openModal } = await import('./settings/dialog-modality.ts');
  const host = hostIn();
  const close = openModal(host);
  const dropdown = document.createElement('div');
  dropdown.className = 'mx-menu';
  document.body.append(dropdown);
  assert.ok(!dropdown.inert, 'the modal-owned dropdown is live');
  assert.equal(background.inert, true, 'a dropdown from the background is inert');
  let result;
  await act(async () => {
    result = confirmAction('Delete it?\nSure.', { danger: true });
  });
  await settle();
  assert.equal(dropdown.inert, true, 'locked while the confirm is on top');
  await keydown('Escape');
  await result;
  await settle();
  assert.ok(!dropdown.inert, 'live again after the confirm closes');
  assert.equal(dropdown.getAttribute('aria-hidden'), null);
  assert.equal(background.inert, true);
  close();
  assert.equal(document.querySelectorAll('[inert]').length, 0);
  background.remove();
  dropdown.remove();
});

test('a banner that appears during a confirm is inert and unfocusable, and live after it closes', async () => {
  mountPage();
  let result;
  await act(async () => {
    result = confirmAction('Delete it?\nSure.', { danger: true });
  });
  await settle();
  const banner = document.createElement('div');
  banner.setAttribute('data-modal-background', '');
  banner.innerHTML = '<button>Retry</button>';
  document.body.append(banner);
  await settle();
  assert.equal(banner.inert, true);
  assert.equal(banner.getAttribute('aria-hidden'), 'true');
  const unmarked = document.createElement('div');
  document.body.append(unmarked);
  await settle();
  assert.ok(!unmarked.inert, 'only marked background UI is locked');
  await keydown('Escape');
  await result;
  await settle();
  assert.ok(!banner.inert);
  assert.equal(banner.getAttribute('aria-hidden'), null);
  banner.remove();
  unmarked.remove();
});
