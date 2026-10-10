import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import MarkdownBody from './MarkdownBody';
import MarkdownAstBody from './MarkdownAstBody';
import { parseMarkdownToHast } from './markdown-ast';
import {
  MarkdownOpenFileContext,
  MarkdownOpenFolderContext,
  MarkdownProjectContext,
  MarkdownSessionContext,
} from './MarkdownLink';
import { onBrowserPageAddressRequested, onBrowserPageRevealRequested } from './browser-page-request';
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
  worker: (text) =>
    React.createElement(MarkdownAstBody, {
      root: parseMarkdownToHast(text),
      copyControl: CopyControl,
    }),
};

async function mount(t, render, text, project = 'C:/Project/conversation', configure = () => {}) {
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  const local = [];
  const external = [];
  const popups = [];
  const toasts = [];
  const opened = [];
  const files = [];
  const folders = [];
  // What main reports back: documents launch ('file'), folders open
  // ('folder'), anything else is handed to the editor ('editor').
  const openResult = (href) => (/[\\/]$/.test(href) || !/\.[a-z0-9]+$/i.test(href) ? 'folder' : 'file');
  dom.window.mixdogDesktop = {
    openLocalFileLink: async (...args) => {
      local.push(args);
      return openResult(args[1]);
    },
    openExternal: async (...args) => {
      external.push(args);
    },
    searchProjectFiles: async () => files.slice(),
  };
  dom.window.open = (...args) => {
    popups.push(args);
  };
  dom.window.addEventListener(DESKTOP_TOAST_EVENT, (event) => toasts.push(event.detail));
  const update = async (nextProject, nextText = text) =>
    act(async () => {
      root.render(
        React.createElement(
          MarkdownProjectContext.Provider,
          { value: nextProject },
          React.createElement(
            MarkdownOpenFolderContext.Provider,
            { value: fixture.dockFolders ? (...args) => folders.push(args) : null },
            React.createElement(
              MarkdownOpenFileContext.Provider,
              {
                value: (...args) => {
                  opened.push(args);
                },
              },
              render(nextText)
            )
          )
        )
      );
    });
  const links = () => [...dom.window.document.querySelectorAll('a')];
  const labels = () => links().map(readableText);
  const click = async (index = 0, options = {}, type = 'click') => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...options });
    await act(async () => {
      links()[index].dispatchEvent(event);
    });
    return event;
  };
  const hover = async (index) => {
    await act(async () => {
      links()[index].dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
    });
  };
  const fixture = { dom, local, external, popups, toasts, opened, folders, files, links, labels, click, hover, update };
  configure(fixture);
  await update(project);
  return fixture;
}

const PROJECT = 'C:/Project/conversation';

test('hovering a document link prefetches its first page once; other links and touch do not', async (t) => {
  const f = await mount(
    t,
    renderers.settled,
    '[Report](docs/report.docx) [Again](docs/report.docx) [Source](src/app.ts) [Scan](docs/a.pdf)',
    PROJECT,
    (fixture) => {
      fixture.prefetched = [];
      fixture.dom.window.mixdogDesktop.previewDocumentPages = async (...args) => {
        fixture.prefetched.push(args);
        throw new Error('ignored');
      };
    }
  );
  installProjectFiles(f, { [PROJECT]: ['docs/report.docx', 'src/app.ts', 'docs/a.pdf'] });
  const enter = async (index, pointerType) => {
    const event = new f.dom.window.MouseEvent('pointerover', { bubbles: true });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    await act(async () => {
      f.links()[index].dispatchEvent(event);
    });
  };
  await enter(0, 'touch');
  await enter(2, 'mouse');
  await enter(3, 'mouse');
  assert.equal(f.prefetched.length, 0);
  await enter(0, 'mouse');
  await enter(1, 'mouse');
  await enter(0, 'mouse');
  assert.equal(f.prefetched.length, 1);
  assert.deepEqual(f.prefetched[0].slice(0, 2), [PROJECT, 'docs/report.docx']);
  assert.deepEqual(f.prefetched[0][3], { pages: [1] });
});

