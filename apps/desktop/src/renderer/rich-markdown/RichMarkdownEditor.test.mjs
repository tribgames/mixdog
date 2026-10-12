import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';
import { createTestModel } from './rich-markdown-test-model.mjs';

const PROJECT = 'C:/Project/notes';
const FRONT = '---\ntitle: Guide\ntags: [docs]\n---\n';
const BODY = [
  '# Guide',
  '',
  '* first',
  '* second',
  '',
  'See [setup](setup.md#L3), [web](https://example.com) and [top](#guide).',
  '',
  '## Details',
  '',
  'Some __bold__ text.',
  '',
].join('\n');

const settle = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

async function mount(t, text, props = {}) {
  // Restored by hand: the editor finishes tearing down on a timer after
  // unmount, and that must still see the window.
  const { dom, root, restore } = installTestDom(null, {
    rootId: 'root',
    jsdom: { pretendToBeVisual: true },
    expose: [
      'Node',
      'Element',
      'HTMLElement',
      'Text',
      'DocumentFragment',
      'DOMParser',
      'MutationObserver',
      'getComputedStyle',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'KeyboardEvent',
      'MouseEvent',
      'Event',
    ],
  });
  t.after(async () => {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    restore();
  });
  const external = [];
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.mixdogDesktop = { openExternal: async (url) => external.push(url) };
  dom.window.document.elementFromPoint = () => null;
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
  });
  const model = createTestModel(text);
  const calls = { save: 0, opened: [], unsupported: [] };
  const { default: RichMarkdownEditor } = await import('./RichMarkdownEditor.tsx');
  const modelRef = { current: model };
  const render = async (overrides = {}) =>
    act(async () => {
      root.render(
        React.createElement(RichMarkdownEditor, {
          modelRef,
          text: model.getValue(),
          projectPath: PROJECT,
          relPath: 'docs/guide.md',
          readOnly: false,
          active: true,
          onSave: () => calls.save++,
          onOpenFile: (...args) => calls.opened.push(args),
          onUnsupported: (reason) => calls.unsupported.push(reason),
          ...props,
          ...overrides,
        })
      );
    });
  await render();
  await settle();
  const doc = dom.window.document;
  const content = () => doc.querySelector('.rich-markdown-content');
  const editor = () => content().editor;
  /** Leaves Rich (another view mode takes its place). */
  const leave = () => act(async () => root.render(null));
  return { dom, doc, model, calls, render, leave, content, editor, external };
}

test('the document renders as rich content with real headings and a front matter banner, without writing', async (t) => {
  const f = await mount(t, FRONT + BODY);
  assert.deepEqual(
    [...f.content().querySelectorAll('h1, h2')].map((heading) => [heading.tagName, heading.textContent]),
    [
      ['H1', 'Guide'],
      ['H2', 'Details'],
    ]
  );
  assert.equal(f.content().querySelectorAll('ul > li').length, 2);
  const banner = f.doc.querySelector('.rich-markdown-frontmatter');
  assert.match(banner.textContent, /Front matter/);
  assert.match(banner.textContent, /title, tags/);
  assert.equal(f.content().textContent.includes('title: Guide'), false);
  await settle(400);
  assert.equal(f.model.edits.length, 0, 'opening never writes');
  assert.equal(f.model.getValue(), FRONT + BODY);
  assert.deepEqual(f.calls.unsupported, []);
});

test('a user edit is written back to the model as a minimal change', async (t) => {
  const f = await mount(t, FRONT + BODY);
  const editor = f.editor();
  await act(async () => {
    let end = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === ' text.') end = pos + node.nodeSize;
    });
    editor
      .chain()
      .insertContentAt(end - 1, ' now')
      .run();
  });
  await settle(400);
  assert.equal(f.model.getValue(), FRONT + BODY.replace('Some __bold__ text.', 'Some **bold** text now.'));
  assert.equal(f.model.edits.length, 1);
  assert.ok(f.model.edits[0].start > (FRONT + BODY).indexOf('* second'), 'untouched blocks are not rewritten');
});

