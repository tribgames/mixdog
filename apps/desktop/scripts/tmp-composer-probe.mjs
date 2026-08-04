import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => setTimeout(r, 300));
const out = await send('Runtime.evaluate', { expression: `JSON.stringify([...document.querySelectorAll('.composer')].map((c) => {
  const region = c.closest('.composer-region');
  const pane = c.closest('.pane-cell, .pane-carousel-item');
  const rr = region?.getBoundingClientRect(); const cr = c.getBoundingClientRect(); const pr = pane?.getBoundingClientRect();
  const rs = region ? getComputedStyle(region) : null;
  return {
    welcome: !!c.closest('.thread-welcome'),
    composerH: Math.round(cr.height),
    regionPadBottom: rs?.paddingBottom, regionPadTop: rs?.paddingTop,
    gapToPaneBottom: pr ? Math.round(pr.bottom - cr.bottom) : null,
    regionH: rr ? Math.round(rr.height) : null,
  };
}))`, returnByValue: true });
console.log(out.result?.result?.value);
ws.close();
