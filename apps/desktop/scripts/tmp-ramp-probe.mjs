import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
console.log(await evalJson(`JSON.stringify((() => {
  const f = (el) => { if (!el) return null; const cs = getComputedStyle(el);
    return cs.fontSize + '/' + cs.fontWeight + ' ' + cs.color.slice(0, 40); };
  const sb = document.querySelector('.session-sidebar');
  return {
    title: f(sb.querySelector('.session-panel-title')),
    category: f(sb.querySelector('.sidebar-recent-heading.sidebar-heading-toggle')),
    itemName_card: f(sb.querySelector('.schedules-row-copy b')),
    itemRow_session: f(sb.querySelector('.session-row-copy b')),
    meta_small: f(sb.querySelector('.schedules-row-copy small')),
    dockTitle: f(document.querySelector('.utility-dock-title b') || document.querySelector('.utility-dock-title')),
  };
})())`));
ws.close();
