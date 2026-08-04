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
await send('Emulation.setDeviceMetricsOverride', { width: 641, height: 712, deviceScaleFactor: 0, mobile: false });
await wait(500);
// close drawer if open, then open the right dock via topbar toggle
console.log(await evalJson(`(() => {
  const dock = document.querySelector('.utility-dock');
  const open = dock && dock.getBoundingClientRect().width > 0;
  if (!open) {
    const btn = [...document.querySelectorAll('.topbar button')].find(b =>
      (b.getAttribute('aria-label')||'').match(/dock|독|패널|Utility|우측/i));
    if (btn) { btn.click(); return 'clicked:' + (btn.getAttribute('aria-label')||''); }
    return 'no-btn';
  }
  return 'already-open';
})()`));
await wait(700);
console.log(await evalJson(`JSON.stringify((() => {
  const dock = document.querySelector('.utility-dock');
  const r = dock.getBoundingClientRect();
  const cs = getComputedStyle(dock);
  return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height),
    radius: cs.borderRadius, shadow: cs.boxShadow.slice(0, 90), z: cs.zIndex, pos: cs.position };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-dock-shot.png', Buffer.from(shot.result.data, 'base64'));
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
