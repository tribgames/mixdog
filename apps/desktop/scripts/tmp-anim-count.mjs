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
// count dock expand animation runs document-wide
await evalJson(`(() => { window.__animRuns = []; document.addEventListener('animationstart', (e) => { if (e.animationName.includes('utility-dock')) window.__animRuns.push(e.animationName); }, true); return 'armed'; })()`);
// open dock
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('유틸리티 패널')).click()`);
await wait(500);
console.log('after dock open:', await evalJson(`JSON.stringify(window.__animRuns)`));
// toggle sidebar twice while dock is open (used to replay dock anim)
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('사이드바')).click()`);
await wait(400);
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('사이드바')).click()`);
await wait(400);
console.log('after 2 sidebar toggles:', await evalJson(`JSON.stringify(window.__animRuns)`));
// close dock back
await evalJson(`[...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('유틸리티 패널')).click()`);
ws.close();
