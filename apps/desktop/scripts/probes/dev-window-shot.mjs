// Screenshot the running dev app's main renderer page over CDP (no OS input).
// Usage (from apps/desktop): node scripts/probes/dev-window-shot.mjs <port> <out.png>
import puppeteer from 'puppeteer-core';

const [port = '9342', out] = process.argv.slice(2);
if (!out) throw new Error('usage: dev-window-shot.mjs <port> <out.png>');
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
try {
  const pages = await browser.pages();
  const page = pages.find((candidate) => /127\.0\.0\.1:5173\/?$/.test(candidate.url())) ?? pages[0];
  await page.screenshot({ path: out });
  console.log(page.url(), out);
} finally {
  await browser.disconnect();
}
