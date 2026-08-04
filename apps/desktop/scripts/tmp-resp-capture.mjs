// TEMP (not for commit): responsive-band evidence — resize the live dev
// window through the layout bands and save full-window screenshots.
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const port = Number(process.argv[2] || 9343);
const widths = [1200, 980, 900, 760, 700, 600, 420];

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

// Electron CDP has no Browser.setWindowBounds: emulate each band via device
// metrics (cdp-layout-probe pattern) and ALWAYS clear the override at the end.
for (const width of widths) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 0, mobile: false });
  await new Promise((res) => setTimeout(res, 900));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (!shot.result?.data) { console.error(`w${width}: capture failed`, shot.error); continue; }
  const metrics = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({vw: innerWidth, scrollW: document.querySelector(".desktop-body")?.scrollWidth, clientW: document.querySelector(".desktop-body")?.clientWidth, topbar: !!document.querySelector(".topbar") && getComputedStyle(document.querySelector(".topbar")).display !== "none"})',
    returnByValue: true,
  });
  writeFileSync(`${process.env.TEMP}/resp-${width}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log(`w${width}:`, metrics.result?.result?.value);
}
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
