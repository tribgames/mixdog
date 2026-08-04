import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => evalJson(`JSON.stringify((() => {
  const panel = document.querySelector('.main-panel')?.getBoundingClientRect();
  return {
    vw: innerWidth, vh: innerHeight,
    panel: panel ? { w: Math.round(panel.width), h: Math.round(panel.height) } : null,
    carousel: !!document.querySelector('.pane-carousel'),
    split: !!document.querySelector('.pane-split'),
    panelScrollW: document.querySelector('.main-panel')?.scrollWidth,
    panelScrollH: document.querySelector('.main-panel')?.scrollHeight,
  };
})())`);
await send('Emulation.setDeviceMetricsOverride', { width: 1006, height: 762, deviceScaleFactor: 0, mobile: false });
await wait(700);
console.log('1006x762:', await state());
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 0, mobile: false });
await wait(700);
console.log('1600x1100:', await state());
await send('Emulation.clearDeviceMetricsOverride');
await wait(400);
console.log('native:', await state());
ws.close();
