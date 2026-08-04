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
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 900, deviceScaleFactor: 0, mobile: false });
await wait(500);
await evalJson(`(() => { window.__anims = []; document.addEventListener('animationstart', (e) => window.__anims.push(e.animationName), true); return 'armed'; })()`);
const click = (label) => evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('${label}')); if (b) { b.click(); return b.getAttribute('aria-label'); } return 'nf'; })()`);
// sidebar open (wide): expect sidebar-slide-in
console.log('sb:', await click('사이드바 펼치기')); await wait(350);
// dock open (wide): expect utility-dock-inline-expand
console.log('dock:', await click('유틸리티 패널 열기')); await wait(350);
// bottom open (wide): expect bottom-panel-expand
console.log('panel:', await click('패널 열기')); await wait(350);
console.log('anims:', await evalJson(`JSON.stringify(window.__anims.filter(n => /sidebar-slide|utility-dock|bottom-panel|bottom-sheet/.test(n)))`));
// toggling dock again must NOT replay sidebar/bottom anims
await evalJson(`window.__anims = []`);
console.log('dock close:', await click('유틸리티 패널 닫기')); await wait(300);
console.log('dock reopen:', await click('유틸리티 패널 열기')); await wait(350);
console.log('anims on dock retoggle:', await evalJson(`JSON.stringify(window.__anims.filter(n => /sidebar-slide|utility-dock|bottom-panel|bottom-sheet/.test(n)))`));
// cleanup: close all
await click('패널 닫기'); await wait(200);
await click('유틸리티 패널 닫기'); await wait(200);
await click('사이드바 접기'); await wait(200);
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
