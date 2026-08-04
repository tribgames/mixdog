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
  const docks = [...document.querySelectorAll('[class*="utility-dock"]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { cls: String(el.className).slice(0, 60), w: Math.round(r.width), top: Math.round(r.top), left: Math.round(r.left) };
  });
  return docks.slice(0, 8);
})())`));
ws.close();
