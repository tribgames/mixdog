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
await send('Emulation.setDeviceMetricsOverride', { width: 562, height: 693, deviceScaleFactor: 0, mobile: false });
await wait(500);
console.log('closed drawer box:', await evalJson(`JSON.stringify((() => {
  const sb = document.querySelector('.sidebar.session-sidebar');
  const r = sb.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), vis: getComputedStyle(sb).visibility };
})())`));
await evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('사이드바 펼치기')); if (b) b.click(); })()`);
await wait(400);
console.log('open drawer box:', await evalJson(`JSON.stringify((() => {
  const sb = document.querySelector('.sidebar.session-sidebar');
  const rail = document.querySelector('.activity-rail');
  return { drawerL: Math.round(sb.getBoundingClientRect().left), railL: Math.round(rail.getBoundingClientRect().left) };
})())`));
await evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('사이드바 접기')); if (b) b.click(); })()`);
await wait(120);
console.log('mid-close right edges:', await evalJson(`JSON.stringify((() => {
  const sb = document.querySelector('.sidebar.session-sidebar').getBoundingClientRect();
  const rail = document.querySelector('.activity-rail').getBoundingClientRect();
  return { drawerRight: Math.round(sb.right), railRight: Math.round(rail.right) };
})())`));
await wait(400);
console.log('settled right edges:', await evalJson(`JSON.stringify((() => {
  const sb = document.querySelector('.sidebar.session-sidebar').getBoundingClientRect();
  return { drawerRight: Math.round(sb.right), vis: getComputedStyle(document.querySelector('.sidebar.session-sidebar')).visibility };
})())`));
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
