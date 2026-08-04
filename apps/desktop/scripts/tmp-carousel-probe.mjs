// TEMP (not for commit): verify the narrow-shell pane carousel on the live dev app.
import WebSocket from 'ws';
const port = Number(process.argv[2] || 9343);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 720, deviceScaleFactor: 0, mobile: false });
await new Promise((res) => setTimeout(res, 800));
const expression = `JSON.stringify({
  carousel: !!document.querySelector('.pane-carousel'),
  pager: document.querySelector('.pane-carousel-pager > span')?.textContent ?? null,
  items: document.querySelectorAll('.pane-carousel-item').length,
  visible: document.querySelectorAll('.pane-carousel-item[data-carousel-active="true"]').length,
  split: !!document.querySelector('.pane-split'),
  scrollW: document.querySelector('.desktop-body')?.scrollWidth,
})`;
const evaluated = await send('Runtime.evaluate', { expression, returnByValue: true });
console.log('narrow(420):', evaluated.result?.result?.value);
await send('Emulation.clearDeviceMetricsOverride');
await new Promise((res) => setTimeout(res, 400));
const wide = await send('Runtime.evaluate', { expression, returnByValue: true });
console.log('restored:', wide.result?.result?.value);
ws.close();
