import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import MarkdownBody from './MarkdownBody';
import MarkdownAstBody from './MarkdownAstBody';
import { parseMarkdownToHast } from './markdown-ast';
import { MarkdownOpenFileContext, MarkdownProjectContext } from './MarkdownLink';
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
  const opened = [];
  const files = [];
  // What main reports back: documents launch ('file'), folders open
  // ('folder'), anything else is handed to the editor ('editor').
  const openResult = (href) => (/[\\/]$/.test(href) || !/\.[a-z0-9]+$/i.test(href) ? 'folder' : 'file');
  dom.window.mixdogDesktop = {
    openLocalFileLink: async (...args) => { local.push(args); return openResult(args[1]); },
    openExternal: async (...args) => { external.push(args); },
    searchProjectFiles: async () => files.slice(),
  };
  dom.window.open = (...args) => { popups.push(args); };
  dom.window.addEventListener(DESKTOP_TOAST_EVENT, (event) => toasts.push(event.detail));
  const update = async (nextProject) => act(async () => {
    root.render(React.createElement(MarkdownProjectContext.Provider, { value: nextProject },
      React.createElement(MarkdownOpenFileContext.Provider,
        { value: (...args) => { opened.push(args); } }, render(text))));
  });
  await update(project);
  const links = () => [...dom.window.document.querySelectorAll('a')];
  // Link text without the Seti glyph that file links carry.
  const labels = () => links().map((a) => [...a.childNodes]
    .filter((node) => !node.classList?.contains('seti-icon')).map((node) => node.textContent).join(''));
  const click = async (index = 0, options = {}, type = 'click') => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...options });
    await act(async () => { links()[index].dispatchEvent(event); });
    return event;
  };
  const hover = async (index) => {
    await act(async () => {
      links()[index].dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
    });
  };
  return { dom, local, external, popups, toasts, opened, files, links, labels, click, hover, update };
}

const PROJECT = 'C:/Project/conversation';

function installProjectFiles(f, entries) {
  const api = f.dom.window.mixdogDesktop;
  api.listProjects = async () => Object.keys(entries).map((path) => ({ path, name: path.split('/').at(-1) }));
  api.statProjectFile = async (project, path) => {
    if (entries[project]?.includes(path)) return { size: 10, mtimeMs: 1 };
    throw Object.assign(new Error(`ENOENT: ${project}/${path}`), { code: 'ENOENT' });
  };
  api.searchProjectFiles = async (project) => entries[project] || [];
}

