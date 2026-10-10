import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import MarkdownBody from './MarkdownBody';
import MarkdownAstBody from './MarkdownAstBody';
import { parseMarkdownToHast } from './markdown-ast';
import { MarkdownProjectContext } from './MarkdownLink';
import { setiIconFor } from './seti-icons';

const CopyControl = () => null;
const renderers = {
  settled: (text) => React.createElement(MarkdownBody, { text, copyControl: CopyControl }),
  worker: (text) => React.createElement(MarkdownAstBody, { root: parseMarkdownToHast(text), copyControl: CopyControl }),
};

// [case, markdown, expected icon]: a Seti glyph of the extension, or an inline SVG kind.
const seti = (name) => ({ glyph: setiIconFor(name).glyph });
const CASES = [
  ['inline code path', '`src/app.ts`', seti('app.ts')],
  ['authored link with #L', '[app.ts#L20](src/app.ts#L20)', seti('app.ts')],
  ['authored link with spaces', '[my notes.ts](<my notes.ts>)', seti('my notes.ts')],
  ['authored link with encoded #', '[hash#1.ts](hash%231.ts)', seti('hash.ts')],
  ['authored link with encoded %', '[rate 50%.ts](rate%2050%25.ts)', seti('rate.ts')],
  ['authored Korean link', '[한글 파일.ts](<한글 파일.ts>)', seti('a.ts')],
  ['docx', '[d](docs/a.docx)', seti('a.docx')],
  ['xlsx', '[d](docs/a.xlsx)', seti('a.xlsx')],
  ['pptx', '[deck](docs/a.pptx)', { kind: 'presentation' }],
  ['ppt', '[deck](docs/a.ppt)', { kind: 'presentation' }],
  ['odp', '[deck](docs/a.odp)', { kind: 'presentation' }],
  ['zip', '[out](out/a.zip)', { kind: 'archive' }],
  ['7z', '[out](out/a.7z)', { kind: 'archive' }],
  ['tar.gz', '[out](out/a.tar.gz)', { kind: 'archive' }],
  ['folder', '[assets](assets/)', { kind: 'folder' }],
  ['external', '[site](https://example.com/a)', { kind: 'external' }],
];

test('a mention whose lookup failed once heals on the retry backoff', async (t) => {
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0;
  dom.window.mixdogDesktop = {
    statProjectFile: async () => {
      calls += 1;
      if (calls === 1) throw new Error('file service busy');
      return {};
    },
    searchProjectFiles: async () => [],
  };
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  await act(async () => {
    root.render(
      React.createElement(
        MarkdownProjectContext.Provider,
        { value: 'C:/Project/heal' },
        renderers.settled('`table.csv`')
      )
    );
  });
  await flush();
  const missing = dom.window.document.querySelector('.markdown-path-missing');
  assert.ok(missing, 'the transient failure first shows the plain-text fallback');
  assert.ok(missing.getAttribute('title'), 'the failure reason is the tooltip');
  await act(async () => t.mock.timers.tick(3_600));
  await flush();
  assert.equal(dom.window.document.querySelector('.markdown-path-missing'), null);
  assert.ok(dom.window.document.querySelector('a.markdown-path-link, a'), 'the retry restores the link');
});

for (const [pipeline, render] of Object.entries(renderers)) {
  test(`${pipeline}: every transcript link carries the icon of its kind before an unchanged label`, async (t) => {
    const { dom, root } = installTestDom(t, { rootId: 'root' });
    dom.window.mixdogDesktop = { statProjectFile: async () => ({}), searchProjectFiles: async () => [] };
    for (const [label, markdown, expected] of CASES) {
      await act(async () => {
        root.render(React.createElement(MarkdownProjectContext.Provider, { value: 'C:/Project/p' }, render(markdown)));
      });
      const link = dom.window.document.querySelector('a, .markdown-path-link');
      assert.ok(link, `${label}: link rendered`);
      const icon = link.firstElementChild;
      assert.ok(icon?.classList.contains('seti-icon'), `${label}: icon is the first inline child`);
      if (expected.glyph) {
        assert.equal(icon.textContent, expected.glyph, `${label}: Seti file-type glyph`);
        assert.equal(icon.hasAttribute('data-icon-kind'), false, label);
      } else {
        assert.equal(icon.getAttribute('data-icon-kind'), expected.kind, `${label}: ${expected.kind} icon`);
        assert.ok(icon.querySelector('svg'), `${label}: svg glyph`);
      }
      assert.equal(icon.getAttribute('aria-hidden'), 'true');
      const caption = markdown.match(/^\[([^\]]+)\]/)?.[1];
      if (caption) assert.equal(link.textContent.replace(icon.textContent, ''), caption, `${label}: label unchanged`);
    }
  });
}
