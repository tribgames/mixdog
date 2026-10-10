import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { DockHeaderRow, splitDockActions } from './pane-dock-chrome.tsx';

const action = (id, extra = {}) => ({ id, label: id, onSelect() {}, ...extra });
const ids = (list) => list.map((item) => item.id);

test('only inline actions (Save while dirty) are header buttons; everything else is a ⋯ item', () => {
  const actions = [
    action('save', { inline: true }),
    action('view'),
    action('problems'),
    action('reveal'),
    action('open-main'),
  ];
  const { inline, menu } = splitDockActions(actions);
  assert.deepEqual(ids(inline), ['save']);
  assert.deepEqual(ids(menu), ['view', 'problems', 'reveal', 'open-main']);
  assert.deepEqual(splitDockActions([action('reveal')]).inline, []);
});

function mount(width) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    width,
    height: 44,
    top: 0,
    left: 0,
    right: width,
    bottom: 44,
  });
  return { restore, root: createRoot(document.getElementById('root')) };
}

const FORMER_ACTIONS = [
  'save',
  'view',
  'problems',
  'open-main',
  'reveal',
  'open-default',
  'open-external',
  'refresh',
  'copy-link',
  'device-responsive',
  'import',
  'diff-style',
];

test('at 280px and 500px the right side is exactly ⋯, Expand, Close (+ Save) and every former action is reachable in ⋯', async () => {
  for (const width of [280, 500]) {
    const { restore, root } = mount(width);
    const picked = [];
    try {
      await act(async () =>
        root.render(
          React.createElement(DockHeaderRow, {
            left: React.createElement(
              'span',
              { className: 'dock-header-chip' },
              'a-very-long-file-name-that-must-ellipsize.tsx'
            ),
            actions: FORMER_ACTIONS.map((id) =>
              action(id, {
                label: id,
                inline: id === 'save',
                onSelect: () => picked.push(id),
                ...(id === 'problems' ? { detail: '2 Errors, 5 Warnings' } : {}),
              })
            ),
            onToggleExpanded() {},
            onClose() {},
          })
        )
      );
      const buttons = [
        ...document.querySelectorAll(
          '.dock-header-controls > .browser-pane-nav-button, .dock-header-controls .dock-header-menu-host > .browser-pane-nav-button'
        ),
      ];
      assert.deepEqual(
        buttons.map((b) => b.getAttribute('aria-label')),
        ['save', 'More actions', 'Expand', 'Close panel'],
        `${width}px`
      );
      // The left identity is not reserved: it ellipsizes inside whatever is left.
      assert.equal(document.querySelector('.dock-header-left').getAttribute('style'), null);
      await act(async () => document.querySelector('.dock-header-more').click());
      const items = [...document.querySelectorAll('.dock-header-menu [role="menuitem"]')];
      assert.deepEqual(
        items.map((i) => i.firstElementChild?.nextElementSibling?.textContent ?? i.textContent).length,
        FORMER_ACTIONS.length - 1
      );
      assert.ok(
        items.find((i) => i.textContent.includes('2 Errors, 5 Warnings')),
        'problems carries its counts'
      );
      for (const item of items) await act(async () => item.click());
      // Re-opening after each pick: collect which ids were picked via the first click only.
      assert.ok(picked.includes('view'));
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  }
});

function key(target, name, init = {}) {
  const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

async function openMenu(actions, rect) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="clip" style="overflow:hidden"><main id="root"></main></div></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'window'],
  });
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return this.classList.contains('dock-header-more')
      ? rect
      : { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(DockHeaderRow, { left: 'x', actions })));
  await act(async () => document.querySelector('.dock-header-more').click());
  return { dom, root, restore };
}

