import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import React, { act } from 'react';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';
import { installTestDom } from './test-support/test-dom.mjs';
import MarkdownBody from './MarkdownBody';
import { MarkdownProjectContext } from './MarkdownLink';

const PROJECT = 'C:/Project/conversation';
// Prose and inline-code mentions that wrap in a narrow column: one exists,
// one is missing, so both outcomes are compared with the pending paint.
const TEXT = [
  'The reply changed apps/desktop/src/renderer/MarkdownLink.tsx:42 and also `src/runtime/missing-module.mjs` today.',
  'Then `apps/desktop/src/renderer/desktop/22-markdown.css` (line 7) and docs/missing/notes.md next.',
].join('\n\n');
const EXISTING = new Set([
  'apps/desktop/src/renderer/MarkdownLink.tsx',
  'apps/desktop/src/renderer/desktop/22-markdown.css',
]);

/** The markup before and after every mention's lookup has answered. */
async function mentionStates(t) {
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  const answers = [];
  dom.window.mixdogDesktop = {
    statProjectFile: (_project, path) =>
      new Promise((resolve, reject) => {
        answers.push(() =>
          EXISTING.has(path)
            ? resolve({ size: 1, mtimeMs: 1 })
            : reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        );
      }),
    searchProjectFiles: async () => [],
    listProjects: async () => [{ path: PROJECT, name: 'conversation' }],
  };
  await act(async () => {
    root.render(
      React.createElement(
        MarkdownProjectContext.Provider,
        { value: PROJECT },
        React.createElement(MarkdownBody, { text: TEXT, copyControl: () => null })
      )
    );
  });
  const host = dom.window.document.getElementById('root');
  // The settled renderer loads its parser lazily on first use.
  for (let tick = 0; tick < 50 && !host.querySelector('p'); tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  const pending = host.innerHTML;
  assert.equal(host.querySelectorAll('.markdown-path-pending').length, 4, pending);
  // A miss may ask again (another candidate path): answer until all settle.
  for (let tick = 0; tick < 50 && host.querySelector('.markdown-path-pending'); tick += 1) {
    await act(async () => {
      for (const answer of answers.splice(0)) answer();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.equal(host.querySelectorAll('a.markdown-path-mention').length, 2);
  assert.equal(host.querySelectorAll('.markdown-path-missing').length, 2);
  return { pending, settled: host.innerHTML };
}

test('verifying file mentions changes neither their text nor any box', async (t) => {
  const { pending, settled } = await mentionStates(t);
  const styles = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
      contents:
        '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
    },
    outfile: 'path-mention.css',
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900 });
  await page.setContent(
    '<!doctype html><html><body><div class="message-body"><div class="markdown" id="host"></div></div></body></html>'
  );
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  const measure = (html, width) =>
    page.evaluate(
      async (html, width) => {
        const host = document.getElementById('host');
        host.style.width = `${width}px`;
        host.innerHTML = html;
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const box = (rect) =>
          [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 100) / 100);
        return {
          text: host.textContent,
          host: box(host.getBoundingClientRect()),
          mentions: [...host.querySelectorAll('.markdown-path-mention')].map((mention) =>
            [...mention.getClientRects()].map(box)
          ),
        };
      },
      html,
      width
    );
  for (const width of [220, 360, 640]) {
    const before = await measure(pending, width);
    const after = await measure(settled, width);
    assert.equal(before.mentions.length, 4, `${width}px: every mention measured`);
    // The narrow column must actually wrap a mention for the check to bite.
    if (width === 220)
      assert.ok(
        before.mentions.some((rects) => rects.length > 1),
        'a mention wraps'
      );
    assert.deepEqual(after, before, `${width}px: identical text, column and mention boxes`);
  }
});
