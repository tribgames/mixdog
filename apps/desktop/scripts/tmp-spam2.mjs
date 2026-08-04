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
const dockOpen = `!!document.querySelector('.utility-dock--persistent')`;
console.log('before:', await evalJson(dockOpen));
// Simulate the OS-queued burst: 6 events CREATED in one instant (shared
// timeStamp burst), but DISPATCHED 150ms apart as if the main thread had
// been blocked between them.
console.log('setup:', await evalJson(`(() => {
  const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('유틸리티 패널'));
  window.__burst = Array.from({ length: 6 }, () => new MouseEvent('click', { bubbles: true, cancelable: true }));
  window.__burstBtn = b;
  return 'ready ts=' + Math.round(window.__burst[0].timeStamp);
})()`));
for (let i = 0; i < 6; i++) {
  await evalJson(`window.__burstBtn.dispatchEvent(window.__burst[${i}])`);
  await wait(150);
}
await wait(400);
console.log('after delayed burst (want: single toggle):', await evalJson(dockOpen));
// cleanup: toggle back after the window passes
await wait(300);
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('유틸리티 패널')).click()`);
await wait(300);
console.log('restored:', await evalJson(dockOpen));
ws.close();