test('a Rich edit reaches the model at once, so a change made elsewhere right after cannot lose it', async (t) => {
  const f = await mount(t, '# Hello\n\nBody.\n');
  await act(async () => {
    f.editor().chain().insertContentAt(1, 'LOCAL ').run();
  });
  assert.equal(f.model.getValue(), '# LOCAL Hello\n\nBody.\n', 'no delay: the model and its dirty state have the edit');
  // Source or another view edits the same model immediately afterwards.
  await act(async () => {
    f.model.pushEditOperations(
      [],
      [{ range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: 'External. ' }],
      () => null
    );
  });
  await f.render({ text: f.model.getValue() });
  await settle(400);
  assert.equal(f.model.getValue(), '# LOCAL Hello\n\nExternal. Body.\n');
  assert.equal(f.content().querySelector('h1').textContent, 'LOCAL Hello');
  assert.match(f.content().textContent, /External\. Body\./);
});

test('undo runs on the model history: across leaving Rich, from the keyboard, and from Source', async (t) => {
  const f = await mount(t, BODY);
  await act(async () => {
    f.editor().chain().insertContentAt(1, 'My ').run();
  });
  const edited = f.model.getValue();
  assert.match(edited, /^# My Guide\n/);
  await f.leave();
  await f.render();
  await settle();
  const button = (label) => f.doc.querySelector(`.rich-markdown-toolbar button[aria-label="${label}"]`);
  assert.equal(button('Undo').disabled, false, 'the edit is still undoable after coming back');
  await act(async () => button('Undo').click());
  assert.equal(f.model.getValue(), BODY);
  assert.equal(f.content().querySelector('h1').textContent, 'Guide');
  assert.equal(button('Redo').disabled, false);
  await act(async () => {
    f.content().dispatchEvent(
      new f.dom.window.KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  assert.equal(f.model.getValue(), edited);
  assert.equal(f.content().querySelector('h1').textContent, 'My Guide');
  // Ctrl+Z in Source undoes the same model.
  await f.leave();
  await act(async () => f.model.undo());
  assert.equal(f.model.getValue(), BODY);
  await f.render();
  assert.equal(f.content().querySelector('h1').textContent, 'Guide');
});

test('undo and redo put the caret where the undone or redone edit was', async (t) => {
  const f = await mount(t, 'First paragraph here.\n\nSecond paragraph, much longer than the first one.\n');
  const editor = f.editor();
  await act(async () => {
    editor.chain().insertContentAt(7, 'NEW ').run();
  });
  assert.match(f.model.getValue(), /^First NEW paragraph/);
  // The caret moves away, to the end of the second paragraph.
  await act(async () => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  });
  const history = (inputType) =>
    act(async () => {
      f.content().dispatchEvent(
        new f.dom.window.InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true })
      );
    });
  await history('historyUndo');
  assert.equal(f.model.getValue(), 'First paragraph here.\n\nSecond paragraph, much longer than the first one.\n');
  assert.deepEqual([editor.state.selection.from, editor.state.selection.to], [7, 7]);
  await history('historyRedo');
  assert.match(f.model.getValue(), /^First NEW paragraph/);
  assert.deepEqual([editor.state.selection.from, editor.state.selection.to], [11, 11]);
});

test('an edit the file cannot take yet stays in Rich with a notice; saving waits until it is discarded', async (t) => {
  const original = '| A |\n| --- |\n| one |\n';
  const held = [];
  const f = await mount(t, original, { onHeldChange: (value) => held.push(value) });
  const editor = f.editor();
  let cellEnd = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell') cellEnd = pos + node.nodeSize - 1;
  });
  // Two paragraphs in one cell: Markdown has no way to write that.
  await act(async () => {
    editor
      .chain()
      .insertContentAt(cellEnd, { type: 'paragraph', content: [{ type: 'text', text: 'two' }] })
      .run();
  });
  const notice = () => f.doc.querySelector('.rich-markdown-held');
  assert.ok(notice(), 'the notice shows at once');
  assert.equal(notice().getAttribute('role'), 'alert');
  assert.deepEqual(held, [true]);
  assert.equal(f.model.getValue(), original);
  assert.match(f.content().textContent, /two/, 'the edit is still in the editor');
  await act(async () => {
    f.content().dispatchEvent(
      new f.dom.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    );
  });
  assert.equal(f.calls.save, 0, 'saving would leave the edit out: it waits');
  assert.deepEqual(f.calls.unsupported, []);
  await act(async () => notice().querySelector('button').click());
  assert.equal(notice(), null);
  assert.deepEqual(held, [true, false]);
  assert.doesNotMatch(f.content().textContent, /two/);
  assert.equal(f.model.getValue(), original);
});

