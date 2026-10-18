import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

test('a many-column markdown table fits a narrow pane without scrolling sideways', async (t) => {
  const styles = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
      contents:
        '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
    },
    outfile: 'markdown-table.css',
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
  const columns = Array.from({ length: 12 }, (_, index) => index);
  const row = (tag, text) => `<tr>${columns.map((n) => `<${tag}>${text}${n}</${tag}>`).join('')}</tr>`;
  for (const width of [375, 600]) {
    await page.setViewport({ width, height: 800 });
    await page.setContent(`<!doctype html><html><body>
      <main class="workspace" style="width:${width}px"><section class="conversation"><div class="message-body markdown">
        <div class="markdown-table-frame"><div class="markdown-table" tabindex="0"><table>
          <thead>${row('th', 'Heading')}</thead><tbody>${row('td', 'value')}${row('td', 'https://example.com/a/very/long/token')}</tbody>
        </table></div></div>
      </div></section></main></body></html>`);
    await page.addStyleTag({ content: styles.outputFiles[0].text });
    const sizes = await page.evaluate(() => {
      const table = document.querySelector('.markdown-table');
      return { scrollWidth: table.scrollWidth, clientWidth: table.clientWidth };
    });
    assert.ok(sizes.clientWidth > 0);
    assert.ok(sizes.scrollWidth <= sizes.clientWidth, `${width}px: ${JSON.stringify(sizes)}`);
  }
});
