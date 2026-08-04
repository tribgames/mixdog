import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, expression: expr })).result?.result?.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Emulation.setDeviceMetricsOverride', { width: 733, height: 693, deviceScaleFactor: 0, mobile: false });
await wait(600);
console.log(await evalJson(`JSON.stringify((() => {
  const s = document.querySelector('.workspace-tabs');
  const firstTab = s.querySelector('.workspace-tab');
  return { scrollLeft: Math.round(s.scrollLeft), firstTabL: Math.round(firstTab.getBoundingClientRect().left - s.getBoundingClientRect().left) };
})())`));
// force a mid-tab position and see where it settles
await evalJson(`document.querySelector('.workspace-tabs').scrollTo({ left: 49 })`);
await wait(400);
console.log('after scrollTo(49):', await evalJson(`Math.round(document.querySelector('.workspace-tabs').scrollLeft)`));
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