test('case-insensitive search reports document positions even when lowercasing changes length', async (t) => {
  const { findRichMarkdownMatches } = await import('./rich-markdown-search.ts');
  const f = await mount(t, 'İx and İX\n');
  const doc = f.editor().state.doc;
  assert.deepEqual(findRichMarkdownMatches(doc, 'x'), [
    { from: 2, to: 3 },
    { from: 9, to: 10 },
  ]);
  assert.deepEqual(findRichMarkdownMatches(doc, 'İx'), [
    { from: 1, to: 3 },
    { from: 8, to: 10 },
  ]);
  assert.equal(doc.textBetween(9, 10), 'X');
});

test('changes made in the model elsewhere re-sync the editor', async (t) => {
  const f = await mount(t, FRONT + BODY);
  await act(async () => f.model.setValue(`${FRONT}# Renamed\n\nFresh body.\n`));
  await f.render({ text: f.model.getValue() });
  assert.equal(f.content().querySelector('h1').textContent, 'Renamed');
  assert.match(f.content().textContent, /Fresh body\./);
  await settle(400);
  assert.equal(f.model.edits.length, 0);
});

test('Ctrl+S flushes pending edits, then saves', async (t) => {
  const f = await mount(t, BODY);
  await act(async () => {
    f.editor().chain().insertContentAt(1, 'My ').run();
  });
  await act(async () => {
    f.content().dispatchEvent(
      new f.dom.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    );
  });
  assert.equal(f.calls.save, 1);
  assert.match(f.model.getValue(), /^# My Guide\n/);
});

test('Ctrl+click opens anchors, project files and web links', async (t) => {
  const f = await mount(t, BODY);
  const links = [...f.content().querySelectorAll('a')];
  const editor = f.editor();
  const posOf = (anchor) => editor.view.posAtDOM(anchor.firstChild, 1);
  // ProseMirror routes clicks through posAtCoords, which jsdom cannot lay
  // out; drive its click prop with the anchor's document position instead.
  const open = (anchor) =>
    act(async () => {
      editor.view.someProp('handleClick', (handler) =>
        handler(editor.view, posOf(anchor), new f.dom.window.MouseEvent('click', { ctrlKey: true }))
      );
    });
  await open(links[0]);
  assert.deepEqual(f.calls.opened, [[PROJECT, 'docs/setup.md', 3]]);
  await open(links[1]);
  assert.deepEqual(f.external, ['https://example.com']);
  await open(links[2]);
  assert.equal(editor.state.selection.$from.parent.textContent, 'Guide');
  assert.equal(f.model.edits.length, 0);
});

test('anchors to repeated headings reach the right one', async (t) => {
  const f = await mount(t, '# A\n\nfirst\n\n## A-1\n\nsecond\n\n## A\n\nthird\n\n[1](#a-1) [2](#a-2)\n');
  const editor = f.editor();
  const [toSecond, toThird] = [...f.content().querySelectorAll('a')];
  const open = (anchor) =>
    act(async () => {
      editor.view.someProp('handleClick', (handler) =>
        handler(
          editor.view,
          editor.view.posAtDOM(anchor.firstChild, 1),
          new f.dom.window.MouseEvent('click', { ctrlKey: true })
        )
      );
    });
  const headingIndex = () => {
    const { $from } = editor.state.selection;
    let index = -1;
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === 'heading' && offset < $from.pos) index++;
    });
    return index;
  };
  await open(toSecond);
  assert.equal(headingIndex(), 1);
  await open(toThird);
  assert.equal(headingIndex(), 2);
});

test('read-only disables editing and the toolbar', async (t) => {
  const f = await mount(t, BODY, { readOnly: true });
  assert.equal(f.content().getAttribute('contenteditable'), 'false');
  const buttons = [...f.doc.querySelectorAll('.rich-markdown-toolbar button')];
  const enabled = buttons.filter((button) => !button.disabled).map((button) => button.getAttribute('aria-label'));
  assert.deepEqual(enabled, ['Find']);
});

