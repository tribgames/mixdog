import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const measure = `(() => {
  const sb = document.querySelector('.session-sidebar');
  const sRect = sb.getBoundingClientRect();
  const info = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { cls: String(el.className).slice(0,36), text: (el.textContent||'').trim().slice(0,10),
      L: Math.round(r.left - sRect.left), R: Math.round(sRect.right - r.right),
      T: Math.round(r.top - sRect.top), w: Math.round(r.width), h: Math.round(r.height),
      font: cs.fontSize + '/' + cs.fontWeight }; };
  const vis = (sel) => [...sb.querySelectorAll(sel)].filter(e => e.getClientRects().length
    && !e.closest('[inert]') && e.getBoundingClientRect().width > 0).map(info);
  return JSON.stringify({
    headerBtns: vis('.session-panel-header button'),
    search: vis('.schedules-search:not([hidden])').slice(0,1),
    input: vis('.schedules-search input').slice(0,1),
    filters: vis('.schedules-filters').slice(0,1),
    pills: vis('.schedules-filters button').slice(0,3),
    empty: vis('.schedules-empty p').slice(0,1),
  });
})()`;
// switch to Schedules rail view
await evalJson(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||x.dataset.tooltip||'').includes('스케줄') || (x.getAttribute('aria-label')||'').includes('Schedules')); if (b) b.click(); return b ? 'clicked' : 'not-found'; })()`);
await wait(500);
console.log('SCHEDULES:', await evalJson(measure));
await evalJson(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||x.dataset.tooltip||'').includes('웹훅') || (x.getAttribute('aria-label')||'').includes('Webhooks')); if (b) b.click(); return b ? 'clicked' : 'not-found'; })()`);
await wait(500);
console.log('WEBHOOKS:', await evalJson(measure));
// back to workflows to re-check heads after CSS fix
await evalJson(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||x.dataset.tooltip||'').includes('워크플로') ); if (b) b.click(); return b ? 'clicked' : 'not-found'; })()`);
await wait(500);
console.log('WF-HEADS:', await evalJson(`(() => {
  const sb = document.querySelector('.session-sidebar');
  const sRect = sb.getBoundingClientRect();
  return JSON.stringify([...sb.querySelectorAll('.workflows-pane h2')].map((el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { text: (el.textContent||'').trim().slice(0,10), L: Math.round(r.left - sRect.left),
      font: cs.fontSize + '/' + cs.fontWeight };
  }));
})()`));
ws.close();
