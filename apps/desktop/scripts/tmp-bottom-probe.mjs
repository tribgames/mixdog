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
  const panel = document.querySelector('.bottom-panel');
  if (!panel) return { err: 'no bottom panel' };
  const pRect = panel.getBoundingClientRect();
  const pos = (el) => el ? Math.round(el.getBoundingClientRect().left - pRect.left) : null;
  const strip = panel.querySelector('.dock-terminal-strip');
  return {
    tab1Text: pos(panel.querySelector('.bottom-panel-tab')),
    tabList: pos(panel.querySelector('.bottom-panel-tab-list')),
    stripTitle: pos(strip ? strip.querySelector('b') : null),
    xtermText: pos(panel.querySelector('.xterm-rows')),
    tabPad: (() => { const t = panel.querySelector('.bottom-panel-tab'); return t ? getComputedStyle(t).padding : null; })(),
    listPad: (() => { const l = panel.querySelector('.bottom-panel-tab-list'); return l ? getComputedStyle(l).paddingLeft : null; })(),
    tabsPad: (() => { const l = panel.querySelector('.bottom-panel-tabs'); return l ? getComputedStyle(l).paddingLeft : null; })(),
  };
})())`));
ws.close();
