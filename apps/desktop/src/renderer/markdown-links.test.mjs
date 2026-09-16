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
import { healStreamingMarkdownTail } from './streaming-markdown';
import StreamingMarkdownBody from './StreamingMarkdownBody';

const CopyControl = () => null;
function readableText(element) {
  const clone = element.cloneNode(true);
  for (const icon of clone.querySelectorAll('.seti-icon')) icon.remove();
  return clone.textContent;
}
const renderers = {
  settled: (text) => React.createElement(MarkdownBody, { text, copyControl: CopyControl }),
  worker: (text) => React.createElement(MarkdownAstBody, {
    root: parseMarkdownToHast(text), copyControl: CopyControl,
  }),
};

async function mount(t, render, text, project = 'C:/Project/conversation', configure = () => {}) {
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
  const update = async (nextProject, nextText = text) => act(async () => {
    root.render(React.createElement(MarkdownProjectContext.Provider, { value: nextProject },
      React.createElement(MarkdownOpenFileContext.Provider,
        { value: (...args) => { opened.push(args); } }, render(nextText))));
  });
  const links = () => [...dom.window.document.querySelectorAll('a')];
  const labels = () => links().map(readableText);
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
  const fixture = { dom, local, external, popups, toasts, opened, files, links, labels, click, hover, update };
  configure(fixture);
  await update(project);
  return fixture;
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
    ].join('\n\n'), PROJECT, (f) => installProjectFiles(f, {
      [PROJECT]: [],
      [other]: ['favicon.svg', 'assets/aiscroll-favicon.svg', 'output/report.pptx', 'src/app.ts', 'output', 'run.ps1'],
    }));
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
    const f = await mount(t, render, '`src/app.ts`', PROJECT, (f) =>
      installProjectFiles(f, { [PROJECT]: ['src/app.ts'], [other]: ['src/app.ts'] }));
    await f.hover(0);
    assert.equal(f.links()[0].title, `${PROJECT}/src/app.ts`);
    await f.update(other);
    assert.equal(f.links()[0].title, `${other}/src/app.ts`);
    await f.click();
    assert.deepEqual(f.opened, [[other, 'src/app.ts', undefined]]);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: explicit external paths open with file-scoped access, including file URLs and line numbers`, async (t) => {
    const outside = 'C:/private';
    const f = await mount(t, render, [
      '`C:/private/source.ts:12`',
      '[encoded](file:///C:/private/%ED%95%9C%EA%B8%80%20100%25%20%231.ts#L7)',
      '[document](C:/private/report.pdf)',
      '[folder](C:/private/output/)',
      '[script](C:/private/run.ps1)',
      '[posix](/tmp/outside.ts:9)',
    ].join('\n\n'), PROJECT, (f) => {
      installProjectFiles(f, { [PROJECT]: [] });
      const externalFiles = new Map([
        [`${outside}/source.ts`, ['source.ts', outside]],
        [`${outside}/한글 100% #1.ts`, ['한글 100% #1.ts', outside]],
        [`${outside}/report.pdf`, ['report.pdf', outside]],
        [`${outside}/run.ps1`, ['run.ps1', outside]],
        ['/tmp/outside.ts', ['outside.ts', '/tmp']],
      ]);
      f.dom.window.mixdogDesktop.resolveLocalPaths = async ([absolutePath]) => {
        if (absolutePath === `${outside}/output/`) {
          return [{ absolutePath: `${outside}/output`, dir: true, name: 'output', size: 0 }];
        }
        assert.ok(externalFiles.has(absolutePath), absolutePath);
        const [relPath, projectPath] = externalFiles.get(absolutePath);
        return [{ absolutePath, dir: false, projectPath, relPath, accessToken: `grant:${relPath}` }];
      };
      f.dom.window.mixdogDesktop.statProjectFile = async (project, path, token) => {
        if (externalFiles.has(`${project}/${path}`) && token === `grant:${path}`) return { size: 10, mtimeMs: 1 };
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };
    });
    assert.equal(f.links().length, 6);
    for (let index = 0; index < 6; index++) await f.click(index);
    assert.deepEqual(f.opened, [
      [outside, 'source.ts', 12, 'grant:source.ts'],
      [outside, '한글 100% #1.ts', 7, 'grant:한글 100% #1.ts'],
      [outside, 'run.ps1', undefined, 'grant:run.ps1'],
      ['/tmp', 'outside.ts', 9, 'grant:outside.ts'],
    ]);
    assert.deepEqual(f.local, [[outside, 'report.pdf'], [`${outside}/output`, '.']]);
    assert.equal(f.toasts.length + f.external.length + f.popups.length, 0);
  });

  test(`${pipeline}: an external absolute path works without a conversation Project`, async (t) => {
    const f = await mount(t, render, '[source](C:/private/source.ts)', '', (f) => {
      installProjectFiles(f, {});
      f.dom.window.mixdogDesktop.resolveLocalPaths = async ([absolutePath]) => {
        assert.equal(absolutePath, 'C:/private/source.ts');
        return [{ absolutePath, projectPath: 'C:/private', relPath: 'source.ts', accessToken: 'grant', dir: false }];
      };
    });
    await f.click();
    assert.deepEqual(f.opened, [['C:/private', 'source.ts', undefined, 'grant']]);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: partial paths find a unique suffix in registered Projects, never a fuzzy substitute`, async (t) => {
    const other = 'C:/Project/game';
    const f = await mount(t, render, [
      '[source](Server/ServerConnectionRecovery.cs:8)',
      '[ambiguous](Server/duplicate.cs)',
      '[missing](Server/missing.cs)',
    ].join('\n\n'), PROJECT, (f) => installProjectFiles(f, {
      [PROJECT]: [],
      [other]: [
        'Assets/Scripts/Server/ServerConnectionRecovery.cs',
        'Assets/Scripts/Server/ServerConnectionRecovery.cs.bak',
        'a/Server/duplicate.cs', 'b/Server/duplicate.cs', 'Server/missing.cs.bak',
      ],
    }));
    await f.click(0);
    await f.click(1);
    await f.click(2);
    assert.deepEqual(f.opened, [[other, 'Assets/Scripts/Server/ServerConnectionRecovery.cs', 8]]);
    assert.match(f.toasts[0].text, /Several files/);
    assert.match(f.toasts[1].text, /File not found/);
  });

  test(`${pipeline}: missing external files, traversal and network links never open or fall back to a namesake`, async (t) => {
    const requests = [];
    const f = await mount(t, render, [
      '[missing](C:/private/missing.ts)',
      '[traversal](../../private/missing.ts)',
      '[network](file://server/share/missing.ts)',
      '[encoded network](/%2Fserver/share/missing.ts)',
    ].join('\n\n'), PROJECT, (f) => {
      installProjectFiles(f, { [PROJECT]: ['src/missing.ts'] });
      f.dom.window.mixdogDesktop.resolveLocalPaths = async (paths) => {
        requests.push(paths);
        throw Object.assign(new Error('ENOENT: external file is missing'), { code: 'ENOENT' });
      };
    });
    for (let index = 0; index < 4; index++) await f.click(index);
    assert.deepEqual(requests, [['C:/private/missing.ts']]);
    assert.equal(f.toasts.length, 4);
    assert.equal(f.opened.length + f.local.length + f.popups.length, 0);
  });

  test(`${pipeline}: missing local files do not guess between other Projects or escape registered roots`, async (t) => {
    const other = 'C:/Project/GamerScroll';
    const third = 'C:/Project/another';
    const f = await mount(t, render, [
      '[favicon.svg](./favicon.svg)',
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
    const f = await mount(t, render, '[favicon.svg](./favicon.svg)');
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

  test(`${pipeline}: absolute paths and file URLs resolve inside the Project; external paths require desktop file access`, async (t) => {
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
    assert.match(f.toasts[0].text, /Local file links can only be opened in the desktop app/);
    assert.equal(f.external.length, 0);
  });

  test(`${pipeline}: file mentions in prose and inline code become editor links with their line`, async (t) => {
    const f = await mount(t, render, [
      'Fixed src/runtime/agent.mjs:269 and `apps/desktop/src/main/ipc.ts` (line 12, col 4).',
      'Only `retry-classifier.mjs` (line 269) changed; see C:\\Project\\conversation\\docs\\notes.md#L7 too.',
      'Not links: https://example.com/docs/guide.md, node.js, and/or, v1.2/3.4, `npm/registry`.',
      '```\nsrc/skipped.ts:1\n```',
    ].join('\n\n'), PROJECT, (f) => installProjectFiles(f, {
      [PROJECT]: [
        'src/runtime/agent.mjs', 'apps/desktop/src/main/ipc.ts', 'docs/notes.md',
        'src/runtime/agent/orchestrator/providers/retry-classifier.mjs', 'src/x/retry-classifier.mjs.bak',
      ],
    }));
    assert.deepEqual(f.links().map((a) => a.getAttribute('href')), [
      'src/runtime/agent.mjs:269',
      'apps/desktop/src/main/ipc.ts:12:4',
      './retry-classifier.mjs:269',
      'C:\\Project\\conversation\\docs\\notes.md:7',
      'https://example.com/docs/guide.md',
    ]);
    // Every mention uses its final icon + filename + line from the first paint.
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
    ].join('\n\n'), PROJECT, (f) => installProjectFiles(f, {
      [PROJECT]: [
        'output/report-2026', 'Dockerfile', '.gitignore', 'src/app.ts', 'src/util.ts', 'src/x.ts',
        'output/제안서 최종.pptx', 'output', '.env.local', 'output/chart.png',
      ],
    }));
    assert.equal(f.links().find((a) => a.querySelector('.seti-icon'))?.querySelector('.seti-icon')?.textContent.length, 1);
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
    const f = await mount(t, render, 'See `scripts/Dockerfile` and `docs/` here.', PROJECT, (f) =>
      installProjectFiles(f, { [PROJECT]: ['scripts/Dockerfile', 'docs'] }));
    f.dom.window.mixdogDesktop.openLocalFileLink = async (...args) => {
      f.local.push(args);
      return args[1] === 'scripts/Dockerfile' ? 'editor' : 'folder';
    };
    await f.click(0);
    await f.click(1);
    assert.deepEqual(f.local, [[PROJECT, 'scripts/Dockerfile'], [PROJECT, 'docs']]);
    assert.deepEqual(f.opened, [[PROJECT, 'scripts/Dockerfile', undefined]]);
  });

  test(`${pipeline}: planned, missing and ambiguous mentions stay inert without removing their first-paint icons`, async (t) => {
    const f = await mount(t, render, [
      '스펙 문서(`special_offer_server_spec.md`)를 작성하겠습니다.',
      'See docs/planned.md (line 12), `missing.ts`, `dup.ts`, missing/ and `missing-folder/`.',
    ].join('\n\n'), PROJECT, (f) => installProjectFiles(f, {
      [PROJECT]: ['a/dup.ts', 'b/dup.ts'],
    }));
    assert.equal(f.links().length, 0);
    assert.deepEqual([...f.dom.window.document.querySelectorAll('p')].map(readableText), [
      '스펙 문서(special_offer_server_spec.md)를 작성하겠습니다.',
      'See planned.md:12, missing.ts, dup.ts, missing/ and missing-folder/.',
    ]);
    const pending = [...f.dom.window.document.querySelectorAll('.markdown-link-pending')];
    assert.deepEqual(pending.map(readableText),
      ['special_offer_server_spec.md', 'planned.md:12', 'missing.ts', 'dup.ts', 'missing/', 'missing-folder/']);
    assert.equal(pending.filter((item) => item.querySelector('.seti-icon')).length, 4);
    for (const item of pending) {
      assert.equal(item.getAttribute('aria-disabled'), 'true');
      await act(async () => item.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));
    }
    assert.equal(f.toasts.length + f.opened.length + f.local.length + f.popups.length, 0);
  });

  test(`${pipeline}: automatic links show their final icons immediately and enable clicking only after verification`, async (t) => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const f = await mount(t, render, 'See `src/app.ts` (line 12, col 4).', PROJECT, (f) => {
      f.dom.window.mixdogDesktop.statProjectFile = () => pending;
    });
    assert.equal(f.links().length, 0);
    const pendingLink = f.dom.window.document.querySelector('.markdown-link-pending');
    assert.equal(readableText(pendingLink), 'app.ts:12:4');
    assert.equal(pendingLink.getAttribute('aria-disabled'), 'true');
    const initialIcon = pendingLink.querySelector('.seti-icon').outerHTML;
    const initialText = f.dom.window.document.querySelector('p').textContent;
    await act(async () => pendingLink.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));
    assert.equal(f.opened.length + f.local.length, 0);
    await act(async () => { release({ size: 10, mtimeMs: 1 }); });
    assert.deepEqual(f.labels(), ['app.ts:12:4']);
    assert.equal(f.dom.window.document.querySelector('p').textContent, initialText);
    assert.equal(f.links()[0].querySelector('.seti-icon').outerHTML, initialIcon);
    assert.equal(f.links()[0].title, `${PROJECT}/src/app.ts:12:4`);
    await f.click();
    assert.deepEqual(f.opened, [[PROJECT, 'src/app.ts', 12]]);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: automatic mentions cannot use the resolver's no-stat compatibility fallback`, async (t) => {
    const f = await mount(t, render, '`src/app.ts`, output/ and `found.ts`.', PROJECT, (f) => {
      f.files.push('found.ts');
    });
    assert.equal(f.links().length, 0);
    assert.equal(readableText(f.dom.window.document.querySelector('p')), 'app.ts, output/ and found.ts.');
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: stale file-search results do not become automatic links`, async (t) => {
    const f = await mount(t, render, '`stale.ts`', PROJECT, (f) => {
      installProjectFiles(f, { [PROJECT]: [] });
      f.dom.window.mixdogDesktop.searchProjectFiles = async () => ['src/stale.ts'];
    });
    assert.equal(f.links().length, 0);
    assert.equal(readableText(f.dom.window.document.querySelector('.markdown-link-pending')), 'stale.ts');
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: inaccessible automatic mentions remain text without error toasts or redirection`, async (t) => {
    const f = await mount(t, render, '`favicon.svg` and `C:/private/secret.svg`', PROJECT, (f) => {
      installProjectFiles(f, { [PROJECT]: [], 'C:/Project/other': ['favicon.svg'] });
      f.dom.window.mixdogDesktop.statProjectFile = async () => { throw new Error('Path resolves outside the project.'); };
    });
    assert.equal(f.links().length, 0);
    assert.equal(f.toasts.length + f.opened.length + f.local.length, 0);
  });

  test(`${pipeline}: relative automatic mentions without a conversation Project remain text`, async (t) => {
    const f = await mount(t, render, '`src/app.ts`', '', (f) =>
      installProjectFiles(f, { [PROJECT]: ['src/app.ts'] }));
    assert.equal(f.links().length, 0);
    assert.equal(f.toasts.length, 0);
  });

  for (const change of ['Project', 'target']) {
    test(`${pipeline}: pending automatic verification cannot link a different ${change}`, async (t) => {
      let release;
      const pending = new Promise((resolve) => { release = resolve; });
      const f = await mount(t, render, '`src/app.ts`', PROJECT, (f) => {
        installProjectFiles(f, {});
        f.dom.window.mixdogDesktop.statProjectFile = async (project, path) => {
          if (project === PROJECT && path === 'src/app.ts') return pending;
          throw Object.assign(new Error(`ENOENT: ${project}/${path}`), { code: 'ENOENT' });
        };
      });
      assert.equal(f.links().length, 0);
      const nextProject = change === 'Project' ? 'C:/Project/other' : PROJECT;
      const nextPath = change === 'target' ? 'src/missing.ts' : 'src/app.ts';
      await f.update(nextProject, `\`${nextPath}\``);
      await act(async () => { release({ size: 10, mtimeMs: 1 }); });
      assert.equal(f.links().length, 0);
      assert.equal(readableText(f.dom.window.document.querySelector('.markdown-link-pending')), nextPath.split('/').at(-1));
      assert.equal(f.toasts.length, 0);
    });
  }

  test(`${pipeline}: changing a verified mention to a missing target removes the link`, async (t) => {
    const f = await mount(t, render, '`src/app.ts`', PROJECT, (f) =>
      installProjectFiles(f, { [PROJECT]: ['src/app.ts'] }));
    assert.equal(f.links().length, 1);
    await f.update(PROJECT, '`src/missing.ts`');
    assert.equal(f.links().length, 0);
    assert.equal(readableText(f.dom.window.document.querySelector('.markdown-link-pending')), 'missing.ts');
    assert.equal(f.toasts.length, 0);
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
    const disabled = [...f.dom.window.document.querySelectorAll('.markdown-link-pending')];
    assert.deepEqual(disabled.map(readableText), ['unsafe', 'data', 'secret.png']);
    for (const item of disabled) {
      assert.equal(item.getAttribute('href'), null);
      assert.equal(item.getAttribute('aria-disabled'), 'true');
      await act(async () => item.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));
    }
    assert.equal(f.external.length, 2);
    assert.equal(f.popups.length, 0);
    assert.notEqual(f.dom.window.document.querySelector('img')?.getAttribute('src'),
      'file:///C:/private/secret.png');
    f.dom.window.mixdogDesktop.openExternal = async () => { throw new Error('browser unavailable'); };
    await f.click();
    assert.deepEqual(f.popups, [['https://example.com/report', '_blank', 'noopener']]);
  });
}

