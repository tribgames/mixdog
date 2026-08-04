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
await wait(600);
// open the projects drawer via rail
await evalJson(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||x.dataset.tooltip||'').includes('프로젝트')); if (b) b.click(); return b ? 'ok':'nf'; })()`);
await wait(600);
console.log(await evalJson(`JSON.stringify((() => {
  const sb = document.querySelector('.session-sidebar');
  if (!sb) return { err: 'no sidebar' };
  const r = sb.getBoundingClientRect();
  const cs = getComputedStyle(sb);
  const chain = [];
  let p = sb.parentElement;
  while (p && chain.length < 6) {
    const pcs = getComputedStyle(p);
    chain.push({ cls: String(p.className).slice(0,40) || p.tagName, ov: pcs.overflow + '/' + pcs.overflowX + '/' + pcs.overflowY, pos: pcs.position, z: pcs.zIndex });
    p = p.parentElement;
  }
  const occl = [];
  for (const [x, y] of [[20, Math.round(r.top)], [20, Math.round(r.top)+1], [116, Math.round(r.top)], [20, Math.round(r.top)-1]]) {
    const el = document.elementFromPoint(x, y);
    occl.push({ x, y, el: el ? (el.className ? String(el.className).slice(0,40) : el.tagName) : null });
  }
  return {
    rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
    cls: sb.className,
    radius: cs.borderRadius, shadow: cs.boxShadow.slice(0,80), z: cs.zIndex, pos: cs.position,
    clip: cs.clipPath, ovf: cs.overflow,
    chain, occl,
  };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-drawer-shot.png', Buffer.from(shot.result.data, 'base64'));
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
