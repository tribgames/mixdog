import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => setTimeout(r, 300));
const out = await send('Runtime.evaluate', { expression: `JSON.stringify((() => {
  const info = (el) => { if (!el) return null; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); const sv = el.querySelector('svg')?.getBoundingClientRect(); return { color: s.color, btnCy: Math.round((r.top + r.bottom) / 2 * 10) / 10, svgCy: sv ? Math.round((sv.top + sv.bottom) / 2 * 10) / 10 : null, h: r.height }; };
  return {
    theme: document.querySelector('.app-shell') ? getComputedStyle(document.body).backgroundColor : null,
    sidebar: info(document.querySelector('.topbar .toolbar-sidebar')),
    prev: info(document.querySelectorAll('.titlebar-pane-nav')[0]),
    panel: info(document.querySelector('.topbar .toolbar-panel')),
    iconVar: getComputedStyle(document.documentElement).getPropertyValue('--mx-icon'),
    mutedVar: getComputedStyle(document.documentElement).getPropertyValue('--mx-icon-muted'),
  };
})())`, returnByValue: true });
console.log(out.result?.result?.value);
ws.close();