for (const [pipeline, render] of Object.entries(renderers)) {
  test(`${pipeline}: files in another registered Project open without changing the conversation Project`, async (t) => {
    const other = 'C:/Project/GamerScroll';
    const f = await mount(t, render, [
      '`favicon.svg`',
      '[relative](assets/aiscroll-favicon.svg)',
      `[absolute](${other}/assets/aiscroll-favicon.svg)`,
      `[document](file:///${other}/output/report.pptx)`,
      `[source](${other}/src/app.ts:12)`,
      `[folder](${other}/output/)`,
      `[script](${other}/run.ps1)`,
    ].join('\n\n'));
    installProjectFiles(f, {
      [PROJECT]: [],
      [other]: ['favicon.svg', 'assets/aiscroll-favicon.svg', 'output/report.pptx', 'src/app.ts', 'output', 'run.ps1'],
    });
    for (let index = 0; index < 7; index++) await f.click(index);
    assert.deepEqual(f.opened, [
      [other, 'favicon.svg', undefined],
      [other, 'assets/aiscroll-favicon.svg', undefined],
      [other, 'assets/aiscroll-favicon.svg', undefined],
      [other, 'src/app.ts', 12],
      [other, 'run.ps1', undefined],
    ]);
    assert.deepEqual(f.local, [[other, 'output/report.pptx'], [other, 'output']]);
    assert.equal(f.links()[0].title, `${other}/favicon.svg`);
    assert.equal(f.toasts.length + f.external.length + f.popups.length, 0);
  });

  test(`${pipeline}: cwd changes retarget file links and discard the previous Project tooltip`, async (t) => {
    const other = 'C:/Project/GamerScroll';
    const f = await mount(t, render, '`src/app.ts`');
    installProjectFiles(f, { [PROJECT]: ['src/app.ts'], [other]: ['src/app.ts'] });
    await f.hover(0);
    assert.equal(f.links()[0].title, `${PROJECT}/src/app.ts`);
    await f.update(other);
    assert.equal(f.links()[0].title, `${other}/src/app.ts`);
    await f.click();
    assert.deepEqual(f.opened, [[other, 'src/app.ts', undefined]]);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: missing local files do not guess between other Projects or escape registered roots`, async (t) => {
    const other = 'C:/Project/GamerScroll';
    const third = 'C:/Project/another';
    const f = await mount(t, render, [
      '`favicon.svg`',
      '[outside](C:/private/secret.svg)',
      '[traversal](../../private/secret.svg)',
      '[network](file://server/share/secret.svg)',
    ].join('\n\n'));
    installProjectFiles(f, { [PROJECT]: [], [other]: ['favicon.svg'], [third]: ['favicon.svg'] });
    await f.click(0);
    assert.match(f.toasts[0].text, /Several files/);
    assert.ok(f.toasts[0].text.includes(`${other}/favicon.svg`));
    assert.ok(f.toasts[0].text.includes(`${third}/favicon.svg`));
    await f.click(1);
    await f.click(2);
    await f.click(3);
    assert.equal(f.toasts.length, 4);
    assert.equal(f.opened.length + f.local.length, 0);
    installProjectFiles(f, { [PROJECT]: ['favicon.svg'], [other]: ['favicon.svg'] });
    await f.click(0);
    assert.deepEqual(f.opened, [[PROJECT, 'favicon.svg', undefined]]);
  });

  test(`${pipeline}: access failures are reported rather than redirected to another Project`, async (t) => {
    const f = await mount(t, render, '`favicon.svg`');
    installProjectFiles(f, { [PROJECT]: [], 'C:/Project/other': ['favicon.svg'] });
    f.dom.window.mixdogDesktop.statProjectFile = async () => { throw new Error('Path resolves outside the project.'); };
    await f.click();
    assert.match(f.toasts[0].text, /Path resolves outside/);
    assert.equal(f.opened.length + f.local.length, 0);
  });

  test(`${pipeline}: documents open with the OS and text files open in the editor, both in the owning Project`, async (t) => {
    const paths = [
      'output/ai-work-proposal-20260907/ai-work-proposal-delivery.pptx',
      'output/ai-work-proposal-20260907/ai-work-proposal-delivery.mixdog-preview.pdf',
      'output/ai-work-proposal-20260907/verification-summary.md',
    ];
    const f = await mount(t, render, paths.map((path, index) => `[file ${index}](${path})`).join('\n\n'));
    for (let index = 0; index < paths.length; index++) {
      assert.equal((await f.click(index)).defaultPrevented, true);
    }
    assert.deepEqual(f.local, [[PROJECT, paths[0]], [PROJECT, paths[1]]]);
    assert.deepEqual(f.opened, [[PROJECT, paths[2], undefined]]);
    await f.update('D:/Project/other-conversation');
    await f.click();
    await f.click(2);
    assert.deepEqual(f.local.at(-1), ['D:/Project/other-conversation', paths[0]]);
    assert.deepEqual(f.opened.at(-1), ['D:/Project/other-conversation', paths[2], undefined]);
    assert.equal(f.external.length + f.popups.length + f.toasts.length, 0);
  });

  test(`${pipeline}: absolute paths and file URLs resolve inside the Project; outside paths are refused`, async (t) => {
    const f = await mount(t, render, [
      '[drive](C:/Project/conversation/output/deck.pptx)',
      '[backslashes](<C:\\Project\\conversation\\output\\deck.pptx>)',
      '[file](file:///C:/Project/conversation/output/preview.pdf)',
      '[source](C:/Project/conversation/src/app.ts:42)',
      '[posix](/home/user/project/report.md)',
    ].join('\n\n'));
    for (let index = 0; index < 5; index++) {
      assert.ok(f.links()[index].getAttribute('href'));
      assert.equal((await f.click(index)).defaultPrevented, true);
    }
    assert.deepEqual(f.local, [
      [PROJECT, 'output/deck.pptx'], [PROJECT, 'output/deck.pptx'], [PROJECT, 'output/preview.pdf'],
    ]);
    assert.deepEqual(f.opened, [[PROJECT, 'src/app.ts', 42]]);
    assert.equal(f.links()[3].getAttribute('title'), 'C:/Project/conversation/src/app.ts:42');
    assert.equal(f.toasts.length, 1);
    assert.match(f.toasts[0].text, /outside/);
    assert.equal(f.external.length, 0);
  });

  test(`${pipeline}: file mentions in prose and inline code become editor links with their line`, async (t) => {
    const f = await mount(t, render, [
      'Fixed src/runtime/agent.mjs:269 and `apps/desktop/src/main/ipc.ts` (line 12, col 4).',
      'Only `retry-classifier.mjs` (line 269) changed; see C:\\Project\\conversation\\docs\\notes.md#L7 too.',
      'Not links: https://example.com/docs/guide.md, node.js, and/or, v1.2/3.4, `npm/registry`.',
      '```\nsrc/skipped.ts:1\n```',
    ].join('\n\n'));
    f.files.push('src/runtime/agent/orchestrator/providers/retry-classifier.mjs', 'src/x/retry-classifier.mjs.bak');
    assert.deepEqual(f.links().map((a) => a.getAttribute('href')), [
      'src/runtime/agent.mjs:269',
      'apps/desktop/src/main/ipc.ts:12:4',
      './retry-classifier.mjs:269',
      'C:\\Project\\conversation\\docs\\notes.md:7',
      'https://example.com/docs/guide.md',
    ]);
    // Every mention is shown the same way: icon + file name + :line.
    assert.deepEqual(f.labels().slice(0, 4), [
      'agent.mjs:269', 'ipc.ts:12:4', 'retry-classifier.mjs:269', 'notes.md:7',
    ]);
    assert.ok(f.links().slice(0, 4).every((a) =>
      a.className === 'markdown-path-link' && a.querySelector('.seti-icon')));
    assert.equal(f.links()[4].querySelector('.seti-icon'), null);
    assert.equal(f.links()[0].getAttribute('title'), 'C:/Project/conversation/src/runtime/agent.mjs:269');
    for (let index = 0; index < 4; index++) {
      assert.equal((await f.click(index)).defaultPrevented, true);
    }
    assert.deepEqual(f.opened, [
      [PROJECT, 'src/runtime/agent.mjs', 269],
      [PROJECT, 'apps/desktop/src/main/ipc.ts', 12],
      [PROJECT, 'src/runtime/agent/orchestrator/providers/retry-classifier.mjs', 269],
      [PROJECT, 'docs/notes.md', 7],
    ]);
    await f.hover(2);
    assert.equal(f.links()[2].getAttribute('title'),
      'C:/Project/conversation/src/runtime/agent/orchestrator/providers/retry-classifier.mjs:269');
    assert.equal(f.local.length + f.toasts.length, 0);
  });

  test(`${pipeline}: explicit links keep a real caption but collapse a path caption to the file name`, async (t) => {
    const f = await mount(t, render, [
      '[수정 요약](output/report.md)',
      '[src/app.ts](src/app.ts)',
      '[deck](output/deck.pptx)',
      '[output/deck.pptx](output/deck.pptx)',
    ].join('\n\n'));
    assert.deepEqual(f.labels(), ['수정 요약', 'app.ts', 'deck', 'deck.pptx']);
    assert.deepEqual(f.links().map((a) => Boolean(a.querySelector('.seti-icon'))), [false, true, false, true]);
    assert.deepEqual(f.links().map((a) => a.getAttribute('title')), [
      'C:/Project/conversation/output/report.md', 'C:/Project/conversation/src/app.ts',
      'C:/Project/conversation/output/deck.pptx', 'C:/Project/conversation/output/deck.pptx',
    ]);
    await f.click(1);
    await f.click(3);
    assert.deepEqual(f.opened, [[PROJECT, 'src/app.ts', undefined]]);
    assert.deepEqual(f.local, [[PROJECT, 'output/deck.pptx']]);
  });

  test(`${pipeline}: folders, document names with spaces, extension-less files, Korean line refs and images`, async (t) => {
    const f = await mount(t, render, [
      '산출물은 output/report-2026/ 폴더에 있고 입력/출력 구분은 링크가 아닙니다.',
      '`Dockerfile`과 `.gitignore`를 수정했고 `src/app.ts`:42 및 `src/util.ts` 269번 줄, `src/x.ts` (7줄)도 봤습니다.',
      '`output/제안서 최종.pptx`와 `output/` 참고. `python scripts/run.py`, `@mixdog/desktop`, `npm run build`는 아닙니다.',
      '선택자 `.workspace`, `.main-panel`도 파일이 아니지만 `.env.local`은 파일입니다.',
      '![차트](output/chart.png)',
    ].join('\n\n'));
    f.files.push('Dockerfile', '.gitignore', '.env.local');
    assert.equal(f.links().find((a) => a.querySelector('.seti-icon'))?.querySelector('.seti-icon')?.textContent.length, 1);
    // Folder links carry no glyph, like folders in the explorer.
    assert.equal(f.links()[0].querySelector('.seti-icon'), null);
    assert.deepEqual(f.links().map((a) => a.getAttribute('href')), [
      'output/report-2026/', './Dockerfile', './.gitignore', 'src/app.ts:42', 'src/util.ts:269',
      'src/x.ts:7', 'output/제안서 최종.pptx', 'output/', './.env.local', 'output/chart.png',
    ]);
    assert.deepEqual(f.labels(), [
      'report-2026/', 'Dockerfile', '.gitignore', 'app.ts:42', 'util.ts:269', 'x.ts:7',
      '제안서 최종.pptx', 'output/', '.env.local', 'chart.png',
    ]);
    assert.equal(f.dom.window.document.querySelector('img'), null);
    for (let index = 0; index < 10; index++) await f.click(index);
    // Folders, documents and extension-less names go through main; text files
    // with an extension open in the editor directly.
    assert.deepEqual(f.local, [
      [PROJECT, 'output/report-2026'], [PROJECT, 'Dockerfile'],
      [PROJECT, `output/${encodeURIComponent('제안서 최종.pptx')}`],
      [PROJECT, 'output'], [PROJECT, 'output/chart.png'],
    ]);
    assert.deepEqual(f.opened, [
      [PROJECT, '.gitignore', undefined], [PROJECT, 'src/app.ts', 42],
      [PROJECT, 'src/util.ts', 269], [PROJECT, 'src/x.ts', 7], [PROJECT, '.env.local', undefined],
    ]);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: main hands text files back to the editor after probing an extension-less name`, async (t) => {
    const f = await mount(t, render, 'See `scripts/Dockerfile` and `docs/` here.');
    f.dom.window.mixdogDesktop.openLocalFileLink = async (...args) => {
      f.local.push(args);
      return args[1] === 'scripts/Dockerfile' ? 'editor' : 'folder';
    };
    await f.click(0);
    await f.click(1);
    assert.deepEqual(f.local, [[PROJECT, 'scripts/Dockerfile'], [PROJECT, 'docs']]);
    assert.deepEqual(f.opened, [[PROJECT, 'scripts/Dockerfile', undefined]]);
  });

  test(`${pipeline}: a bare file name the Project cannot resolve reports instead of opening`, async (t) => {
    const f = await mount(t, render, 'See `missing.ts` and `dup.ts`.');
    await f.click(0);
    assert.match(f.toasts.at(-1).text, /missing\.ts/);
    f.files.push('a/dup.ts', 'b/dup.ts');
    await f.click(1);
    assert.match(f.toasts.at(-1).text, /dup\.ts/);
    assert.equal(f.toasts.length, 2);
    assert.equal(f.opened.length + f.local.length, 0);
  });

  test(`${pipeline}: local errors, absent desktop support and absent Project are visible, never navigated`, async (t) => {
    const f = await mount(t, render, '[file](output/deck.pptx)');
    f.dom.window.mixdogDesktop.openLocalFileLink = async () => {
      throw new Error("Error invoking remote method 'mixdog:open-local-file-link': Error: The file no longer exists: output/deck.pptx");
    };
    assert.equal((await f.click()).defaultPrevented, true);
    assert.match(f.toasts.at(-1).text, /The file no longer exists: output\/deck\.pptx/);
    assert.doesNotMatch(f.toasts.at(-1).text, /invoking remote method|Error:/);
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
