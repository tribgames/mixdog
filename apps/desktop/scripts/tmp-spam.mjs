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
// 6 rapid clicks on the dock toggle
await evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('유틸리티 패널')); for (let i = 0; i < 6; i++) b.click(); return 'spammed'; })()`);
await wait(600);
console.log('after 6 rapid clicks (coalesce→1 toggle):', await evalJson(dockOpen));
await wait(300);
// single clean click toggles back
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('유틸리티 패널')).click()`);
await wait(400);
console.log('after one more click:', await evalJson(dockOpen));
ws.close();
