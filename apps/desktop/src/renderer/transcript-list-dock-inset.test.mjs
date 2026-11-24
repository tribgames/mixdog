import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

test('a viewport an earlier list left an inset on is given the inset the dock covers now, none included', async () => {
  const { restore } = installTestDom(null, {
    html:
      "<div id='root'></div><section class='conversation'><div class='transcript-shell'>" +
      "<div class='transcript' style='--transcript-dock-inset: 110px'></div></div></section>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element', 'HTMLElement'],
  });
  try {
    const [React, { createRoot }, { useDockInset, transcriptDockInset }] = await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('./transcript-list-dock-inset.ts'),
    ]);
    const view = document.querySelector('.transcript');
    // The dock is gone: the shell ends where the viewport does.
    const rect = { left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 };
    view.getBoundingClientRect = () => rect;
    view.parentElement.getBoundingClientRect = () => rect;
    const instance = { options: { paddingEnd: 24, anchorTo: 'start', followOnAppend: false }, notify() {} };
    let changes = 0;
    function Harness() {
      useDockInset({
        viewport: { current: view },
        spacer: React.useRef(null),
        virtualizerRef: { current: instance },
        bottomInset: React.useRef(0),
        onChange: () => {
          changes += 1;
        },
      });
      return null;
    }
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(Harness)));
    await React.act(async () => {});
    assert.equal(transcriptDockInset(view), 0, 'the inset left by the earlier list is not kept');
    assert.equal(view.style.getPropertyValue('--transcript-dock-inset'), '0px');
    assert.equal(changes, 0, "the list's own extent did not change");
    await React.act(async () => root.unmount());
  } finally {
    restore();
  }
});
