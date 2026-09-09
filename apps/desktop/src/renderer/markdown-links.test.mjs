import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import MarkdownBody from './MarkdownBody';
import MarkdownAstBody from './MarkdownAstBody';
import { parseMarkdownToHast } from './markdown-ast';
import { MarkdownProjectContext } from './MarkdownLink';
import { DESKTOP_TOAST_EVENT } from './desktop-toasts';

const CopyControl = () => null;
const renderers = {
  settled: (text) => React.createElement(MarkdownBody, { text, copyControl: CopyControl }),
  worker: (text) => React.createElement(MarkdownAstBody, {
    root: parseMarkdownToHast(text), copyControl: CopyControl,
  }),
};

async function mount(t, render, text, project = 'C:/Project/conversation') {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/' });
  const previous = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const local = [];
  const external = [];
  const popups = [];
  const toasts = [];
  dom.window.mixdogDesktop = {
    openLocalFileLink: async (...args) => { local.push(args); },
    openExternal: async (...args) => { external.push(args); },
  };
  dom.window.open = (...args) => { popups.push(args); };
  dom.window.addEventListener(DESKTOP_TOAST_EVENT, (event) => toasts.push(event.detail));
  const update = async (nextProject) => act(async () => {
    root.render(React.createElement(MarkdownProjectContext.Provider,
      { value: nextProject }, render(text)));
  });
  await update(project);
  const links = () => [...dom.window.document.querySelectorAll('a')];
  const click = async (index = 0, options = {}, type = 'click') => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...options });
    await act(async () => { links()[index].dispatchEvent(event); });
    return event;
  };
  return { dom, local, external, popups, toasts, links, click, update };
}

for (const [pipeline, render] of Object.entries(renderers)) {
  test(`${pipeline}: the three delivery links open in the owning conversation's Project`, async (t) => {
    const paths = [
      'output/ai-work-proposal-20260907/ai-work-proposal-delivery.pptx',
      'output/ai-work-proposal-20260907/ai-work-proposal-delivery.mixdog-preview.pdf',
      'output/ai-work-proposal-20260907/verification-summary.md',
    ];
    const f = await mount(t, render, paths.map((path, index) => `[file ${index}](${path})`).join('\n\n'));
    for (let index = 0; index < paths.length; index++) {
      assert.equal((await f.click(index)).defaultPrevented, true);
    }
    assert.deepEqual(f.local, paths.map((path) => ['C:/Project/conversation', path]));
    await f.update('D:/Project/other-conversation');
    await f.click();
    assert.deepEqual(f.local.at(-1), ['D:/Project/other-conversation', paths[0]]);
    assert.equal(f.external.length + f.popups.length + f.toasts.length, 0);
  });

  test(`${pipeline}: absolute paths and file URLs survive URL sanitizing and use the file opener`, async (t) => {
    const f = await mount(t, render, [
      '[drive](C:/Project/conversation/output/deck.pptx)',
      '[backslashes](<C:\\Project\\conversation\\output\\deck.pptx>)',
      '[file](file:///C:/Project/conversation/output/preview.pdf)',
      '[posix](/home/user/project/report.md)',
    ].join('\n\n'));
    for (let index = 0; index < 4; index++) {
      assert.ok(f.links()[index].getAttribute('href'));
      assert.equal((await f.click(index)).defaultPrevented, true);
      assert.equal(f.local.at(-1)[1], f.links()[index].getAttribute('href'));
    }
    assert.equal(f.local.length, 4);
    assert.equal(f.external.length, 0);
  });

  test(`${pipeline}: local errors, absent desktop support and absent Project are visible, never navigated`, async (t) => {
    const f = await mount(t, render, '[file](output/deck.pptx)');
    f.dom.window.mixdogDesktop.openLocalFileLink = async () => { throw new Error('ENOENT: missing file'); };
    assert.equal((await f.click()).defaultPrevented, true);
    assert.match(f.toasts.at(-1).text, /ENOENT: missing file/);
    delete f.dom.window.mixdogDesktop.openLocalFileLink;
    await f.click();
    assert.equal(f.toasts.length, 2);
    f.dom.window.mixdogDesktop.openLocalFileLink = async (...args) => { f.local.push(args); };
    await f.update('');
    await f.click();
    assert.equal(f.toasts.length, 3);
    assert.ok(f.toasts.every((toast) => toast.tone === 'error' && toast.text));
    assert.equal(f.local.length + f.popups.length, 0);
  });

  test(`${pipeline}: local modified and auxiliary clicks cannot navigate the app`, async (t) => {
    const f = await mount(t, render, '[file](output/deck.pptx)');
    assert.equal((await f.click(0, { ctrlKey: true })).defaultPrevented, true);
    assert.equal((await f.click(0, { button: 1 }, 'auxclick')).defaultPrevented, true);
    assert.equal(f.local.length, 1);
    assert.equal(f.popups.length, 0);
  });

  test(`${pipeline}: web links retain browser handling and dangerous schemes stay sanitized`, async (t) => {
    const f = await mount(t, render, [
      '[web](https://example.com/report)',
      '[www](www.example.com)',
      '[unsafe](javascript:alert%281%29)',
      '[data](data:text/html,test)',
      '![local image](file:///C:/private/secret.png)',
    ].join('\n\n'));
    assert.equal((await f.click()).defaultPrevented, true);
    await f.click(1);
    assert.deepEqual(f.external, [['https://example.com/report'], ['https://www.example.com']]);
    assert.equal(f.local.length, 0);
    assert.equal(f.links()[2].getAttribute('href'), '');
    assert.equal(f.links()[3].getAttribute('href'), '');
    assert.notEqual(f.dom.window.document.querySelector('img')?.getAttribute('src'),
      'file:///C:/private/secret.png');
    f.dom.window.mixdogDesktop.openExternal = async () => { throw new Error('browser unavailable'); };
    await f.click();
    assert.deepEqual(f.popups, [['https://example.com/report', '_blank', 'noopener']]);
  });
}
