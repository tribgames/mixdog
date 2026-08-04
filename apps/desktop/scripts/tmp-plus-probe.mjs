import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, expression: expr })).result?.result?.value;
console.log(await evalJson(`JSON.stringify((() => {
  const shell = document.querySelector('.workspace-tabs-shell');
  const btns = [...shell.querySelectorAll('button')].filter(b => b.getClientRects().length);
  const plus = btns.find(b => /새 작업|새 탭|New task|new-tab|추가/i.test(b.getAttribute('aria-label')||b.dataset.tooltip||'') || b.className.includes('new'));
  const info = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { cls: String(el.className).slice(0,40), aria: el.getAttribute('aria-label'),
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      pad: cs.padding, margin: cs.margin }; };
  const strip = shell.getBoundingClientRect();
  const svg = plus ? plus.querySelector('svg') : null;
  return { stripH: Math.round(strip.height),
    plus: plus ? info(plus) : null,
    plusSvg: svg ? { w: Math.round(svg.getBoundingClientRect().width), x: Math.round(svg.getBoundingClientRect().left), y: Math.round(svg.getBoundingClientRect().top) } : null,
    lastTab: (() => { const t = [...shell.querySelectorAll('.workspace-tab')].pop(); return t ? info(t) : null; })() };
})())`));
ws.close();