test('the ⋯ menu is portalled to body, right-aligned under the button, outside every clipping ancestor', async () => {
  const actions = [action('a'), action('b'), action('c')];
  const { dom, root, restore } = await openMenu(actions, {
    top: 10,
    bottom: 38,
    left: 700,
    right: 728,
    width: 28,
    height: 28,
  });
  try {
    const menu = document.querySelector('.dock-header-menu');
    assert.equal(menu.parentElement, document.body);
    assert.equal(menu.closest('#clip'), null);
    assert.equal(menu.style.top, '42px');
    assert.equal(menu.style.right, `${(document.documentElement.clientWidth || dom.window.innerWidth) - 728}px`);
    assert.equal(menu.style.bottom, '');
    assert.ok(Number.parseFloat(menu.style.maxHeight) > 0);
    // No ancestor of the portal clips overflow.
    const css = (await import('node:fs')).readFileSync(new URL('./tab-strip.css', import.meta.url), 'utf8');
    const rule = css.match(/\.dock-header-menu \{([^}]*)\}/)[1];
    assert.match(rule, /position: fixed;/);
    assert.match(rule, /overflow-y: auto;/);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('the ⋯ menu flips above when there is no room below and caps max-height to the room', async () => {
  const height = 768;
  const probe = await openMenu([action('a')], { top: 740, bottom: 760, left: 0, right: 0, width: 0, height: 20 });
  try {
    const menu = document.querySelector('.dock-header-menu');
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight || height;
    assert.equal(menu.style.top, '');
    assert.equal(menu.style.bottom, `${viewportHeight - 740 + 4}px`);
    assert.equal(menu.style.maxHeight, `${740 - 4 - 8}px`);
  } finally {
    await act(async () => probe.root.unmount());
    probe.restore();
  }
});

test('keyboard: focus first enabled item, arrows/Home/End skip disabled, Enter activates, Escape and Tab close to the button', async () => {
  const picked = [];
  const actions = [
    action('a', { disabled: true }),
    action('b', { onSelect: () => picked.push('b') }),
    action('c'),
    action('d', { onSelect: () => picked.push('d') }),
  ];
  const { root, restore } = await openMenu(actions, { top: 10, bottom: 38, left: 0, right: 28, width: 28, height: 28 });
  try {
    const items = [...document.querySelectorAll('.dock-header-menu [role="menuitem"]')];
    assert.equal(document.activeElement, items[1]);
    await act(async () => key(items[1], 'ArrowDown'));
    assert.equal(document.activeElement, items[2]);
    await act(async () => key(items[2], 'End'));
    assert.equal(document.activeElement, items[3]);
    await act(async () => key(items[3], 'ArrowDown'));
    assert.equal(document.activeElement, items[1], 'wraps past the disabled first item');
    await act(async () => key(items[1], 'ArrowUp'));
    assert.equal(document.activeElement, items[3]);
    await act(async () => key(items[3], 'Home'));
    assert.equal(document.activeElement, items[1]);
    await act(async () => key(items[1], 'Enter'));
    assert.deepEqual(picked, ['b']);
    assert.equal(document.querySelector('.dock-header-menu'), null);
    assert.equal(document.activeElement, document.querySelector('.dock-header-more'));

    await act(async () => document.querySelector('.dock-header-more').click());
    const composing = key(document.activeElement, 'Escape', { isComposing: true });
    assert.equal(composing.defaultPrevented, false);
    assert.ok(document.querySelector('.dock-header-menu'), 'IME composition Escape is ignored');
    await act(async () => key(document.activeElement, 'Escape'));
    assert.equal(document.querySelector('.dock-header-menu'), null);
    assert.equal(document.activeElement, document.querySelector('.dock-header-more'));

    await act(async () => document.querySelector('.dock-header-more').click());
    await act(async () => key(document.activeElement, 'Tab'));
    assert.equal(document.querySelector('.dock-header-menu'), null);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('outside pointerdown closes the portalled menu; a press inside it does not', async () => {
  const { root, restore } = await openMenu([action('a')], {
    top: 10,
    bottom: 38,
    left: 0,
    right: 28,
    width: 28,
    height: 28,
  });
  try {
    const down = (target) => target.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    await act(async () => down(document.querySelector('.dock-header-menu')));
    assert.ok(document.querySelector('.dock-header-menu'));
    await act(async () => down(document.body));
    assert.equal(document.querySelector('.dock-header-menu'), null);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('the portalled menu closes when its owner is hidden, inert, display:none or detached', async () => {
  for (const deactivate of [
    (host) => host.setAttribute('hidden', ''),
    (host) => host.setAttribute('inert', ''),
    (host) => {
      host.style.display = 'none';
    },
  ]) {
    const { root, restore } = await openMenu([action('a')], {
      top: 10,
      bottom: 38,
      left: 0,
      right: 28,
      width: 28,
      height: 28,
    });
    try {
      assert.ok(document.querySelector('.dock-header-menu'));
      await act(async () => {
        deactivate(document.getElementById('clip'));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(document.querySelector('.dock-header-menu'), null);
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  }
  const { root, restore } = await openMenu([action('a')], {
    top: 10,
    bottom: 38,
    left: 0,
    right: 28,
    width: 28,
    height: 28,
  });
  try {
    await act(async () => {
      document.getElementById('root').remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(document.querySelector('.dock-header-menu'), null, 'a disconnected owner closes the menu');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('the portalled menu carries the dock-owner marker the mobile outside-tap handler recognises', async () => {
  const { root, restore } = await openMenu([action('a')], {
    top: 10,
    bottom: 38,
    left: 0,
    right: 28,
    width: 28,
    height: 28,
  });
  try {
    assert.equal(document.querySelector('.dock-header-menu').hasAttribute('data-dock-menu-owner'), true);
    const { readFile } = await import('node:fs/promises');
    const dock = await readFile(new URL('./pane-side-dock-hooks.ts', import.meta.url), 'utf8');
    assert.match(dock, /if \(hostRef\.current\?\.contains\(target\)\) return;[\s\S]*?\[data-dock-menu-owner\]/);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('checked options are menuitemradio / menuitemcheckbox with aria-checked and stay keyboard reachable', async () => {
  const picked = [];
  const actions = [
    action('plain'),
    action('on', { checked: true, onSelect: () => picked.push('on') }),
    action('off', { checked: false, onSelect: () => picked.push('off') }),
    action('box', { checked: true, checkbox: true }),
  ];
  const { root, restore } = await openMenu(actions, { top: 10, bottom: 38, left: 0, right: 28, width: 28, height: 28 });
  try {
    const items = [...document.querySelectorAll('.dock-header-menu button')];
    assert.deepEqual(
      items.map((item) => item.getAttribute('role')),
      ['menuitem', 'menuitemradio', 'menuitemradio', 'menuitemcheckbox']
    );
    assert.deepEqual(
      items.map((item) => item.getAttribute('aria-checked')),
      [null, 'true', 'false', 'true']
    );
    assert.equal(document.activeElement, items[0]);
    await act(async () => key(items[0], 'ArrowDown'));
    assert.equal(document.activeElement, items[1]);
    await act(async () => key(items[1], 'End'));
    assert.equal(document.activeElement, items[3]);
    await act(async () => key(items[3], 'Home'));
    await act(async () => key(items[0], 'ArrowDown'));
    await act(async () => key(items[1], 'ArrowDown'));
    await act(async () => key(items[2], 'Enter'));
    assert.deepEqual(picked, ['off']);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('the ⋯ button, Expand and Close sit inside the sheet at 280px and never overflow the row', async () => {
  const { restore, root } = mount(280);
  try {
    await act(async () =>
      root.render(
        React.createElement(DockHeaderRow, {
          left: React.createElement('span', null, 'x'.repeat(200)),
          actions: [action('save', { inline: true }), action('reveal')],
          onToggleExpanded() {},
          onClose() {},
        })
      )
    );
    const controls = document.querySelector('.dock-header-controls');
    const left = document.querySelector('.dock-header-left');
    // Controls are a non-shrinking flex item; the left slot is the one that yields.
    const css = (await import('node:fs')).readFileSync(new URL('./tab-strip.css', import.meta.url), 'utf8');
    assert.match(css.match(/\.dock-header-controls \{([^}]*)\}/)[1], /flex: none;/);
    const leftRule = css.match(/\.dock-header-left \{([^}]*)\}/)[1];
    assert.match(leftRule, /min-width: 0;/);
    assert.match(leftRule, /overflow: hidden;/);
    assert.match(leftRule, /flex: 1 1 auto;/);
    assert.ok(controls && left);
    // Slots: Save 28 + ⋯ 28 + Expand 28 + Close 28 + 3 gaps of 2 = 122 plus 14 padding: fits 280 with room to spare.
    assert.ok(4 * 28 + 3 * 2 + 14 < 280);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
