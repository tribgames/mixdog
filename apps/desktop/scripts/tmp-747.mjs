import WebSocket from 'ws';
import fs from 'fs';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, expression: expr })).result?.result?.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Emulation.setDeviceMetricsOverride', { width: 747, height: 700, deviceScaleFactor: 0, mobile: false });
await wait(500);
console.log('open dock:', await evalJson(`(() => {
  const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('유틸리티 패널'));
  if ((b.getAttribute('aria-label')||'').includes('열기')) b.click();
  return b.getAttribute('aria-label');
})()`));
await wait(600);
console.log('state:', await evalJson(`JSON.stringify((() => {
  const bd = document.querySelector('.dock-backdrop');
  const cs = getComputedStyle(bd);
  return { state: bd.dataset.state, vis: cs.visibility, op: cs.opacity,
    dockOpen: !!document.querySelector('.utility-dock') };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-747-shot.png', Buffer.from(shot.result.data, 'base64'));
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
