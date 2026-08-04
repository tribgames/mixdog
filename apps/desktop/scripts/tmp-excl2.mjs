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
const click = (label, exclude) => evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => { const a = x.getAttribute('aria-label')||''; return a.includes('${label}')${exclude ? ` && !a.includes('${exclude}')` : ''}; }); if (b) { b.click(); return b.getAttribute('aria-label'); } return 'nf'; })()`);
const state = () => evalJson(`JSON.stringify({ dock: !!document.querySelector('.utility-dock'), panel: !!document.querySelector('.bottom-panel'), drawer: !!document.querySelector('.session-sidebar.open') })`);
await send('Emulation.setDeviceMetricsOverride', { width: 747, height: 700, deviceScaleFactor: 0, mobile: false });
await wait(500);
// scenario A: bottom open -> open dock -> bottom must close
await click('패널 열기', '유틸리티'); await wait(400);
console.log('bottom opened:', await state());
await click('유틸리티 패널 열기'); await wait(500);
console.log('A) dock opened (want panel:false):', await state());
// scenario B: close dock; open bottom; open drawer -> bottom must close
await click('유틸리티 패널 닫기'); await wait(400);
await click('패널 열기', '유틸리티'); await wait(400);
await click('사이드바 펼치기'); await wait(500);
console.log('B) drawer opened (want panel:false, drawer:true):', await state());
// cleanup
await click('사이드바 접기'); await wait(300);
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
