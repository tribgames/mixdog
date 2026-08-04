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
// 1) toggle sidebar via topbar button and watch the settle class + transition
console.log(await evalJson(`(() => {
  const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('session sidebar'));
  if (!b) return 'nf';
  b.click();
  const armed = document.documentElement.classList.contains('mx-side-panel-animating');
  const cs = getComputedStyle(document.querySelector('.sidebar.session-sidebar'));
  return JSON.stringify({ armed, transition: cs.transitionProperty.slice(0, 60), duration: cs.transitionDuration.split(',')[0] });
})()`));
await wait(400);
console.log('after settle:', await evalJson(`document.documentElement.classList.contains('mx-side-panel-animating')`));
// restore sidebar state
await evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('session sidebar')); if (b) b.click(); })()`);
await wait(400);
// 2) dock open animation name while armed
console.log(await evalJson(`(() => {
  const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('utility panel'));
  if (!b) return 'nf';
  b.click();
  const dock = document.querySelector('.utility-dock--persistent');
  if (!dock) return 'no-dock-yet';
  return JSON.stringify({ anim: getComputedStyle(dock).animationName });
})()`));
await wait(500);
console.log('dock anim after settle:', await evalJson(`(() => { const d = document.querySelector('.utility-dock--persistent'); return d ? getComputedStyle(d).animationName : null; })()`));
await evalJson(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(x => (x.getAttribute('aria-label')||'').includes('utility panel')); if (b) b.click(); })()`);
ws.close();
