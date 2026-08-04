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
  const sb = document.querySelector('.session-sidebar');
  const sRect = sb.getBoundingClientRect();
  const info = (el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0,44),
      text: (el.textContent||'').trim().slice(0,12),
      L: Math.round(r.left - sRect.left), R: Math.round(sRect.right - r.right),
      T: Math.round(r.top - sRect.top), w: Math.round(r.width), h: Math.round(r.height),
      font: cs.fontSize + '/' + cs.fontWeight, color: cs.color.replace(/color\\(srgb |\\)/g,''),
      pad: cs.padding, mar: cs.margin };
  };
  const wf = sb.querySelector('.workflows-pane');
  return {
    allHeads: [...wf.querySelectorAll('h2,h3,.workflows-section-head,.sidebar-section-heading,.session-panel-section-title')].map(info),
    plusBtns: [...wf.querySelectorAll('.workflows-section-head button, .schedules-new')].map(info),
    rowMenus: [...wf.querySelectorAll('.schedules-row button')].filter(b => b.querySelector('svg')).slice(0,4).map(info),
    schedSearch: [...sb.querySelectorAll('.schedules-search')].map(info),
    schedFilters: [...sb.querySelectorAll('.schedules-filters')].map(info),
  };
})())`);
console.log(JSON.stringify(JSON.parse(out), null, 1));
ws.close();
