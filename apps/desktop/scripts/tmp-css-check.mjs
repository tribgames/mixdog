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
  const scroll = document.querySelector('.sidebar.session-sidebar > .session-sidebar-scroll');
  const cs = scroll ? getComputedStyle(scroll) : null;
  const overlay = document.querySelector('vite-error-overlay');
  const head = document.querySelector('.workflows-section-head');
  return {
    scrollPad: cs ? cs.paddingLeft + '/' + cs.paddingRight : null,
    scrollCls: scroll ? scroll.className : null,
    headPad: head ? getComputedStyle(head).padding : null,
    overlay: !!overlay,
  };
})())`));
ws.close();
