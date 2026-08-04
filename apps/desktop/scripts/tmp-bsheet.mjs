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
// open bottom panel (sheet mode)
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'') === '패널 열기').click()`);
await wait(120);
console.log('mid-flight:', await evalJson(`(() => { const p = document.querySelector('.bottom-panel'); if (!p) return 'none'; const cs = getComputedStyle(p); return JSON.stringify({ anim: cs.animationName, pos: cs.position, radius: cs.borderRadius }); })()`));
await wait(600);
console.log('settled:', await evalJson(`JSON.stringify((() => {
  const p = document.querySelector('.bottom-panel');
  const cs = getComputedStyle(p);
  const bd = document.querySelector('.panel-backdrop');
  const bcs = getComputedStyle(bd);
  const r = p.getBoundingClientRect();
  return { pos: cs.position, radius: cs.borderRadius, z: cs.zIndex, settled: p.dataset.settled,
    rect: { l: Math.round(r.left), rr: Math.round(innerWidth - r.right), b: Math.round(innerHeight - r.bottom), h: Math.round(r.height) },
    ringAfter: getComputedStyle(p, '::after').content !== 'none',
    backdrop: { state: bd.dataset.state, op: bcs.opacity, vis: bcs.visibility } };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-bsheet-shot.png', Buffer.from(shot.result.data, 'base64'));
// backdrop click closes
await evalJson(`document.querySelector('.panel-backdrop').click()`);
await wait(400);
console.log('after backdrop click (want panel gone):', await evalJson(`!!document.querySelector('.bottom-panel')`));
// wide band: still in-flow
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 900, deviceScaleFactor: 0, mobile: false });
await wait(400);
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'') === '패널 열기').click()`);
await wait(400);
console.log('wide mode:', await evalJson(`(() => { const p = document.querySelector('.bottom-panel'); const cs = getComputedStyle(p); return JSON.stringify({ pos: cs.position, radius: cs.borderRadius, backdropVis: getComputedStyle(document.querySelector('.panel-backdrop')).display }); })()`));
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'') === '패널 닫기').click()`);
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
