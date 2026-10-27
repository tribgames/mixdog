import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// Reads one pixel of a 1x1 8-bit RGB/RGBA PNG.
function pixelOf(png) {
  const colorType = png[25];
  const channels = colorType === 6 ? 4 : 3;
  const idat = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return Array.from(raw.subarray(1, 1 + channels)).slice(0, 3);
}

// The frame's hairline ring is painted OUTSIDE its box. The last block of a
// reply has no bottom margin, so the transcript row (overflow: clip) ends at the
// frame's bottom edge and used to clip the ring's bottom line.
test('the markdown table card keeps its bottom hairline inside a transcript row', async (t) => {
  const styles = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
      contents:
        '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
    },
    outfile: 'markdown-table-ring.css',
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const outDir = join(tmpdir(), 'mixdog-table-ring');
  mkdirSync(outDir, { recursive: true });
  const page = await browser.newPage();
  const rows = ['작업', '검토', '수정', '테스트', '배포'].map((name) => `<tr><td>${name}</td><td>완료</td></tr>`);
  for (const width of [900, 375]) {
    await page.setViewport({ width, height: 600, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html data-mixdog-theme="dark"><body>
      <main class="workspace" style="width:${width}px;height:600px"><section class="conversation" style="height:600px">
        <div class="transcript-virtual-space" style="height:400px"><div class="transcript-virtual-row">
          <div class="transcript-virtual-row-content" data-tag="AssistantPart" style="padding-left:24px;padding-right:24px">
            <div class="message assistant"><div class="message-body markdown">
              <p>표</p>
              <div class="markdown-table-frame"><div class="markdown-table" tabindex="0"><table>
                <thead><tr><th>작업</th><th>상태</th></tr></thead><tbody>${rows.join('')}</tbody>
              </table></div></div>
            </div></div>
          </div>
        </div></div>
      </section></main></body></html>`);
    await page.addStyleTag({ content: styles.outputFiles[0].text });
    const geometry = await page.evaluate(() => {
      const frame = document.querySelector('.markdown-table-frame').getBoundingClientRect();
      const row = document.querySelector('.transcript-virtual-row').getBoundingClientRect();
      return { left: frame.left, right: frame.right, top: frame.top, bottom: frame.bottom, rowBottom: row.bottom };
    });
    const pixelAt = async (x, y) =>
      pixelOf(
        await page.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 }, type: 'png' })
      );
    const midX = (geometry.left + geometry.right) / 2;
    const sideRing = await pixelAt(geometry.left - 1, (geometry.top + geometry.bottom) / 2);
    const bottomRing = await pixelAt(midX, geometry.bottom);
    const sheet = await pixelAt(geometry.left - 8, (geometry.top + geometry.bottom) / 2);
    await page.screenshot({
      path: join(outDir, `table-bottom-${width}.png`),
      clip: { x: geometry.left - 8, y: geometry.bottom - 40, width: geometry.right - geometry.left + 16, height: 56 },
    });
    assert.notDeepEqual(sideRing, sheet, `${width}px: the side ring is visible against the sheet`);
    assert.ok(
      geometry.rowBottom >= geometry.bottom + 1,
      `${width}px: the row covers the ring: ${JSON.stringify(geometry)}`
    );
    assert.deepEqual(bottomRing, sideRing, `${width}px: bottom ring ${bottomRing} matches side ring ${sideRing}`);
  }
  writeFileSync(join(outDir, 'done.txt'), 'ok');
});
