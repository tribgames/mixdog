import WebSocket from 'ws';
import fs from 'fs';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Page.reload', { ignoreCache: false });
await wait(4000);
await send('Emulation.setDeviceMetricsOverride', { width: 641, height: 712, deviceScaleFactor: 0, mobile: false });
await wait(800);
console.log('state:', await evalJson(`(() => {
  const dock = document.querySelector('.utility-dock');
  if (dock && dock.getBoundingClientRect().width > 50) return 'open';
  const b = [...document.querySelectorAll('.topbar button')].find(x => /utility panel/i.test(x.getAttribute('aria-label')||''));
  if (b) { b.click(); return 'clicked'; }
  return 'nf: ' + document.body.innerText.slice(0, 80);
})()`));
await wait(900);
console.log('dock:', await evalJson(`JSON.stringify((() => {
  const dock = document.querySelector('.utility-dock');
  if (!dock) return null;
  const r = dock.getBoundingClientRect();
  return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width) };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-dock-shot5.png', Buffer.from(shot.result.data, 'base64'));
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
