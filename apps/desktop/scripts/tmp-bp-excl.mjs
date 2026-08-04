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
await send('Emulation.setDeviceMetricsOverride', { width: 747, height: 700, deviceScaleFactor: 0, mobile: false });
await wait(500);
// ensure bottom panel closed, dock open
await evalJson(`(() => {
  const pb = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'') === '패널 닫기');
  if (pb) pb.click();
})()`);
await wait(300);
await evalJson(`(() => {
  const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('유틸리티 패널 열기'));
  if (b) b.click();
})()`);
await wait(500);
console.log('before:', await evalJson(`JSON.stringify({ dock: !!document.querySelector('.utility-dock'), panel: !!document.querySelector('.bottom-panel') })`));
// press bottom panel expand
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('패널 열기') && !(x.getAttribute('aria-label')||'').includes('유틸리티')).click()`);
await wait(600);
console.log('after bottom expand (want dock:false, panel:true):', await evalJson(`JSON.stringify({ dock: !!document.querySelector('.utility-dock'), panel: !!document.querySelector('.bottom-panel') })`));
// cleanup
await evalJson(`(() => { const pb = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'') === '패널 닫기'); if (pb) pb.click(); })()`);
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
