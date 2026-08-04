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
  const sb = document.querySelector('.session-sidebar');
  const sRect = sb.getBoundingClientRect();
  const header = sb.querySelector('.session-panel-header');
  const scroll = sb.querySelector('.session-sidebar-scroll');
  const scs = getComputedStyle(scroll);
  const kids = [...scroll.querySelectorAll('*')].filter(e => e.getClientRects().length && getComputedStyle(e).display !== 'none');
  const firstVisible = kids.find(e => e.getBoundingClientRect().height > 0);
  // last content bottom within scroll
  let maxBottom = 0;
  kids.forEach(e => { const b = e.getBoundingClientRect().bottom; if (b > maxBottom && b < sRect.bottom + 500) maxBottom = b; });
  const headerBottom = header.getBoundingClientRect().bottom;
  return {
    view: (sb.querySelector('.session-panel-title')||{}).textContent,
    headerB: Math.round(headerBottom - sRect.top),
    scrollPadTop: scs.paddingTop, scrollPadBottom: scs.paddingBottom,
    firstContentGap: firstVisible ? Math.round(firstVisible.getBoundingClientRect().top - headerBottom) : null,
    lastContentToPanelBottom: Math.round(sRect.bottom - maxBottom),
    sidebarH: Math.round(sRect.height),
  };
})()`;
const views = ['세션', '프로젝트', '워크플로', '스케줄'];
for (const v of views) {
  await evalJson(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||x.dataset.tooltip||'').includes('${v}')); if (b) { const sb=document.querySelector('.session-sidebar'); const t=(sb.querySelector('.session-panel-title')||{}).textContent||''; if (!t.includes('${v}'.slice(0,2))) b.click(); } })()`);
  await wait(450);
  console.log(v, await evalJson(`JSON.stringify(${snap})`));
}
ws.close();
