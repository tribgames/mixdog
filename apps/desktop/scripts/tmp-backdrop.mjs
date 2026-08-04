import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, expression: expr })).result?.result?.value;
console.log('backdrop:', await evalJson(`JSON.stringify((() => {
  const b = document.querySelector('.dock-backdrop');
  if (!b) return null;
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  return { state: b.dataset.state, display: cs.display, vis: cs.visibility, op: cs.opacity, z: cs.zIndex, pos: cs.position,
    rect: { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
    bg: cs.backgroundColor, vw: innerWidth,
    atPoint: (document.elementFromPoint(200, 300)||{}).className };
})())`));
ws.close();
