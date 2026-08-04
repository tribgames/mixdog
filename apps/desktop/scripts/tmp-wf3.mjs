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
console.log('ensure:', await evalJson(`(() => {
  const sb = document.querySelector('.session-sidebar');
  const open = sb && sb.getBoundingClientRect().width > 100;
  const wf = document.querySelector('.workflows-pane');
  const wfActive = wf && wf.getBoundingClientRect().width > 100 && getComputedStyle(wf).display !== 'none';
  if (open && wfActive) return 'ready';
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||x.dataset.tooltip||'').includes('워크플로'));
  if (b) { b.click(); return 'clicked'; }
  return 'nf';
})()`));
await wait(700);
console.log(await evalJson(`JSON.stringify((() => {
  const sb = document.querySelector('.session-sidebar');
  const sRect = sb.getBoundingClientRect();
  if (sRect.width < 100) return { err: 'closed' };
  const wf = sb.querySelector('.workflows-pane');
  const pos = (el) => { const r = el.getBoundingClientRect();
    return { L: Math.round(r.left - sRect.left), R: Math.round(sRect.right - r.right) }; };
  return {
    plus: [...wf.querySelectorAll('.workflows-section-head button')].map(pos),
    menus: [...wf.querySelectorAll('.schedules-row .row-overflow-trigger')].slice(0,2).map(pos),
  };
})())`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('scripts/tmp-wf-shot3.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
