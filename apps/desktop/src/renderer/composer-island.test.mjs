import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { ComposerDock } from './ComposerDock.tsx';
import { QueueList } from './composer-support.tsx';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { t as translate } from './i18n.ts';

function mount(t) {
  const { dom, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent'],
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.mixdogDesktop = {};
  t.after(() => defaultSessionLaneStore.clear());
  return { root, document: dom.window.document, window: dom.window };
}

const dockProps = (overrides = {}) => ({
  sessionId: 'island-session',
  goalSubmissionId: '',
  showProjectSelector: false,
  reviewItems: [],
  reviewActive: true,
  reviewBusy: false,
  reviewSessionId: '',
  reviewCwd: '',
  children: React.createElement('form', { className: 'composer' }),
  ...overrides,
});

const publish = (snapshot) =>
  act(async () => {
    defaultSessionLaneStore.apply({
      sessionId: 'island-session',
      snapshot: { sessionId: 'island-session', ...snapshot },
    });
  });

test('a draft keeps its context bar; a session reserves the island slot even when empty', async (t) => {
  const { root, document } = mount(t);
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps({ sessionId: '', showProjectSelector: true }),
        contextBar: React.createElement('span', { id: 'context' }),
      })
    )
  );
  assert.ok(document.querySelector('.composer-context-bar #context'));
  assert.equal(document.querySelector('.composer-island-slot'), null);
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  assert.equal(document.querySelector('.composer-context-bar'), null);
  const slot = document.querySelector('.composer-island-slot');
  assert.ok(slot);
  assert.equal(document.querySelectorAll('.composer-island-seg').length, 0, 'nothing to carry, no segment');
  // Order: the slot sits above the queue tray, which sits above the input.
  const children = [...document.querySelector('.composer-region').children].map((node) => node.className);
  assert.deepEqual(children, ['composer-island-slot', 'composer-queue-tray', 'composer']);
});

test('background jobs show as one segment, expand to rows, collapse on Escape and flash when done', async (t) => {
  const { root, document, window } = mount(t);
  await publish({
    shellJobs: { count: 1, jobs: [{ taskId: 'job-1', command: 'npm test', startedAt: Date.now() - 5_000 }] },
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  const segment = document.querySelector('.composer-island-seg');
  assert.equal(segment.textContent, translate('Jobs {{count}}', { count: 1 }));
  // Running work is a pulsing dot, not a spinner.
  assert.ok(segment.querySelector('.composer-island-pulse'));
  assert.equal(segment.querySelector('svg'), null);
  await act(async () => segment.click());
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'panel');
  const rows = [...document.querySelectorAll('.composer-island-row')];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].querySelector('.composer-island-pulse'));
  assert.equal(rows[0].querySelector('svg'), null);
  assert.match(rows[0].textContent, /npm test/);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill');
  await publish({ shellJobs: { count: 0, jobs: [] } });
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'flash');
  assert.equal(
    document.querySelector('.composer-island-flash[role="status"]').textContent,
    translate('Background task finished')
  );
});

test('a pending approval takes over the island; a flash notice replaces any leftover card', async (t) => {
  const { root, document } = mount(t);
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps(),
        approval: React.createElement('article', { className: 'approval-card' }),
      })
    )
  );
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'approval');
  assert.ok(document.querySelector('.composer-island-approval > .approval-card'));
  assert.equal(document.querySelector('.composer-island-pill').hidden, true);
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps(),
        islandFlash: { key: 'elsewhere:1', text: 'Resolved on another device' },
      })
    )
  );
  assert.equal(document.querySelector('.approval-card'), null);
  assert.equal(document.querySelector('.composer-island-flash').textContent, 'Resolved on another device');
});

test('a model mismatch segment offers revert and continue', async (t) => {
  const { root, document } = mount(t);
  const calls = [];
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps(),
        modelMismatch: {
          sessionModel: 'Claude',
          selectedModel: 'Gemini',
          onRevert: () => calls.push('revert'),
          onContinue: () => calls.push('continue'),
        },
      })
    )
  );
  const segment = document.querySelector('.composer-island-seg-model');
  assert.equal(segment.textContent, translate('Continuing in {{model}}', { model: 'Claude' }));
  // A dot marks the mismatch, not a warning glyph.
  assert.ok(segment.querySelector('.composer-island-dot'));
  assert.equal(segment.querySelector('svg'), null);
  await act(async () => segment.click());
  assert.equal(document.querySelector('.composer-island-model svg'), null, 'the panel header has no glyph');
  const buttons = [...document.querySelectorAll('.composer-island-model button')];
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    [translate('Revert'), translate('Continue in {{model}}', { model: 'Gemini' })]
  );
  await act(async () => buttons[0].click());
  await act(async () => buttons[1].click());
  assert.deepEqual(calls, ['revert', 'continue']);
});

test('queued follow-up rows read icon, text, then Steer now, trash and a menu whose Edit edits', async (t) => {
  const { root, document } = mount(t);
  const edits = [];
  await act(async () =>
    root.render(
      React.createElement(QueueList, {
        queued: [{ id: 'q1', displayText: 'report coverage too' }],
        restoring: false,
        onEdit: (id) => edits.push(id),
        onSteer() {},
        onRemove() {},
      })
    )
  );
  const row = document.querySelector('.queue-item');
  assert.deepEqual(
    [...row.children].map((node) => node.getAttribute('class')),
    [
      'lucide lucide-corner-down-right queue-item-icon',
      'queue-item-text',
      'queue-steer',
      'queue-remove',
      'row-overflow',
    ]
  );
  const text = row.querySelector('.queue-item-text');
  assert.equal(text.textContent, 'report coverage too');
  assert.equal(text.dataset.tooltip, 'report coverage too', 'the full message is in the tooltip');
  assert.equal(text.tabIndex, 0, 'focus reaches the tooltip too');
  const steer = row.querySelector('.queue-steer');
  assert.equal(steer.textContent, translate('Steer now'));
  assert.equal(steer.querySelector('svg'), null);
  assert.ok(row.querySelector('.queue-remove svg'), 'Remove is a trash icon');
  assert.equal(row.querySelector('.queue-remove').textContent, '');
  // No standalone Edit button; Edit lives in the ⋯ menu.
  assert.equal([...row.querySelectorAll('button')].filter((b) => b.textContent === translate('Edit')).length, 0);
  await act(async () => row.querySelector('.row-overflow-trigger').click());
  const items = [...document.querySelectorAll('.row-overflow-menu [role="menuitem"]')];
  assert.deepEqual(
    items.map((item) => item.textContent),
    [translate('Edit')]
  );
  await act(async () => items[0].click());
  assert.deepEqual(edits, ['q1']);
  assert.equal(document.querySelector('.row-overflow-menu'), null, 'the menu closes after Edit');
});
