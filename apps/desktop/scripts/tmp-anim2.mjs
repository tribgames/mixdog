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
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 0, mobile: false });
await wait(600);
// arm listener + ensure dock closed
console.log('prep:', await evalJson(`(() => {
  window.__animRuns = [];
  document.addEventListener('animationstart', (e) => { if (e.animationName.includes('utility-dock')) window.__animRuns.push(e.animationName); }, true);
  const btn = () => [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('유틸리티 패널'));
  const openNow = (btn().getAttribute('aria-label')||'').includes('닫기');
  if (openNow) btn().click();
  return 'closed:' + openNow;
})()`));
await wait(500);
await evalJson(`window.__animRuns = []`);
// 1) single open
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('유틸리티 패널')).click()`);
await wait(500);
console.log('single open runs:', await evalJson(`JSON.stringify(window.__animRuns)`));
// 2) sidebar toggle twice while dock open
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('사이드바')).click()`);
await wait(350);
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('사이드바')).click()`);
await wait(350);
console.log('after sidebar toggles:', await evalJson(`JSON.stringify(window.__animRuns)`));
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
