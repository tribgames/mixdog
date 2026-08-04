import WebSocket from 'ws';
import fs from 'fs';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, expression: expr })).result?.result?.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Emulation.setDeviceMetricsOverride', { width: 644, height: 693, deviceScaleFactor: 0, mobile: false });
await wait(500);
// open the drawer
await evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('사이드바 펼치기')); if (b) b.click(); })()`);
await wait(500);
console.log(await evalJson(`JSON.stringify((() => {
  const sb = document.querySelector('.sidebar.session-sidebar');
  const r = sb.getBoundingClientRect();
  const bd = document.querySelector('.sidebar-backdrop');
  const bdr = bd.getBoundingClientRect();
  const railHit = document.elementFromPoint(24, 200);
  return { drawerLeft: Math.round(r.left), backdropLeft: Math.round(bdr.left),
    railHit: railHit ? (railHit.closest('button') ? 'button:' + (railHit.closest('button').getAttribute('aria-label')||'?') : railHit.className.slice(0,20)) : null };
})())`));
// click a rail destination while drawer open — panel should switch, drawer stays
console.log('rail click:', await evalJson(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||x.dataset.tooltip||'').includes('프로젝트') && x.getBoundingClientRect().left < 48);
  if (!b) return 'nf';
  b.click();
  return 'clicked';
})()`));
await wait(500);
console.log('after rail click:', await evalJson(`JSON.stringify({ drawerOpen: document.querySelector('.sidebar.session-sidebar').getBoundingClientRect().width > 50, title: (document.querySelector('.session-panel-title')||{}).textContent })`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-rail-shot.png', Buffer.from(shot.result.data, 'base64'));
// cleanup
await evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('사이드바 접기')); if (b) b.click(); })()`);
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
