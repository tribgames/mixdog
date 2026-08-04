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
await wait(700);
console.log(await evalJson(`JSON.stringify((() => {
  const dock = document.querySelector('.utility-dock');
  if (!dock) return { dock: null };
  const r = dock.getBoundingClientRect();
  const cs = getComputedStyle(dock);
  const after = getComputedStyle(dock, '::after');
  const backdrop = document.querySelector('.dock-backdrop');
  return {
    dock: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) },
    pos: cs.position, radius: cs.borderRadius, z: cs.zIndex,
    shadow: cs.boxShadow.slice(0, 60),
    afterShadow: after.boxShadow ? after.boxShadow.slice(0, 60) : null,
    afterInset: after.inset, afterZ: after.zIndex, afterRadius: after.borderRadius,
    overlaying: dock.dataset.overlaying,
    backdrop: backdrop ? { vis: getComputedStyle(backdrop).visibility, op: getComputedStyle(backdrop).opacity, z: getComputedStyle(backdrop).zIndex } : null,
    vw: innerWidth, vh: innerHeight,
  };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-909-shot.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
