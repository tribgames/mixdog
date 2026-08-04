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
console.log('open:', await evalJson(`(() => {
  const dock = document.querySelector('.utility-dock');
  if (dock && dock.getBoundingClientRect().width > 100) return 'already';
  const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('utility panel'));
  if (b) { b.click(); return 'clicked'; } return 'nf';
})()`));
await wait(800);
const snap = `(() => {
  const dock = document.querySelector('.utility-dock');
  const dRect = dock.getBoundingClientRect();
  const info = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { L: Math.round(r.left - dRect.left), R: Math.round(dRect.right - r.right),
      T: Math.round(r.top - dRect.top), w: Math.round(r.width), h: Math.round(r.height),
      font: cs.fontSize + '/' + cs.fontWeight }; };
  const pane = [...dock.querySelectorAll('.utility-dock-pane')].find(p => p.dataset.surfaceActive === 'true');
  const vis = (sel, n=4) => [...pane.querySelectorAll(sel)].filter(e => e.getClientRects().length && e.getBoundingClientRect().height > 0).slice(0, n).map(e => ({ t: (e.textContent||'').trim().slice(0,14), cls: String(e.className).slice(0,30), ...info(e) }));
  const kids = [...pane.querySelectorAll('*')].filter(e => e.getClientRects().length && e.getBoundingClientRect().height > 2 && e.getBoundingClientRect().width > 10);
  const first = kids.sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0];
  return {
    tab: pane.dataset.tab,
    title: (() => { const t = dock.querySelector('.utility-dock-title'); return t ? { t: t.textContent.trim().slice(0,16), ...info(t) } : null; })(),
    headerBtns: [...dock.querySelectorAll('.utility-dock-tabs-header button')].filter(e=>e.getClientRects().length).slice(-3).map(e => ({ aria: (e.getAttribute('aria-label')||'').slice(0,14), ...info(e) })),
    firstContent: first ? { cls: String(first.className).slice(0,36), ...info(first) } : null,
    searches: vis('input', 2),
    heads: vis('h2, h3, .workflows-section-head, summary', 4),
    rows: vis('.session-row, .schedules-row, .agent-activity-row, .scm-row, button[role=treeitem]', 3),
  };
})()`;
for (const tab of ['tasks', 'files', 'source-control', 'pull-requests']) {
  await evalJson(`(() => { const btns = [...document.querySelectorAll('.utility-dock-tabs button')]; const b = btns.find(x => (x.dataset.tab||'') === '${tab}') || btns[['tasks','files','source-control','pull-requests'].indexOf('${tab}')]; if (b) b.click(); })()`);
  await wait(600);
  console.log(JSON.stringify(JSON.parse(await evalJson(`JSON.stringify(${snap})`))));
}
ws.close();