const streamingRenderers = {
  ...Object.fromEntries(Object.entries(renderers).map(([name, render]) => [
    name, (text) => render(healStreamingMarkdownTail(text)),
  ])),
  live: (text) => React.createElement(StreamingMarkdownBody, {
    text, parseText: healStreamingMarkdownTail(text), copyControl: CopyControl,
  }),
};

for (const [pipeline, render] of Object.entries(streamingRenderers)) {
  test(`${pipeline}: streamed link captions never flash brackets or a partial destination`, async (t) => {
    const f = await mount(t, render, 'See [do');
    for (const [source, caption, href] of [
      ['See [do', 'do', null],
      ['See [docs', 'docs', null],
      ['See [docs]', 'docs', null],
      ['See [docs](', 'docs', null],
      ['See [docs](https://example.com/a_(b)', 'docs', null],
      ['See [docs](https://example.com/a_(b))', 'docs', 'https://example.com/a_(b)'],
      ['See [docs](https://example.com/a_(b)) next', 'docs', 'https://example.com/a_(b)'],
    ]) {
      await f.update(PROJECT, source);
      const item = f.dom.window.document.querySelector('a, .markdown-link-pending');
      assert.ok(item, source);
      assert.equal(item.textContent, caption, source);
      assert.equal(item.getAttribute('href'), href, source);
      assert.equal(f.links().length, href ? 1 : 0, source);
      assert.equal(f.dom.window.document.querySelector('p').textContent,
        `See ${caption}${source.endsWith(' next') ? ' next' : ''}`, source);
      if (!href) {
        await act(async () => item.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));
        assert.equal(f.external.length + f.local.length + f.opened.length + f.popups.length, 0, source);
      }
    }
    await f.click();
    assert.deepEqual(f.external, [['https://example.com/a_(b)']]);
  });

  test(`${pipeline}: streamed path captions show the final icon before the destination arrives`, async (t) => {
    const f = await mount(t, render, 'See [src/app.ts');
    let initialIcon;
    for (const source of [
      'See [src/app.ts', 'See [src/app.ts]', 'See [src/app.ts](',
      'See [src/app.ts](src/app.ts', 'See [src/app.ts](src/app.ts)',
    ]) {
      await f.update(PROJECT, source);
      assert.equal(readableText(f.dom.window.document.querySelector('p')), 'See app.ts', source);
      const icon = f.dom.window.document.querySelector('.seti-icon');
      assert.ok(icon, source);
      initialIcon ??= icon.outerHTML;
      assert.equal(icon.outerHTML, initialIcon, source);
      assert.equal(f.links().length, source.endsWith(')') ? 1 : 0, source);
    }
    await f.click();
    assert.deepEqual(f.opened, [[PROJECT, 'src/app.ts', undefined]]);
  });
}
