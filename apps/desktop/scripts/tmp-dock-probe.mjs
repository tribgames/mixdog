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
  const dock = document.querySelector('.utility-dock');
  const report = { dock: null, sidebarHeader: null };
  if (dock) {
    const dRect = dock.getBoundingClientRect();
    const pick = (sel) => [...dock.querySelectorAll(sel)].filter(e => e.getClientRects().length).slice(0, 4).map((el) => {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return { sel, text: (el.textContent||'').trim().slice(0,16), left: Math.round(r.left - dRect.left), font: cs.fontSize + '/' + cs.fontWeight, color: cs.color, padL: cs.paddingLeft };
    });
    report.dock = [
      ...pick('.session-panel-header'), ...pick('.session-panel-title'),
      ...pick('.utility-dock-title'), ...pick('h2'), ...pick('.sidebar-recent-heading'),
      ...pick('.agent-activity-row'), ...pick('.session-row'), ...pick('summary'),
      ...pick('.utility-dock-tabs'), ...pick('header'),
    ];
  }
  const sb = document.querySelector('.session-sidebar');
  if (sb) {
    const h = sb.querySelector('.session-panel-header');
    const cs = h ? getComputedStyle(h.querySelector('.session-panel-title') || h) : null;
    report.sidebarHeader = cs ? { font: cs.fontSize + '/' + cs.fontWeight, color: cs.color } : null;
  }
  return report;
})())`);
console.log(out);
ws.close();
