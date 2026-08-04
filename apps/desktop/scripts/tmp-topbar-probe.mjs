import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
console.log(await evalJson(`JSON.stringify((() => {
  const tb = document.querySelector('header.topbar');
  const cs = getComputedStyle(tb);
  const r = tb.getBoundingClientRect();
  return { z: cs.zIndex, pos: cs.position, h: Math.round(r.height), bg: cs.backgroundColor,
    band: getComputedStyle(document.documentElement).getPropertyValue('--mx-window-band'),
    drawerBg: (() => { const d = document.querySelector('.session-sidebar'); return d ? getComputedStyle(d).backgroundColor : null; })() };
})())`));
ws.close();
