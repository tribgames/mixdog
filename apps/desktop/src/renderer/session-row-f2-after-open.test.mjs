import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act, useRef, useState } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

test('F2 renames the session row right after the first click opened its session', async () => {
  const { dom, restore } = installTestDom(null, {
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'CustomEvent', 'HTMLElement', 'Element'],
    globals: { navigator: { userAgent: 'Electron', maxTouchPoints: 0 } },
  });
  window.HTMLElement.prototype.attachEvent ??= () => {};
  window.HTMLElement.prototype.detachEvent ??= () => {};
  window.mixdogDesktop = {};
  window.matchMedia = () => ({ matches: false });
  document.hasFocus = () => true;
  const { createRoot } = await import('react-dom/client');
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const { useComposerFocus } = await import('./use-composer-focus.ts');
  const root = createRoot(document.getElementById('root'));
  const session = {
    id: 'f2-session',
    title: 'Rename me',
    preview: 'Original prompt',
    updatedAt: 1,
    activityAt: 1,
    messageCount: 1,
    cwd: '',
    classification: 'task',
    projectPath: null,
    working: false,
  };
  const other = { ...session, id: 'f2-other', title: 'Other session' };
  // Opening a session mounts its conversation, whose composer asks for focus.
  function Composer({ sessionId, paneActive }) {
    const textarea = useRef(null);
    useComposerFocus({ textarea, transitioning: false, focusRequest: 0, paneActive });
    return React.createElement(
      'form',
      { className: 'composer', 'data-composer-session-id': sessionId },
      React.createElement('textarea', { ref: textarea })
    );
  }
  let showSplit;
  function App() {
    const [opened, setOpened] = useState(false);
    const [split, setSplit] = useState(false);
    showSplit = () => setSplit(true);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(SessionSidebar, {
        open: true,
        sessions: [session, other],
        sessionsReady: true,
        selection: opened ? { kind: 'session', id: session.id } : { kind: 'new' },
        onNewTask() {},
        onResumeSession: () => setOpened(true),
        async onRenameSession() {},
        async onArchiveSession() {},
        async onDeleteSession() {},
      }),
      opened ? React.createElement(Composer, { sessionId: session.id, paneActive: true }) : null,
      split ? React.createElement(Composer, { sessionId: other.id, paneActive: false }) : null
    );
  }
  try {
    await act(async () => root.render(React.createElement(App)));
    const row = document.querySelector('[data-session-id="f2-session"]');
    const main = row.querySelector('.session-row-main');
    await act(async () => {
      main.focus();
      main.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, button: 0 }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const composer = document.querySelector('form.composer textarea');
    assert.ok(composer, 'the click opened the session');
    assert.equal(document.activeElement, composer, 'the composer keeps its auto-focus after the click');
    const input = row.querySelector('.session-title-input');
    const press = (target, init) =>
      act(async () => {
        target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F2', bubbles: true, ...init }));
      });

    await press(composer, { isComposing: true });
    await press(composer, { ctrlKey: true });
    await press(composer, { shiftKey: true });
    assert.equal(input.disabled, true, 'IME composition and modified F2 do not rename');
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    await press(field);
    assert.equal(input.disabled, true, 'F2 in another text field does not rename');
    field.remove();

    // Split pane: keyboard focus is in B's composer while A stays selected.
    await act(async () => showSplit());
    const otherRow = document.querySelector('[data-session-id="f2-other"]');
    const otherInput = otherRow.querySelector('.session-title-input');
    const otherComposer = document.querySelector('form[data-composer-session-id="f2-other"] textarea');
    otherComposer.focus();
    await press(otherComposer);
    assert.equal(otherInput.disabled, false, 'F2 in B composer renames B');
    assert.equal(input.disabled, true, 'F2 in B composer never renames A');
    composer.focus();
    await act(async () => {});
    assert.equal(otherInput.disabled, true);

    composer.focus();
    await press(composer);
    assert.equal(input.disabled, false);
    assert.equal(document.activeElement, input);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
