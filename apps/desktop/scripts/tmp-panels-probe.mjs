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
    return { tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0,52),
      text: (el.textContent||'').trim().slice(0,14),
      left: Math.round(r.left - sRect.left), right: Math.round(sRect.right - r.right),
      top: Math.round(r.top - sRect.top), w: Math.round(r.width), h: Math.round(r.height),
      font: cs.fontSize + '/' + cs.fontWeight, color: cs.color,
      padL: cs.paddingLeft, padR: cs.paddingRight, mL: cs.marginLeft, mR: cs.marginRight };
  };
  const panes = {};
  // workflows pane
  const wf = sb.querySelector('.workflows-pane');
  if (wf) {
    panes.workflows = {
      heads: [...wf.querySelectorAll('.workflows-section-head')].map((head) => ({
        head: info(head),
        title: head.querySelector('h2,h3,b,span') ? info(head.querySelector('h2,h3,b,span')) : null,
        plus: head.querySelector('button') ? info(head.querySelector('button')) : null,
      })),
      otherHeads: [...wf.querySelectorAll('h2,h3')].map(info),
      rowMenu: [...wf.querySelectorAll('.schedules-row button')].slice(0,3).map(info),
      row: [...wf.querySelectorAll('.schedules-row')].slice(0,2).map(info),
    };
  }
  // schedules + webhooks panes
  for (const key of ['schedules','webhooks']) {
    const pane = [...sb.querySelectorAll('.schedules-pane')].find(p =>
      key === 'webhooks' ? (p.textContent||'').includes('웹훅') : (p.textContent||'').includes('스케줄'));
    if (!pane) continue;
    panes[key] = {
      search: pane.querySelector('.schedules-search') ? info(pane.querySelector('.schedules-search')) : null,
      searchInput: pane.querySelector('.schedules-search input') ? info(pane.querySelector('.schedules-search input')) : null,
      filters: pane.querySelector('.schedules-filters') ? info(pane.querySelector('.schedules-filters')) : null,
      filterBtn: pane.querySelector('.schedules-filters button') ? info(pane.querySelector('.schedules-filters button')) : null,
      empty: pane.querySelector('.schedules-empty') ? info(pane.querySelector('.schedules-empty')) : null,
      page: pane.querySelector('.schedules-page') ? info(pane.querySelector('.schedules-page')) : null,
    };
  }
  // panel header + action for the right axis reference
  const header = sb.querySelector('.session-panel-header');
  panes.header = { header: info(header), actions: [...header.querySelectorAll('button')].map(info) };
  return panes;
})())`);
console.log(JSON.stringify(JSON.parse(out), null, 1));
ws.close();
