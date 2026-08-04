import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
const out = await evalJson(`JSON.stringify((() => {
  const sidebar = document.querySelector('.session-sidebar, .session-drawer, aside[class*=sidebar]');
  if (!sidebar) return { error: 'no sidebar', classes: [...document.querySelectorAll('aside')].map(a=>a.className) };
  const sRect = sidebar.getBoundingClientRect();
  const rows = [];
  const seen = new Set();
  sidebar.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const text = (el.textContent || '').trim().slice(0, 18);
    if (!text) return;
    // only leaf-ish rows: direct text or buttons/headers
    const cs = getComputedStyle(el);
    const key = el.className + '|' + text;
    if (seen.has(key)) return; seen.add(key);
    rows.push({
      cls: String(el.className).slice(0, 48),
      tag: el.tagName.toLowerCase(),
      text,
      left: Math.round(r.left - sRect.left),
      top: Math.round(r.top - sRect.top),
      w: Math.round(r.width), h: Math.round(r.height),
      font: cs.fontSize + '/' + cs.fontWeight,
      padL: cs.paddingLeft, padR: cs.paddingRight,
    });
  });
  return { sidebar: { cls: sidebar.className, w: Math.round(sRect.width) }, rows: rows.slice(0, 60) };
})())`);
console.log(out);
ws.close();
