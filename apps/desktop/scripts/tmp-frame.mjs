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
await send('Emulation.setDeviceMetricsOverride', { width: 644, height: 788, deviceScaleFactor: 0, mobile: false });
await wait(500);
await evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('사이드바 펼치기')); if (b) b.click(); })()`);
await wait(500);
console.log(await evalJson(`JSON.stringify((() => {
  const sb = document.querySelector('.sidebar.session-sidebar');
  const cs = getComputedStyle(sb);
  const r = sb.getBoundingClientRect();
  return { left: Math.round(r.left), bottom: Math.round(innerHeight - r.bottom), radius: cs.borderRadius,
    borderRight: cs.borderRightWidth, shadow: cs.boxShadow.slice(0, 50) };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-frame-shot.png', Buffer.from(shot.result.data, 'base64'));
await evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('사이드바 접기')); if (b) b.click(); })()`);
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
