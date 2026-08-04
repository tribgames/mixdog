import WebSocket from "ws";

const list = await fetch("http://127.0.0.1:9342/json/list").then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
function send(method, params) {
  return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
}
ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
});
ws.on("open", async () => {
  const expr = `(() => {
    const gate = document.querySelector('.desktop-boot-gate');
    const covers = [...document.querySelectorAll('.pane-surface-cover, .desktop-boot-cover')].map(c => ({
      cls: c.className,
      rect: Math.round(c.getBoundingClientRect().width) + 'x' + Math.round(c.getBoundingClientRect().height),
      parent: (c.parentElement?.className || '').slice(0, 90),
      hasSpinner: !!c.querySelector('.desktop-loading-spinner'),
    }));
    const gates = [...document.querySelectorAll('.pane-surface-gate[data-ready="false"], .stable-surface-switch[data-ready="false"], .stable-content-swap[data-ready="false"]')]
      .map(g => g.className + ' | parent=' + (g.parentElement?.className || '').slice(0, 70));
    return JSON.stringify({
      bootGate: gate ? { ready: gate.dataset.ready, pending: gate.dataset.pending, timeout: gate.dataset.timeout } : null,
      revealed: window.__mixdogDesktopRevealed,
      shown: window.__mixdogWindowShown,
      covers, gates,
      metrics: (window.__mixdogBootMetrics || []).slice(-30),
      recovery: !!document.querySelector('.desktop-recovery-screen'),
      rootKids: document.getElementById('root')?.childElementCount,
      url: location.href,
    }, null, 1);
  })()`;
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  console.log(r?.result?.value ?? JSON.stringify(r));
  process.exit(0);
});
setTimeout(() => { console.error("timeout"); process.exit(1); }, 8000);