test('search highlights matches and steps through them', async (t) => {
  const f = await mount(t, `${BODY}\nMore text here.\n`);
  await act(async () => {
    f.content().dispatchEvent(
      new f.dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
    );
  });
  const input = f.doc.querySelector('.rich-markdown-search-input');
  assert.ok(input);
  const setter = Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, 'text');
    input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(f.content().querySelectorAll('.rich-markdown-search-match').length, 2);
  assert.match(f.doc.querySelector('.rich-markdown-search-count').textContent, /1 of 2/);
  await act(async () => {
    input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  assert.match(f.doc.querySelector('.rich-markdown-search-count').textContent, /2 of 2/);
  assert.equal(f.model.edits.length, 0);
});

test('a held edit stays readable for backups, also after Rich unmounts, which does not release it', async (t) => {
  const original = '| A |\n| --- |\n| one |\n';
  const reports = [];
  const f = await mount(t, original, { onHeldChange: (held, heldText) => reports.push({ held, heldText }) });
  const editor = f.editor();
  let cellEnd = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell') cellEnd = pos + node.nodeSize - 1;
  });
  await act(async () => {
    editor
      .chain()
      .insertContentAt(cellEnd, { type: 'paragraph', content: [{ type: 'text', text: 'two' }] })
      .run();
  });
  assert.equal(reports.at(-1).held, true);
  const heldText = reports.at(-1).heldText;
  assert.match(heldText(), /^\| A \|\n\| --- \|\n\| one.*two.*\|\n$/s);
  const count = reports.length;
  await f.leave();
  assert.equal(reports.length, count, 'leaving does not discard the held edit');
  assert.match(heldText(), /two/);
  assert.equal(f.model.getValue(), original);
});

test('text rejected and restored within one update loads the editor again', async (t) => {
  const f = await mount(t, BODY);
  await act(async () => {
    f.model.setValue('<div>raw</div>\n');
    f.model.setValue(BODY);
  });
  await f.render({ text: f.model.getValue() });
  assert.ok(f.content(), 'the editor is back');
  assert.equal(f.doc.querySelector('.rich-markdown-unsupported'), null);
  assert.equal(f.content().querySelector('h1').textContent, 'Guide');
  assert.equal(f.calls.unsupported.length, 1);
});

test('unsupported content is reported to the host', async (t) => {
  const f = await mount(t, '<div>raw</div>\n');
  assert.equal(f.calls.unsupported.length, 1);
  assert.match(f.calls.unsupported[0], /HTML/);
  assert.equal(f.doc.querySelector('.rich-markdown-content'), null);
});

test('pasted Markdown the editor cannot represent is inserted as literal text, not converted', async (t) => {
  const f = await mount(t, '# Hello\n\nBody.\n');
  const paste = (plain) =>
    act(async () => {
      f.editor().commands.focus('end');
      const event = new f.dom.window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: (type) => (type === 'text/plain' ? plain : '') },
      });
      f.content().dispatchEvent(event);
    });
  await paste('# Pasted\n\n<div>IMPORTANT CONTENT</div>');
  const text = f.content().textContent;
  assert.match(text, /<div>IMPORTANT CONTENT<\/div>/, 'the HTML survives as visible text');
  assert.equal(f.content().querySelectorAll('h1').length, 1, 'the pasted heading is not converted');
  await paste('## Safe\n\n* item');
  assert.equal(f.content().querySelectorAll('h2').length, 1, 'supported Markdown still converts');
});

test('pasted literal text keeps its empty lines', async (t) => {
  const f = await mount(t, '# Hello\n\nBody.\n');
  await act(async () => {
    f.editor().commands.focus('end');
    const event = new f.dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type) => (type === 'text/plain' ? '# Pasted\n\n<pre>line one\n\n\nline two</pre>' : '') },
    });
    f.content().dispatchEvent(event);
  });
  const paragraphs = [...f.content().querySelectorAll('p')].map((p) => p.textContent);
  const one = paragraphs.indexOf('<pre>line one');
  assert.ok(one >= 0, JSON.stringify(paragraphs));
  assert.deepEqual(paragraphs.slice(one, one + 4), ['<pre>line one', '', '', 'line two</pre>']);
  assert.match(f.model.getValue(), /&lt;pre&gt;line one\n\n(?:\n)*line two&lt;\/pre&gt;\n$/);
});
