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
await send('Emulation.setDeviceMetricsOverride', { width: 909, height: 628, deviceScaleFactor: 0, mobile: false });
await wait(500);
console.log('open:', await evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('utility panel')); if (b) { b.click(); return 'ok'; } return 'nf'; })()`));
await wait(900);
console.log(await evalJson(`JSON.stringify((() => {
  const dock = document.querySelector('.utility-dock');
  if (!dock) return { dock: null };
  const r = dock.getBoundingClientRect();
  const cs = getComputedStyle(dock);
  const after = getComputedStyle(dock, '::after');
  const backdrop = document.querySelector('.dock-backdrop');
  return {
    rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), bottom: Math.round(r.bottom) },
    pos: cs.position, radius: cs.borderRadius,
    shadow: cs.boxShadow.slice(0, 70),
    afterContent: after.content, afterRadius: after.borderRadius, afterZ: after.zIndex,
    overlaying: dock.dataset.overlaying, vw: innerWidth, vh: innerHeight,
    backdrop: backdrop ? { vis: getComputedStyle(backdrop).visibility, bg: getComputedStyle(backdrop).backgroundColor, rect: (() => { const b = backdrop.getBoundingClientRect(); return { t: Math.round(b.top), l: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; })() } : null,
  };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-909b-shot.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
