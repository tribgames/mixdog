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
  const aside = document.querySelector('.sidebar.session-sidebar');
  const dock = document.querySelector('.utility-dock');
  const ar = aside?.getBoundingClientRect(); const dr = dock?.getBoundingClientRect();
  return {
    drawer: aside?.dataset.state ?? 'unmounted',
    drawerTop: ar ? Math.round(ar.top) : null,
    dockOpen: !!dock, dockTop: dr ? Math.round(dr.top) : null,
    dockBottomGap: dr ? Math.round(innerHeight - dr.bottom) : null,
    headerZ: document.querySelector('.session-header') ? getComputedStyle(document.querySelector('.session-header')).zIndex : null,
  };
})())`);
await send('Emulation.setDeviceMetricsOverride', { width: 620, height: 701, deviceScaleFactor: 0, mobile: false });
await wait(600);
await evalJson(`(() => { const a = document.querySelector('.sidebar.session-sidebar'); if (a?.dataset.state !== 'open') document.querySelector('.toolbar-sidebar')?.click(); })()`);
await wait(400);
console.log('drawer open:', await state());
await evalJson(`document.querySelector('.topbar .toolbar-dock')?.click()`);
await wait(400);
console.log('after dock click (drawer must close):', await state());
await evalJson(`document.querySelector('.toolbar-sidebar')?.click()`);
await wait(400);
console.log('after sidebar click (dock must close):', await state());
await evalJson(`(() => { const a = document.querySelector('.sidebar.session-sidebar'); if (a?.dataset.state === 'open') document.querySelector('.toolbar-sidebar')?.click(); })()`);
await wait(300);
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
