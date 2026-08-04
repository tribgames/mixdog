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
const click = (label) => evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('${label}')); if (b) b.click(); })()`);
const state = () => evalJson(`JSON.stringify({ sidebar: !!document.querySelector('.session-sidebar.open') || (() => { const s = document.querySelector('.sidebar.session-sidebar'); return s ? s.getBoundingClientRect().width > 50 : false; })(), dock: !!document.querySelector('.utility-dock'), panel: !!document.querySelector('.bottom-panel') })`);
// wide: open all three
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 900, deviceScaleFactor: 0, mobile: false });
await wait(500);
await click('사이드바 펼치기'); await wait(300);
await click('유틸리티 패널 열기'); await wait(300);
await click('패널 열기'); await wait(300);
console.log('wide all open:', await state());
// shrink to 700 (≤760): sidebar+panel hide, dock survives as sheet
await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 693, deviceScaleFactor: 0, mobile: false });
await wait(700);
console.log('at 700 (want sidebar:false, panel:false, dock:true):', await state());
// widen back: all restored
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 900, deviceScaleFactor: 0, mobile: false });
await wait(700);
console.log('back wide (want all true):', await state());
// cleanup
await click('패널 닫기'); await wait(200);
await click('유틸리티 패널 닫기'); await wait(200);
await click('사이드바 접기'); await wait(200);
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
