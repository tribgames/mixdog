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
  // Chinese and Japanese runs have no spaces: their cells must still wrap
  // inside the frame while a Korean cell keeps its words whole.
  const cjk = [
    ['한국어', '지표 분석 계속 보기', '짧은 광고를 보면 지표 분석을 계속 볼 수 있어요'],
    ['일본어', '指標分析を続けて見る', '短い広告を見ると指標分析を引き続き利用できます'],
    ['중국어', '继续查看指标分析', '观看一段短广告即可继续查看指标分析观看一段短广告即可继续查看指标分析'],
  ];
  const cell = (text) => `<td${/[\u3040-\u30ff\u4e00-\u9fff]/.test(text) ? ' data-cjk' : ''}>${text}</td>`;
  await page.setViewport({ width: 420, height: 800 });
  await page.setContent(`<!doctype html><html><body>
    <main class="workspace" style="width:420px"><section class="conversation"><div class="message-body markdown">
      <div class="markdown-table-frame"><div class="markdown-table" tabindex="0"><table>
        <thead><tr><th>언어</th><th>제목</th><th>설명</th></tr></thead>
        <tbody>${cjk.map((cells) => `<tr>${cells.map(cell).join('')}</tr>`).join('')}</tbody>
      </table></div></div>
    </div></section></main></body></html>`);
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  const cjkSizes = await page.evaluate(() => ({
    frame: document.querySelector('.markdown-table-frame').getBoundingClientRect().width,
    table: document.querySelector('.markdown-table table').getBoundingClientRect().width,
  }));
  assert.ok(cjkSizes.table <= cjkSizes.frame + 0.5, `CJK table: ${JSON.stringify(cjkSizes)}`);
});
