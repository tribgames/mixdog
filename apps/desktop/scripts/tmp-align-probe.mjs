import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const expr = `JSON.stringify((() => {
  const tg = document.querySelector('.topbar .toolbar-sidebar')?.getBoundingClientRect();
  const rb = document.querySelector('.activity-rail button')?.getBoundingClientRect();
  return { vw: innerWidth, toggleCenter: tg ? (tg.left + tg.right) / 2 : null, railCenter: rb ? (rb.left + rb.right) / 2 : null };
})())`;
await send('Emulation.setDeviceMetricsOverride', { width: 484, height: 691, deviceScaleFactor: 0, mobile: false });
await new Promise((r) => setTimeout(r, 500));
console.log('narrow:', (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value);
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
