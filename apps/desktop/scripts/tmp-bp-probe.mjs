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
console.log('open:', await evalJson(`(() => {
  if (document.querySelector('.bottom-panel')) return 'already';
  const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'') === '패널 열기');
  if (b) { b.click(); return 'clicked'; }
  return 'nf:' + [...document.querySelectorAll('.topbar button')].map(x=>x.getAttribute('aria-label')).join('|');
})()`));
await wait(900);
console.log(await evalJson(`JSON.stringify((() => {
  const panel = document.querySelector('.bottom-panel');
  if (!panel) return { err: 'none' };
  const pRect = panel.getBoundingClientRect();
  const posL = (el) => el ? Math.round(el.getBoundingClientRect().left - pRect.left) : null;
  const strip = panel.querySelector('.dock-terminal-strip');
  return {
    tab1TextL: posL(panel.querySelector('.bottom-panel-tab')) + 8,
    stripHasTitle: !!(strip && strip.querySelector('b')),
    xtermL: posL(panel.querySelector('.xterm')),
    panelTop: Math.round(pRect.top), panelH: Math.round(pRect.height),
  };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-bp-shot.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