function installProjectFiles(f, entries) {
  const api = f.dom.window.mixdogDesktop;
  api.listProjects = async () => Object.keys(entries).map((path) => ({ path, name: path.split('/').at(-1) }));
  api.statProjectFile = async (project, path) => {
    if (entries[project]?.includes(path)) return { size: 10, mtimeMs: 1 };
    throw Object.assign(new Error(`ENOENT: ${project}/${path}`), { code: 'ENOENT' });
  };
  api.searchProjectFiles = async (project) => entries[project] || [];
  // Main's description of an absolute path: its deepest registered owner.
  api.resolveLocalPaths = async ([absolutePath]) => {
    const target = absolutePath.replace(/\/+$/, '');
    const root = Object.keys(entries)
      .filter((path) => target.toLowerCase().startsWith(`${path.toLowerCase()}/`))
      .sort((left, right) => right.length - left.length)[0];
    const relPath = root ? target.slice(root.length + 1) : '';
    if (!root || !entries[root].includes(relPath)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (absolutePath.endsWith('/')) return [{ absolutePath: target, dir: true, name: relPath, size: 0 }];
    return [
      { absolutePath: target, dir: false, name: relPath.split('/').at(-1), size: 10, projectPath: root, relPath },
    ];
  };
}

// Transcript link format → destination. 'editor' = the side-dock EditorPane
// (code, preview or document viewer) via MarkdownOpenFileContext at a line;
// 'os' = openLocalFileLink; 'browser' = side browser; 'external' = openExternal.
const LINK_ROUTES = [
  ['code :line', 'src/app.ts:12', 'src/app.ts', 'editor', { line: 12 }],
  ['code :line:col', 'src/app.ts:12:3', 'src/app.ts', 'editor', { line: 12, column: 3 }],
  ['code #L', 'src/app.ts#L12', 'src/app.ts', 'editor', { line: 12 }],
  ['json', 'config/app.json', 'config/app.json', 'editor', {}],
  ['yaml', 'config/ci.yaml', 'config/ci.yaml', 'editor', {}],
  ['txt', 'notes/a.txt', 'notes/a.txt', 'editor', {}],
  ['markdown (Preview toggle)', 'docs/readme.md', 'docs/readme.md', 'editor', {}],
  ['csv (Table toggle)', 'data/t.csv', 'data/t.csv', 'editor', {}],
  ['tsv (Table toggle)', 'data/t.tsv', 'data/t.tsv', 'editor', {}],
  ['png preview', 'img/a.png', 'img/a.png', 'editor', {}],
  ['jpg preview', 'img/a.jpg', 'img/a.jpg', 'editor', {}],
  ['gif preview', 'img/a.gif', 'img/a.gif', 'editor', {}],
  ['webp preview', 'img/a.webp', 'img/a.webp', 'editor', {}],
  ['svg preview', 'img/a.svg', 'img/a.svg', 'editor', {}],
  ['pdf preview', 'docs/a.pdf', 'docs/a.pdf', 'editor', {}],
  ['docx document preview', 'docs/a.docx', 'docs/a.docx', 'editor', {}],
  ['xlsx document preview', 'docs/a.xlsx', 'docs/a.xlsx', 'editor', {}],
  ['pptx document preview', 'docs/a.pptx', 'docs/a.pptx', 'editor', {}],
  ['bare name resolved by search', 'app.ts', 'src/app.ts', 'editor', {}],
  ['spaces, # and Korean', 'docs/%ED%95%9C%EA%B8%80%20%231.md', 'docs/한글 #1.md', 'editor', {}],
  ['percent sign', 'docs/100%25.txt', 'docs/100%.txt', 'editor', {}],
  ['archive (no in-app viewer)', 'out/a.zip', 'out/a.zip', 'os', {}],
  ['folder (no pane Explorer view)', 'output/', null, 'os', {}],
];

test('transcript link formats land in the side editor, side browser or OS as tabulated', async (t) => {
  const files = [...new Set(LINK_ROUTES.map((row) => row[2]).filter(Boolean)), 'site/index.html', 'output'];
  for (const [label, href, rel, destination, expected] of LINK_ROUTES) {
    await t.test(label, async (sub) => {
      const f = await mount(sub, renderers.settled, `[x](${href})`, PROJECT, (fixture) => {
        installProjectFiles(fixture, { [PROJECT]: files });
      });
      await f.click();
      if (destination === 'editor') {
        const column = expected.column ? [undefined, expected.column] : [];
        assert.deepEqual(f.opened, [[PROJECT, rel, expected.line, ...column]], `${label}: side editor`);
        assert.deepEqual(f.local, [], `${label}: not the OS`);
      } else {
        assert.deepEqual(f.opened, [], `${label}: not the editor`);
        assert.equal(f.local.length, 1, `${label}: OS`);
      }
      assert.equal(f.external.length, 0, label);
    });
  }
});

test('a Project folder link reveals the dock Files tree, never the file manager', async (t) => {
  const f = await mount(
    t,
    renderers.settled,
    [`[a](assets/)`, `[b](output)`, `[c](${PROJECT}/assets/)`, `[d](Makefile)`].join('\n\n'),
    PROJECT,
    (fixture) => {
      fixture.dockFolders = true;
      installProjectFiles(fixture, { [PROJECT]: ['assets', 'assets/', 'output', 'Makefile'] });
      // Only directories list; a file fails like a real ENOTDIR.
      fixture.dom.window.mixdogDesktop.listProjectDir = async (_project, rel) => {
        if (rel === 'output') return [];
        throw new Error('ENOTDIR');
      };
    }
  );
  for (let index = 0; index < 3; index++) await f.click(index);
  assert.deepEqual(
    f.folders.map(([project, rel]) => [project, rel.replace(/\/+$/, '')]),
    [
      [PROJECT, 'assets'],
      [PROJECT, 'output'],
      [PROJECT, 'assets'],
    ]
  );
  assert.deepEqual(f.local, [], 'the OS file manager is not used');
  assert.deepEqual(f.opened, []);
});

test('an absolute folder opens the dock tree through its deepest registered Project', async (t) => {
  const nested = 'D:/work/app/docs/';
  const f = await mount(t, renderers.settled, `[x](${nested})`, PROJECT, (fixture) => {
    fixture.dockFolders = true;
    const api = fixture.dom.window.mixdogDesktop;
    api.listProjects = async () => [
      { path: 'D:/work', name: 'work' },
      { path: 'D:/work/app', name: 'app' },
    ];
    api.resolveLocalPaths = async ([absolutePath]) => [{ absolutePath, dir: true, name: 'docs', size: 0 }];
  });
  await f.click();
  assert.deepEqual(f.folders, [['D:/work/app', 'docs']]);
  assert.deepEqual(f.local, []);
});

test('an absolute folder in no registered Project keeps the file manager', async (t) => {
  const f = await mount(t, renderers.settled, '[x](C:/unregistered/docs/)', PROJECT, (fixture) => {
    fixture.dockFolders = true;
    const api = fixture.dom.window.mixdogDesktop;
    api.listProjects = async () => [{ path: PROJECT, name: 'conversation' }];
    api.resolveLocalPaths = async ([absolutePath]) => [{ absolutePath, dir: true, name: 'docs', size: 0 }];
  });
  await f.click();
  assert.deepEqual(f.folders, []);
  assert.equal(f.local.length, 1);
});

test('folders outside the Project, or without a dock, keep the file manager', async (t) => {
  const outside = await mount(t, renderers.settled, '[x](D:/elsewhere/)', PROJECT, (fixture) => {
    fixture.dockFolders = true;
    fixture.dom.window.mixdogDesktop.resolveLocalPaths = async ([absolutePath]) => [
      { absolutePath, dir: true, name: 'elsewhere', size: 0 },
    ];
  });
  await outside.click();
  assert.deepEqual(outside.folders, []);
  assert.equal(outside.local.length, 1);
});

test('a folder link without a dock keeps the file manager', async (t) => {
  const phone = await mount(t, renderers.settled, '[x](assets/)', PROJECT, (fixture) => {
    installProjectFiles(fixture, { [PROJECT]: ['assets', 'assets/'] });
  });
  await phone.click();
  assert.deepEqual(phone.folders, []);
  assert.equal(phone.local.length, 1);
});

test('a path outside the Project opens in the side editor with its access token', async (t) => {
  const f = await mount(t, renderers.settled, '[x](C:/private/source.ts:7)', PROJECT, (fixture) => {
    fixture.dom.window.mixdogDesktop.resolveLocalPaths = async ([absolutePath]) => [
      { absolutePath, projectPath: 'C:/private', relPath: 'source.ts', accessToken: 'grant', dir: false },
    ];
  });
  await f.click();
  assert.deepEqual(f.opened, [['C:/private', 'source.ts', 7, 'grant']]);
  assert.deepEqual(f.local, []);
});

test('html goes to the side browser; http(s) to the side browser with a session, else the system browser', async (t) => {
  const withSession = (text) =>
    React.createElement(MarkdownSessionContext.Provider, { value: 'sess-routes' }, renderers.settled(text));
  const stopReveal = onBrowserPageRevealRequested(() => {});
  t.after(stopReveal);
  const f = await mount(
    t,
    withSession,
    '[page](site/index.html) [web](https://example.com/a) [plain](http://example.com/b)',
    PROJECT,
    (fixture) => {
      installProjectFiles(fixture, { [PROJECT]: ['site/index.html'] });
      fixture.dom.window.mixdogDesktop.localPageUrl = async (_project, rel) => `http://127.0.0.1:9/token/${rel}`;
    }
  );
  const loaded = [];
  for (let index = 0; index < 3; index++) {
    await f.click(index);
    onBrowserPageAddressRequested('sess-routes', (url) => loaded.push(url))();
  }
  assert.deepEqual(loaded, [
    'http://127.0.0.1:9/token/site/index.html',
    'https://example.com/a',
    'http://example.com/b',
  ]);
  assert.deepEqual(f.external, []);
  assert.deepEqual(f.opened, []);
});

test('http(s) without a session falls back to the system browser', async (t) => {
  const draft = await mount(t, renderers.settled, '[web](https://example.com/draft)');
  await draft.click();
  assert.deepEqual(draft.external, [['https://example.com/draft']]);
});

for (const [pipeline, render] of Object.entries(renderers)) {
  test(`${pipeline}: files in another registered Project open without changing the conversation Project`, async (t) => {
    const other = 'C:/Project/GamerScroll';
    const f = await mount(
      t,
      render,
      [
        '`favicon.svg`',
        '[relative](assets/aiscroll-favicon.svg)',
        `[absolute](${other}/assets/aiscroll-favicon.svg)`,
        `[document](file:///${other}/output/report.pptx)`,
        `[source](${other}/src/app.ts:12)`,
        `[folder](${other}/output/)`,
        `[script](${other}/run.ps1)`,
      ].join('\n\n'),
      PROJECT,
      (f) =>
        installProjectFiles(f, {
          [PROJECT]: [],
          [other]: [
            'favicon.svg',
            'assets/aiscroll-favicon.svg',
            'output/report.pptx',
            'src/app.ts',
            'output',
            'run.ps1',
          ],
        })
    );
    for (let index = 0; index < 7; index++) await f.click(index);
    assert.deepEqual(f.opened, [
      [other, 'favicon.svg', undefined],
      [other, 'assets/aiscroll-favicon.svg', undefined],
      [other, 'assets/aiscroll-favicon.svg', undefined],
      [other, 'output/report.pptx', undefined],
      [other, 'src/app.ts', 12],
      [other, 'run.ps1', undefined],
    ]);
    assert.deepEqual(f.local, [[`${other}/output`, '.']]);
    assert.equal(f.links()[0].title, `${other}/favicon.svg`);
    assert.equal(f.toasts.length + f.external.length + f.popups.length, 0);
  });

  test(`${pipeline}: automatic mentions link across Projects, verified once per name`, async (t) => {
    const other = 'C:/Project/GamerScroll';
    const calls = [];
    const f = await mount(
      t,
      render,
      [
        '`favicon.svg` and `app.ts` changed.',
        'Again `favicon.svg`, `app.ts:3` and `app.ts` (line 9).',
        'Also `src/only-there.ts` and `src/app.ts`.',
      ].join('\n\n'),
      PROJECT,
      (f) => {
        installProjectFiles(f, {
          [PROJECT]: ['src/app.ts'],
          [other]: ['favicon.svg', 'src/only-there.ts'],
        });
        const api = f.dom.window.mixdogDesktop;
        for (const method of ['listProjects', 'statProjectFile', 'searchProjectFiles']) {
          const original = api[method];
          api[method] = (...args) => {
            calls.push([method, ...args]);
            return original(...args);
          };
        }
      }
    );
    // Names found only in another Project link there; nothing stays pending.
    assert.equal(f.links().length, 7);
    assert.equal(f.dom.window.document.querySelectorAll('.markdown-link-pending').length, 0);
    assert.equal(f.links().filter((a) => a.title.startsWith(`${other}/`)).length, 3);
    const count = (method, project, path) =>
      calls.filter((call) => call[0] === method && call[1] === project && call[2] === path).length;
    // Five mentions of two bare names: one stat and one index search each in
    // the conversation Project, and other Projects only for the missing name.
    assert.equal(count('statProjectFile', PROJECT, 'favicon.svg'), 1);
    assert.equal(count('searchProjectFiles', PROJECT, 'favicon.svg'), 1);
    assert.equal(count('statProjectFile', PROJECT, 'app.ts'), 1);
    assert.equal(count('searchProjectFiles', PROJECT, 'app.ts'), 1);
    assert.equal(calls.filter((call) => call[1] === other && call[2] === 'app.ts').length, 0);
    // A click on an automatic link opens the verified target without searching again.
    const searches = calls.length;
    await f.click(3);
    assert.deepEqual(f.opened, [[PROJECT, 'src/app.ts', 3]]);
    assert.equal(calls.length, searches);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: cwd changes retarget file links and discard the previous Project tooltip`, async (t) => {
    const other = 'C:/Project/GamerScroll';
    const f = await mount(t, render, '`src/app.ts`', PROJECT, (f) =>
      installProjectFiles(f, { [PROJECT]: ['src/app.ts'], [other]: ['src/app.ts'] })
    );
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
    const f = await mount(
      t,
      render,
      [
        '`C:/private/source.ts:12`',
        '[encoded](file:///C:/private/%ED%95%9C%EA%B8%80%20100%25%20%231.ts#L7)',
        '[document](C:/private/report.pdf)',
        '[folder](C:/private/output/)',
        '[script](C:/private/run.ps1)',
        '[posix](/tmp/outside.ts:9)',
      ].join('\n\n'),
      PROJECT,
      (f) => {
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
      }
    );
    assert.equal(f.links().length, 6);
    for (let index = 0; index < 6; index++) await f.click(index);
    assert.deepEqual(f.opened, [
      [outside, 'source.ts', 12, 'grant:source.ts'],
      [outside, '한글 100% #1.ts', 7, 'grant:한글 100% #1.ts'],
      [outside, 'report.pdf', undefined, 'grant:report.pdf'],
      [outside, 'run.ps1', undefined, 'grant:run.ps1'],
      ['/tmp', 'outside.ts', 9, 'grant:outside.ts'],
    ]);
    assert.deepEqual(f.local, [[`${outside}/output`, '.']]);
    assert.equal(f.toasts.length + f.external.length + f.popups.length, 0);
  });

  test(`${pipeline}: an extension-less drive path in inline code is a folder link once it exists`, async (t) => {
    const folder = 'C:/Users/me/AppData/Local/Temp/mixdog-refs-9a64';
    const f = await mount(
      t,
      render,
      'See `C:\\Users\\me\\AppData\\Local\\Temp\\mixdog-refs-9a64` or `C:\\missing\\refs`.',
      PROJECT,
      (f) => {
        installProjectFiles(f, { [PROJECT]: [] });
        f.dom.window.mixdogDesktop.resolveLocalPaths = async ([absolutePath]) => {
          if (absolutePath !== `${folder}/`) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return [{ absolutePath: folder, dir: true, name: 'mixdog-refs-9a64', size: 0 }];
        };
      }
    );
    assert.equal(readableText(f.dom.window.document.querySelector('p')), 'See mixdog-refs-9a64/ or C:\\missing\\refs.');
    assert.deepEqual(f.labels(), ['mixdog-refs-9a64/']);
    assert.equal(f.links()[0].querySelector('.seti-icon').getAttribute('data-icon-kind'), 'folder');
    await f.click(0);
    assert.deepEqual(f.local, [[folder, '.']]);
    assert.equal(f.opened.length + f.toasts.length, 0);
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
    const f = await mount(
      t,
      render,
      [
        '[source](Server/ServerConnectionRecovery.cs:8)',
        '[ambiguous](Server/duplicate.cs)',
        '[missing](Server/missing.cs)',
      ].join('\n\n'),
      PROJECT,
      (f) =>
        installProjectFiles(f, {
          [PROJECT]: [],
          [other]: [
            'Assets/Scripts/Server/ServerConnectionRecovery.cs',
            'Assets/Scripts/Server/ServerConnectionRecovery.cs.bak',
            'a/Server/duplicate.cs',
            'b/Server/duplicate.cs',
            'Server/missing.cs.bak',
          ],
        })
    );
    await f.click(0);
    await f.click(1);
    await f.click(2);
    assert.deepEqual(f.opened, [[other, 'Assets/Scripts/Server/ServerConnectionRecovery.cs', 8]]);
    assert.match(f.toasts[0].text, /Several files/);
    assert.match(f.toasts[1].text, /File not found/);
  });

  test(`${pipeline}: missing external, traversal and network files report not found without a namesake fallback`, async (t) => {
    const requests = [];
    const f = await mount(
      t,
      render,
      [
        '[missing](C:/private/missing.ts)',
        '[traversal](../../private/missing.ts)',
        '[network](file://server/share/missing.ts)',
        '[encoded network](/%2Fserver/share/missing.ts)',
      ].join('\n\n'),
      PROJECT,
      (f) => {
        installProjectFiles(f, { [PROJECT]: ['src/missing.ts'] });
        f.dom.window.mixdogDesktop.resolveLocalPaths = async (paths) => {
          requests.push(paths);
          throw Object.assign(new Error('ENOENT: external file is missing'), { code: 'ENOENT' });
        };
      }
    );
    for (let index = 0; index < 4; index++) await f.click(index);
    assert.deepEqual(requests, [
      ['C:/private/missing.ts'],
      ['C:/Project/conversation/../../private/missing.ts'],
      ['//server/share/missing.ts'],
      ['//server/share/missing.ts'],
    ]);
    assert.equal(f.toasts.length, 4);
    assert.ok(f.toasts.every((toast) => /File not found/.test(toast.text)));
    assert.equal(f.opened.length + f.local.length + f.popups.length, 0);
  });

  test(`${pipeline}: missing local files do not guess between other Projects or escape registered roots`, async (t) => {
    const other = 'C:/Project/GamerScroll';
    const third = 'C:/Project/another';
    const f = await mount(
      t,
      render,
      [
        '[favicon.svg](./favicon.svg)',
        '[outside](C:/private/secret.svg)',
        '[traversal](../../private/secret.svg)',
        '[network](file://server/share/secret.svg)',
      ].join('\n\n')
    );
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
    assert.deepEqual(f.local, []);
  });

  test(`${pipeline}: access failures are reported rather than redirected to another Project`, async (t) => {
    const f = await mount(t, render, '[favicon.svg](./favicon.svg)');
    installProjectFiles(f, { [PROJECT]: [], 'C:/Project/other': ['favicon.svg'] });
    f.dom.window.mixdogDesktop.statProjectFile = async () => {
      throw new Error('Path resolves outside the project.');
    };
    await f.click();
    assert.match(f.toasts[0].text, /Path resolves outside/);
    assert.equal(f.opened.length + f.local.length, 0);
  });

  test(`${pipeline}: documents, media and text open in the editor and OS-only files launch, in the owning Project`, async (t) => {
    const paths = [
      'output/ai-work-proposal-20260907/ai-work-proposal-delivery.pptx',
      'output/ai-work-proposal-20260907/ai-work-proposal-delivery.mixdog-preview.pdf',
      'output/ai-work-proposal-20260907/verification-summary.md',
      'output/archive.zip',
      'output/scan.tiff',
    ];
    const f = await mount(t, render, paths.map((path, index) => `[file ${index}](${path})`).join('\n\n'));
    for (let index = 0; index < paths.length; index++) {
      assert.equal((await f.click(index)).defaultPrevented, true);
    }
    assert.deepEqual(f.local, [
      [PROJECT, paths[3]],
      [PROJECT, paths[4]],
    ]);
    assert.deepEqual(
      f.opened,
      paths.slice(0, 3).map((path) => [PROJECT, path, undefined])
    );
    await f.update('D:/Project/other-conversation');
    await f.click();
    await f.click(2);
    assert.deepEqual(f.local.length, 2);
    assert.deepEqual(f.opened.at(-2), ['D:/Project/other-conversation', paths[0], undefined]);
    assert.deepEqual(f.opened.at(-1), ['D:/Project/other-conversation', paths[2], undefined]);
    assert.equal(f.external.length + f.popups.length + f.toasts.length, 0);
  });

  test(`${pipeline}: absolute paths and file URLs resolve through their owning Project; missing ones report not found`, async (t) => {
    const f = await mount(
      t,
      render,
      [
        '[drive](C:/Project/conversation/output/deck.pptx)',
        '[backslashes](<C:\\Project\\conversation\\output\\deck.pptx>)',
        '[file](file:///C:/Project/conversation/output/preview.pdf)',
        '[source](C:/Project/conversation/src/app.ts:42)',
        '[posix](/home/user/project/report.md)',
      ].join('\n\n'),
      PROJECT,
      (f) => installProjectFiles(f, { [PROJECT]: ['output/deck.pptx', 'output/preview.pdf', 'src/app.ts'] })
    );
    for (let index = 0; index < 5; index++) {
      assert.ok(f.links()[index].getAttribute('href'));
      assert.equal((await f.click(index)).defaultPrevented, true);
    }
    assert.deepEqual(f.local, []);
    assert.deepEqual(f.opened, [
      [PROJECT, 'output/deck.pptx', undefined],
      [PROJECT, 'output/deck.pptx', undefined],
      [PROJECT, 'output/preview.pdf', undefined],
      [PROJECT, 'src/app.ts', 42],
    ]);
    assert.equal(f.links()[3].getAttribute('title'), 'C:/Project/conversation/src/app.ts:42');
    assert.equal(f.toasts.length, 1);
    assert.match(f.toasts[0].text, /File not found/);
    assert.equal(f.external.length, 0);
  });

  test(`${pipeline}: file mentions in prose and inline code become editor links with their line`, async (t) => {
    const f = await mount(
      t,
      render,
      [
        'Fixed src/runtime/agent.mjs:269 and `apps/desktop/src/main/ipc.ts` (line 12, col 4).',
        'Only `retry-classifier.mjs` (line 269) changed; see C:\\Project\\conversation\\docs\\notes.md#L7 too.',
        'Not links: https://example.com/docs/guide.md, node.js, and/or, v1.2/3.4, `npm/registry`.',
        '```\nsrc/skipped.ts:1\n```',
      ].join('\n\n'),
      PROJECT,
      (f) =>
        installProjectFiles(f, {
          [PROJECT]: [
            'src/runtime/agent.mjs',
            'apps/desktop/src/main/ipc.ts',
            'docs/notes.md',
            'src/runtime/agent/orchestrator/providers/retry-classifier.mjs',
            'src/x/retry-classifier.mjs.bak',
          ],
        })
    );
    assert.deepEqual(
      f.links().map((a) => a.getAttribute('href')),
      [
        'src/runtime/agent.mjs:269',
        'apps/desktop/src/main/ipc.ts:12:4',
        './retry-classifier.mjs:269',
        'C:\\Project\\conversation\\docs\\notes.md:7',
        'https://example.com/docs/guide.md',
      ]
    );
    // Every mention uses its final icon + filename + line from the first paint.
    assert.deepEqual(f.labels().slice(0, 4), [
      'agent.mjs:269',
      'ipc.ts:12:4',
      'retry-classifier.mjs:269',
      'notes.md:7',
    ]);
    assert.ok(
      f
        .links()
        .slice(0, 4)
        .every((a) => a.className === 'markdown-path-link' && a.querySelector('.seti-icon'))
    );
    assert.equal(f.links()[4].querySelector('.seti-icon').getAttribute('data-icon-kind'), 'external');
    assert.equal(f.links()[0].getAttribute('title'), 'C:/Project/conversation/src/runtime/agent.mjs:269');
    for (let index = 0; index < 4; index++) {
      assert.equal((await f.click(index)).defaultPrevented, true);
    }
    assert.deepEqual(f.opened, [
      [PROJECT, 'src/runtime/agent.mjs', 269],
      [PROJECT, 'apps/desktop/src/main/ipc.ts', 12, undefined, 4],
      [PROJECT, 'src/runtime/agent/orchestrator/providers/retry-classifier.mjs', 269],
      [PROJECT, 'docs/notes.md', 7],
    ]);
    await f.hover(2);
    assert.equal(
      f.links()[2].getAttribute('title'),
      'C:/Project/conversation/src/runtime/agent/orchestrator/providers/retry-classifier.mjs:269'
    );
    assert.equal(f.local.length + f.toasts.length, 0);
  });

  test(`${pipeline}: explicit links keep a real caption but collapse a path caption to the file name`, async (t) => {
    const f = await mount(
      t,
      render,
      [
        '[수정 요약](output/report.md)',
        '[src/app.ts](src/app.ts)',
        '[deck](output/deck.pptx)',
        '[output/deck.pptx](output/deck.pptx)',
      ].join('\n\n')
    );
    assert.deepEqual(f.labels(), ['수정 요약', 'app.ts', 'deck', 'deck.pptx']);
    assert.deepEqual(
      f.links().map((a) => Boolean(a.querySelector('.seti-icon'))),
      [true, true, true, true]
    );
    assert.deepEqual(
      f.links().map((a) => a.getAttribute('title')),
      [
        'C:/Project/conversation/output/report.md',
        'C:/Project/conversation/src/app.ts',
        'C:/Project/conversation/output/deck.pptx',
        'C:/Project/conversation/output/deck.pptx',
      ]
    );
    await f.click(1);
    await f.click(3);
    assert.deepEqual(f.opened, [
      [PROJECT, 'src/app.ts', undefined],
      [PROJECT, 'output/deck.pptx', undefined],
    ]);
    assert.deepEqual(f.local, []);
  });

  test(`${pipeline}: folders, document names with spaces, extension-less files, Korean line refs and images`, async (t) => {
    const f = await mount(
      t,
      render,
      [
        '산출물은 output/report-2026/ 폴더에 있고 입력/출력 구분은 링크가 아닙니다.',
        '`Dockerfile`과 `.gitignore`를 수정했고 `src/app.ts`:42 및 `src/util.ts` 269번 줄, `src/x.ts` (7줄)도 봤습니다.',
        '`output/제안서 최종.pptx`와 `output/` 참고. `python scripts/run.py`, `@mixdog/desktop`, `npm run build`는 아닙니다.',
        '선택자 `.workspace`, `.main-panel`도 파일이 아니지만 `.env.local`은 파일입니다.',
        '![차트](output/chart.png)',
      ].join('\n\n'),
      PROJECT,
      (f) =>
        installProjectFiles(f, {
          [PROJECT]: [
            'output/report-2026',
            'Dockerfile',
            '.gitignore',
            'src/app.ts',
            'src/util.ts',
            'src/x.ts',
            'output/제안서 최종.pptx',
            'output',
            '.env.local',
            'output/chart.png',
          ],
        })
    );
    assert.equal(
      f
        .links()
        .find((a) => a.querySelector('.seti-icon:not([data-icon-kind])'))
        ?.querySelector('.seti-icon')?.textContent.length,
      1
    );
    assert.equal(f.links()[0].querySelector('.seti-icon').getAttribute('data-icon-kind'), 'folder');
    assert.deepEqual(
      f.links().map((a) => a.getAttribute('href')),
      [
        'output/report-2026/',
        './Dockerfile',
        './.gitignore',
        'src/app.ts:42',
        'src/util.ts:269',
        'src/x.ts:7',
        'output/제안서 최종.pptx',
        'output/',
        './.env.local',
        'output/chart.png',
      ]
    );
    assert.deepEqual(f.labels(), [
      'report-2026/',
      'Dockerfile',
      '.gitignore',
      'app.ts:42',
      'util.ts:269',
      'x.ts:7',
      '제안서 최종.pptx',
      'output/',
      '.env.local',
      'chart.png',
    ]);
    assert.equal(f.dom.window.document.querySelector('img'), null);
    for (let index = 0; index < 10; index++) await f.click(index);
    // Folders, documents and extension-less names go through main; text files
    // with an extension open in the editor directly.
    assert.deepEqual(f.local, [
      [PROJECT, 'output/report-2026'],
      [PROJECT, 'Dockerfile'],
      [PROJECT, 'output'],
    ]);
    assert.deepEqual(f.opened, [
      [PROJECT, '.gitignore', undefined],
      [PROJECT, 'src/app.ts', 42],
      [PROJECT, 'src/util.ts', 269],
      [PROJECT, 'src/x.ts', 7],
      [PROJECT, 'output/제안서 최종.pptx', undefined],
      [PROJECT, '.env.local', undefined],
      [PROJECT, 'output/chart.png', undefined],
    ]);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: drive paths with spaces and parentheses in inline code become links`, async (t) => {
    const root = 'C:/Users/me/바탕 화면/새 폴더 (3)';
    const win = 'C:\\Users\\me\\바탕 화면\\새 폴더 (3)';
    const f = await mount(
      t,
      render,
      [
        `\`${win}\\promo\``,
        `\`${win}\\promo\\index.html\``,
        `\`${win}\\promo\\cards\\card-1.png\``,
        `\`${win}\\R&D, Tom's [v2]\\PROGRA~1!\\a.png\``,
        `[card](<${win}\\promo\\cards\\card-1.png>)`,
      ].join('\n\n'),
      PROJECT,
      (f) =>
        installProjectFiles(f, {
          [PROJECT]: [],
          [root]: ['promo', 'promo/index.html', 'promo/cards/card-1.png', "R&D, Tom's [v2]/PROGRA~1!/a.png"],
        })
    );
    assert.deepEqual(f.labels(), ['promo/', 'index.html', 'card-1.png', 'a.png', 'card']);
    for (let index = 0; index < 5; index++) await f.click(index);
    assert.deepEqual(f.local, [[`${root}/promo`, '.']]);
    assert.deepEqual(f.opened, [
      [root, 'promo/index.html', undefined],
      [root, 'promo/cards/card-1.png', undefined],
      [root, "R&D, Tom's [v2]/PROGRA~1!/a.png", undefined],
      [root, 'promo/cards/card-1.png', undefined],
    ]);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: main hands text files back to the editor after probing an extension-less name`, async (t) => {
    const f = await mount(t, render, 'See `scripts/Dockerfile` and `docs/` here.', PROJECT, (f) =>
      installProjectFiles(f, { [PROJECT]: ['scripts/Dockerfile', 'docs'] })
    );
    f.dom.window.mixdogDesktop.openLocalFileLink = async (...args) => {
      f.local.push(args);
      return args[1] === 'scripts/Dockerfile' ? 'editor' : 'folder';
    };
    await f.click(0);
    await f.click(1);
    assert.deepEqual(f.local, [
      [PROJECT, 'scripts/Dockerfile'],
      [PROJECT, 'docs'],
    ]);
    assert.deepEqual(f.opened, [[PROJECT, 'scripts/Dockerfile', undefined]]);
  });

  test(`${pipeline}: planned, missing and ambiguous mentions fall back to their original text`, async (t) => {
    const f = await mount(
      t,
      render,
      [
        '스펙 문서(`special_offer_server_spec.md`)를 작성하겠습니다.',
        'See docs/planned.md (line 12), `missing.ts`, `dup.ts`, missing/ and `missing-folder/`.',
      ].join('\n\n'),
      PROJECT,
      (f) =>
        installProjectFiles(f, {
          [PROJECT]: ['a/dup.ts', 'b/dup.ts'],
        })
    );
    assert.equal(f.links().length, 0);
    const document = f.dom.window.document;
    assert.deepEqual(
      [...document.querySelectorAll('p')].map((p) => p.textContent),
      [
        '스펙 문서(special_offer_server_spec.md)를 작성하겠습니다.',
        'See docs/planned.md (line 12), missing.ts, dup.ts, missing/ and missing-folder/.',
      ]
    );
    assert.equal(document.querySelectorAll('.markdown-link-pending, .seti-icon').length, 0);
    const missing = [...document.querySelectorAll('.markdown-path-missing')];
    assert.equal(missing.length, 6);
    // Inline code mentions keep their code formatting.
    assert.equal(missing.filter((item) => item.querySelector('code')).length, 4);
    for (const item of missing) {
      await act(async () => item.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));
    }
    assert.equal(f.toasts.length, 0);
    assert.equal(f.opened.length + f.local.length + f.popups.length, 0);
  });

  test(`${pipeline}: automatic links show their final icons immediately and enable clicking only after verification`, async (t) => {
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
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
    await act(async () => {
      release({ size: 10, mtimeMs: 1 });
    });
    assert.deepEqual(f.labels(), ['app.ts:12:4']);
    assert.equal(f.dom.window.document.querySelector('p').textContent, initialText);
    assert.equal(f.links()[0].querySelector('.seti-icon').outerHTML, initialIcon);
    assert.equal(f.links()[0].title, `${PROJECT}/src/app.ts:12:4`);
    await f.click();
    assert.deepEqual(f.opened, [[PROJECT, 'src/app.ts', 12, undefined, 4]]);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: automatic mentions cannot use the resolver's no-stat compatibility fallback`, async (t) => {
    const f = await mount(t, render, '`src/app.ts`, output/ and `found.ts`.', PROJECT, (f) => {
      f.files.push('found.ts');
    });
    assert.equal(f.links().length, 0);
    assert.equal(readableText(f.dom.window.document.querySelector('p')), 'src/app.ts, output/ and found.ts.');
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: stale file-search results do not become automatic links`, async (t) => {
    const f = await mount(t, render, '`stale.ts`', PROJECT, (f) => {
      installProjectFiles(f, { [PROJECT]: [] });
      f.dom.window.mixdogDesktop.searchProjectFiles = async () => ['src/stale.ts'];
    });
    assert.equal(f.links().length, 0);
    assert.equal(readableText(f.dom.window.document.querySelector('.markdown-path-missing')), 'stale.ts');
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: inaccessible automatic mentions remain text without error toasts or redirection`, async (t) => {
    const f = await mount(t, render, '`favicon.svg` and `C:/private/secret.svg`', PROJECT, (f) => {
      installProjectFiles(f, { [PROJECT]: [], 'C:/Project/other': ['favicon.svg'] });
      f.dom.window.mixdogDesktop.statProjectFile = async () => {
        throw new Error('Path resolves outside the project.');
      };
    });
    assert.equal(f.links().length, 0);
    assert.equal(f.toasts.length + f.opened.length + f.local.length, 0);
  });

  test(`${pipeline}: relative automatic mentions without a conversation Project remain text`, async (t) => {
    const f = await mount(t, render, '`src/app.ts`', '', (f) => installProjectFiles(f, { [PROJECT]: ['src/app.ts'] }));
    assert.equal(f.links().length, 0);
    assert.equal(f.toasts.length, 0);
  });

  for (const change of ['Project', 'target']) {
    test(`${pipeline}: pending automatic verification cannot link a different ${change}`, async (t) => {
      let release;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
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
      await act(async () => {
        release({ size: 10, mtimeMs: 1 });
      });
      assert.equal(f.links().length, 0);
      assert.equal(readableText(f.dom.window.document.querySelector('.markdown-path-missing')), nextPath);
      assert.equal(f.toasts.length, 0);
    });
  }

  test(`${pipeline}: changing a verified mention to a missing target removes the link`, async (t) => {
    const f = await mount(t, render, '`src/app.ts`', PROJECT, (f) =>
      installProjectFiles(f, { [PROJECT]: ['src/app.ts'] })
    );
    assert.equal(f.links().length, 1);
    await f.update(PROJECT, '`src/missing.ts`');
    assert.equal(f.links().length, 0);
    assert.equal(readableText(f.dom.window.document.querySelector('.markdown-path-missing')), 'src/missing.ts');
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: local errors, absent desktop support and absent Project are visible, never navigated`, async (t) => {
    const f = await mount(t, render, '[file](output/archive.zip)');
    f.dom.window.mixdogDesktop.openLocalFileLink = async () => {
      throw new Error(
        "Error invoking remote method 'mixdog:open-local-file-link': Error: The file no longer exists: output/archive.zip"
      );
    };
    assert.equal((await f.click()).defaultPrevented, true);
    assert.match(f.toasts.at(-1).text, /The file no longer exists: output\/archive\.zip/);
    assert.doesNotMatch(f.toasts.at(-1).text, /invoking remote method|Error:/);
    delete f.dom.window.mixdogDesktop.openLocalFileLink;
    await f.click();
    assert.equal(f.toasts.length, 2);
    f.dom.window.mixdogDesktop.openLocalFileLink = async (...args) => {
      f.local.push(args);
    };
    await f.update('');
    await f.click();
    assert.equal(f.toasts.length, 3);
    assert.ok(f.toasts.every((toast) => toast.tone === 'error' && toast.text));
    assert.equal(f.local.length + f.popups.length, 0);
  });

  test(`${pipeline}: right-clicking a local file link offers open, default app, reveal and copy path; web links get none`, async (t) => {
    const f = await mount(t, render, ['[deck](output/deck.pptx)', '[web](https://example.com/a)'].join('\n\n'));
    const calls = [];
    f.dom.window.mixdogDesktop.openFilePath = async (...args) => calls.push(['open', ...args]);
    f.dom.window.mixdogDesktop.revealFile = async (...args) => calls.push(['reveal', ...args]);
    const copied = [];
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const desktopNavigator = {
      userAgent: 'Electron/41.0',
      clipboard: { writeText: async (text) => copied.push(text) },
    };
    t.after(() => Object.defineProperty(globalThis, 'navigator', previousNavigator));
    const menuItems = () => [...f.dom.window.document.querySelectorAll('[role="menu"] [role="menuitem"]')];
    const labelsOf = () => menuItems().map((item) => item.textContent);
    const contextMenu = async (index) => {
      const event = new f.dom.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 5,
        clientY: 6,
      });
      await act(async () => f.links()[index].dispatchEvent(event));
      return event;
    };
    f.dom.window.mixdogRemoteServer = 'https://relay.test';
    assert.equal((await contextMenu(1)).defaultPrevented, true);
    assert.deepEqual(labelsOf(), ['Open in browser', 'Copy link']);
    await act(async () =>
      f.dom.window.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
    );
    // A remote browser has no OS bridge, so only the in-app actions appear.
    assert.equal((await contextMenu(0)).defaultPrevented, true);
    assert.deepEqual(labelsOf(), ['Open', 'Copy path']);
    await act(async () =>
      f.dom.window.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
    );
    delete f.dom.window.mixdogRemoteServer;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: desktopNavigator });
    await contextMenu(0);
    assert.deepEqual(labelsOf(), ['Open', 'Open in default app', 'Reveal in Explorer', 'Copy path']);
    await act(async () => menuItems()[1].click());
    await act(async () => {});
    await contextMenu(0);
    await act(async () => menuItems()[2].click());
    await act(async () => {});
    await contextMenu(0);
    await act(async () => menuItems()[3].click());
    await act(async () => {});
    await contextMenu(0);
    await act(async () => menuItems()[0].click());
    await act(async () => {});
    assert.deepEqual(calls, [
      ['open', PROJECT, 'output/deck.pptx', undefined],
      ['reveal', PROJECT, 'output/deck.pptx', undefined],
    ]);
    assert.deepEqual(copied, [`${PROJECT}/output/deck.pptx`]);
    assert.deepEqual(f.opened, [[PROJECT, 'output/deck.pptx', undefined]]);
    assert.deepEqual(f.local, []);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: local modified and auxiliary clicks cannot navigate the app`, async (t) => {
    const f = await mount(t, render, '[file](output/archive.zip)');
    assert.equal((await f.click(0, { ctrlKey: true })).defaultPrevented, true);
    assert.equal((await f.click(0, { button: 1 }, 'auxclick')).defaultPrevented, true);
    assert.equal(f.local.length, 1);
    assert.equal(f.popups.length, 0);
  });

  test(`${pipeline}: web links retain browser handling and dangerous schemes stay sanitized`, async (t) => {
    const f = await mount(
      t,
      render,
      [
        '[web](https://example.com/report)',
        '[www](www.example.com)',
        '[unsafe](javascript:alert%281%29)',
        '[data](data:text/html,test)',
        '![local image](file:///C:/private/secret.png)',
      ].join('\n\n')
    );
    assert.equal((await f.click()).defaultPrevented, true);
    await f.click(1);
    assert.deepEqual(f.external, [['https://example.com/report'], ['https://www.example.com']]);
    assert.equal(f.local.length, 0);
    const disabled = [...f.dom.window.document.querySelectorAll('.markdown-link-pending')];
    assert.deepEqual(disabled.map(readableText), ['unsafe', 'data']);
    for (const item of disabled) {
      assert.equal(item.getAttribute('href'), null);
      assert.equal(item.getAttribute('aria-disabled'), 'true');
      await act(async () => item.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));
    }
    // A local image whose file is missing stays its original text.
    assert.equal(
      f.dom.window.document.querySelector('.markdown-path-missing').textContent,
      'file:///C:/private/secret.png'
    );
    assert.equal(f.external.length, 2);
    assert.equal(f.popups.length, 0);
    assert.notEqual(f.dom.window.document.querySelector('img')?.getAttribute('src'), 'file:///C:/private/secret.png');
    f.dom.window.mixdogDesktop.openExternal = async () => {
      throw new Error('browser unavailable');
    };
    await f.click();
    // The desktop bridge exists, so no tab is opened by the page; the failure is shown.
    assert.deepEqual(f.popups, []);
    assert.equal(f.toasts.length, 1);
    assert.match(f.toasts[0].text, /Unable to open file: .*browser unavailable/);
    // Only a surface without the bridge opens a tab itself.
    delete f.dom.window.mixdogDesktop.openExternal;
    await f.click();
    assert.deepEqual(f.popups, [['https://example.com/report', '_blank', 'noopener']]);
  });
}

const streamingRenderers = {
  ...Object.fromEntries(
    Object.entries(renderers).map(([name, render]) => [name, (text) => render(healStreamingMarkdownTail(text))])
  ),
  live: (text) =>
    React.createElement(StreamingMarkdownBody, {
      text,
      parseText: healStreamingMarkdownTail(text),
      copyControl: CopyControl,
    }),
};

for (const [pipeline, render] of Object.entries(streamingRenderers)) {
  for (const [notation, format] of [
    ['prose', (path) => `See ${path}`],
    ['inline code', (path) => `See \`${path}`],
    ['link caption', (path) => `See [${path}`],
  ]) {
    test(`${pipeline}: incomplete ${notation} paths wait for the compact filename before painting`, async (t) => {
      let release;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const f = await mount(t, render, format('src/'), PROJECT, (f) => {
        f.dom.window.mixdogDesktop.statProjectFile = () => pending;
      });
      for (const path of [
        'src/',
        'src/app',
        'src/app.',
        'C:/Project/conversation/src/',
        'C:/Project/conversation/src/app',
      ]) {
        await f.update(PROJECT, format(path));
        assert.equal(readableText(f.dom.window.document.querySelector('p')).trimEnd(), 'See', path);
        assert.equal(f.links().length, 0, path);
        assert.equal(f.dom.window.document.querySelector('.seti-icon'), null, path);
      }
      await f.update(PROJECT, format('src/app.ts'));
      const preview = f.dom.window.document.querySelector('.markdown-link-pending');
      assert.equal(readableText(preview), 'app.ts');
      const icon = preview.querySelector('.seti-icon').outerHTML;
      assert.equal(readableText(f.dom.window.document.querySelector('p')), 'See app.ts');
      assert.equal(f.links().length, 0);
      await act(async () => preview.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));
      assert.equal(f.opened.length + f.local.length, 0);

      const completeSuffix = { 'inline code': '`', 'link caption': '](src/app.ts)' }[notation] ?? ' ';
      const complete = `${format('src/app.ts')}${completeSuffix}`;
      await f.update(PROJECT, complete);
      await act(async () => {
        release({ size: 10, mtimeMs: 1 });
      });
      assert.deepEqual(f.labels(), ['app.ts']);
      assert.equal(readableText(f.dom.window.document.querySelector('p')), 'See app.ts');
      assert.equal(f.links()[0].querySelector('.seti-icon').outerHTML, icon);
      await f.click();
      assert.deepEqual(f.opened, [[PROJECT, 'src/app.ts', undefined]]);
    });
  }

  test(`${pipeline}: completed non-file paths, ordinary code and web captions are not withheld`, async (t) => {
    const f = await mount(t, render, 'See `owner/repo`');
    for (const [source, expected] of [
      ['See `owner/repo`', 'See owner/repo'],
      ['See owner/repo ', 'See owner/repo'],
      ['See `src/`', 'See src/'],
      ['See `python src/app', 'See python src/app'],
      ['See `value', 'See value'],
      ['See [docs', 'See docs'],
      ['See https://example.com/docs', 'See https://example.com/docs'],
    ]) {
      await f.update(PROJECT, source);
      assert.equal(readableText(f.dom.window.document.querySelector('p')), expected, source);
    }
  });

  test(`${pipeline}: bare URLs stop before glued Korean prose`, async (t) => {
    const f = await mount(t, render, 'See https://example.com/docs');
    for (const [source, href, text] of [
      [
        '페이지(https://aiscroll.io/ko/mixdog/)와 비교',
        'https://aiscroll.io/ko/mixdog/',
        '페이지(https://aiscroll.io/ko/mixdog/)와 비교',
      ],
      ['주소는 https://example.com/a_(b)입니다', 'https://example.com/a_(b)', '주소는 https://example.com/a_(b)입니다'],
      ['주소는 https://example.com/docs.에서', 'https://example.com/docs', '주소는 https://example.com/docs.에서'],
      ['www.example.com/x)를 여세요', 'http://www.example.com/x', 'www.example.com/x)를 여세요'],
      ['[https://example.com/와](https://example.com/와)', 'https://example.com/와', 'https://example.com/와'],
    ]) {
      await f.update(PROJECT, source);
      const links = f.links();
      assert.equal(links.length, 1, source);
      assert.equal(decodeURI(links[0].getAttribute('href')), href, source);
      assert.equal(readableText(f.dom.window.document.querySelector('p')), text, source);
    }
  });

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
      assert.equal(
        f.dom.window.document.querySelector('p').textContent,
        `See ${caption}${source.endsWith(' next') ? ' next' : ''}`,
        source
      );
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
      'See [src/app.ts',
      'See [src/app.ts]',
      'See [src/app.ts](',
      'See [src/app.ts](src/app.ts',
      'See [src/app.ts](src/app.ts)',
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

  test(`${pipeline}: web pages open in the session browser pane, or the system browser without one`, async (t) => {
    const inSession = (text) =>
      React.createElement(MarkdownSessionContext.Provider, { value: 'sess-page' }, render(text));
    const f = await mount(t, inSession, '[page](site/index.html) and [draft](site/draft.htm)', PROJECT, (f) => {
      installProjectFiles(f, { [PROJECT]: ['site/index.html', 'site/draft.htm'] });
      f.dom.window.mixdogDesktop.localPageUrl = async (_project, rel) => `http://127.0.0.1:9/token/${rel}`;
    });
    // No pane to reveal: the system browser takes the loopback address.
    await f.click(1);
    assert.deepEqual(f.external, [['http://127.0.0.1:9/token/site/draft.htm']]);
    const stopReveal = onBrowserPageRevealRequested(() => {});
    t.after(stopReveal);
    await f.click(0);
    const loaded = [];
    onBrowserPageAddressRequested('sess-page', (url) => loaded.push(url))();
    assert.deepEqual(loaded, ['http://127.0.0.1:9/token/site/index.html']);
    assert.equal(f.external.length, 1);
    assert.deepEqual(f.opened, []);
    assert.deepEqual(f.local, []);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: a web page link naming a line opens its source, not the page`, async (t) => {
    const inSession = (text) =>
      React.createElement(MarkdownSessionContext.Provider, { value: 'sess-source' }, render(text));
    const f = await mount(t, inSession, '[source](site/index.html:12)', PROJECT, (f) => {
      installProjectFiles(f, { [PROJECT]: ['site/index.html'] });
      f.dom.window.mixdogDesktop.localPageUrl = async (_project, rel) => `http://127.0.0.1:9/token/${rel}`;
    });
    const stopReveal = onBrowserPageRevealRequested(() => {});
    t.after(stopReveal);
    await f.click();
    assert.deepEqual(f.opened, [[PROJECT, 'site/index.html', 12]]);
    assert.deepEqual(f.external, []);
    const loaded = [];
    onBrowserPageAddressRequested('sess-source', (url) => loaded.push(url))();
    assert.deepEqual(loaded, []);
  });

  test(`${pipeline}: web links open in the session side browser, else the system browser`, async (t) => {
    const inSession = (text) =>
      React.createElement(MarkdownSessionContext.Provider, { value: 'sess-web' }, render(text));
    const f = await mount(t, inSession, '[web](https://example.com/docs)');
    // No shell can reveal a pane: the system browser takes it.
    await f.click();
    assert.deepEqual(f.external, [['https://example.com/docs']]);
    const revealed = [];
    const stopReveal = onBrowserPageRevealRequested(({ sessionId }) => revealed.push(sessionId));
    t.after(stopReveal);
    await f.click();
    const loaded = [];
    onBrowserPageAddressRequested('sess-web', (url) => loaded.push(url))();
    assert.deepEqual(revealed, ['sess-web']);
    assert.deepEqual(loaded, ['https://example.com/docs']);
    assert.equal(f.external.length, 1);
  });

  test(`${pipeline}: Ctrl/Meta/middle click and the menu send web links and local pages to the system browser`, async (t) => {
    const inSession = (text) =>
      React.createElement(MarkdownSessionContext.Provider, { value: 'sess-ext' }, render(text));
    const f = await mount(t, inSession, '[web](https://example.com/docs)\n\n[page](site/index.html)', PROJECT, (f) => {
      installProjectFiles(f, { [PROJECT]: ['site/index.html'] });
      f.dom.window.mixdogDesktop.localPageUrl = async (_project, rel) => `http://127.0.0.1:9/token/${rel}`;
    });
    const revealed = [];
    const stopReveal = onBrowserPageRevealRequested(({ sessionId }) => revealed.push(sessionId));
    t.after(stopReveal);
    const served = 'http://127.0.0.1:9/token/site/index.html';
    assert.equal((await f.click(0, { ctrlKey: true })).defaultPrevented, true);
    assert.equal((await f.click(0, { metaKey: true })).defaultPrevented, true);
    assert.equal((await f.click(0, { button: 1 }, 'auxclick')).defaultPrevented, true);
    assert.equal((await f.click(1, { ctrlKey: true })).defaultPrevented, true);
    assert.equal((await f.click(1, { button: 1 }, 'auxclick')).defaultPrevented, true);
    assert.deepEqual(f.external, [
      ['https://example.com/docs'],
      ['https://example.com/docs'],
      ['https://example.com/docs'],
      [served],
      [served],
    ]);
    assert.deepEqual(revealed, []);
    // Plain click stays in the pane.
    await f.click(0);
    await f.click(1);
    assert.deepEqual(revealed, ['sess-ext', 'sess-ext']);
    assert.equal(f.external.length, 5);
    // The HTML link's menu offers the system browser with the served URL.
    const menuItems = () => [...f.dom.window.document.querySelectorAll('[role="menu"] [role="menuitem"]')];
    await act(async () =>
      f
        .links()[1]
        .dispatchEvent(
          new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 })
        )
    );
    const item = menuItems().find((entry) => entry.textContent === 'Open in browser');
    assert.ok(item);
    await act(async () => item.click());
    await act(async () => {});
    assert.deepEqual(f.external.at(-1), [served]);
    assert.equal(f.toasts.length, 0);
  });

  test(`${pipeline}: a draft's web links use the system browser even with a pane shell up`, async (t) => {
    const stopReveal = onBrowserPageRevealRequested(() => {});
    t.after(stopReveal);
    const draft = await mount(t, render, '[web](https://example.com/draft)');
    await draft.click();
    assert.deepEqual(draft.external, [['https://example.com/draft']]);
  });
}
