import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9343/json')).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJson = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, expression: expr })).result?.result?.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = `(() => {
  const dock = document.querySelector('.utility-dock');
  const dRect = dock.getBoundingClientRect();
  const info = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { L: Math.round(r.left - dRect.left), R: Math.round(dRect.right - r.right),
      T: Math.round(r.top - dRect.top), h: Math.round(r.height), font: cs.fontSize + '/' + cs.fontWeight }; };
  const pane = [...dock.querySelectorAll('.utility-dock-pane')].find(p => p.dataset.surfaceActive === 'true');
  const header = pane.querySelector('.utility-dock-header');
  const title = header ? header.querySelector('b, .utility-dock-title') : null;
  const hBtns = header ? [...header.querySelectorAll('button')].filter(e=>e.getClientRects().length).map(e => info(e)) : [];
  const below = [...pane.querySelectorAll('*')].filter(e => e.getClientRects().length
    && e.getBoundingClientRect().top > (header ? header.getBoundingClientRect().bottom : 0) + 1
    && e.getBoundingClientRect().height > 4 && e.getBoundingClientRect().width > 30)
    .sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0];
  const searchLabel = pane.querySelector('.workbench-search-input, .schedules-search, .scm-filter, label');
  return {
    tab: pane.dataset.tab,
    headerBox: info(header),
    titleText: title ? { t: title.textContent.trim().slice(0,14), ...info(title) } : null,
    headerBtnsR: hBtns.map(b => b.R + 'w' + (b.R !== null ? '' : '')).join(','),
    hBtnDetail: hBtns.slice(-2).map(info => info),
    firstBelowHeader: below ? { cls: String(below.className).slice(0,32), ...info(below) } : null,
    searchBox: searchLabel ? { cls: String(searchLabel.className).slice(0,26), ...info(searchLabel) } : null,
  };
})()`;
for (const tab of ['tasks', 'files', 'source-control', 'pull-requests']) {
  await evalJson(`(() => { const btns = [...document.querySelectorAll('.utility-dock-tabs button')]; const b = btns[['tasks','files','source-control','pull-requests'].indexOf('${tab}')]; if (b) b.click(); })()`);
  await wait(600);
  console.log(JSON.stringify(JSON.parse(await evalJson(`JSON.stringify(${snap})`))));
}
ws.close();
