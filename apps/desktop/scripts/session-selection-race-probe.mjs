// Session-selection race probe (diagnosis tooling).
//
//   node scripts/session-selection-race-probe.mjs --port=9342 [--clicks=5] [--gap=1200]
//
// Switching sessions repeatedly sometimes lands on a session the user never
// picked. This probe clicks a FIXED screen position repeatedly — exactly what
// a hand does — and records, per step, which session id occupied that
// position at press time versus which session the app ended up selecting. It
// also samples the sidebar row order continuously, so a list re-sort that
// moves rows under the cursor is attributed instead of guessed.
const argumentsList = process.argv.slice(2);
const valueFor = (prefix) => argumentsList
  .find((argument) => argument.startsWith(`${prefix}=`))
  ?.slice(prefix.length + 1);
const port = Number(valueFor('--port') || 9342);
const clicks = Number(valueFor('--clicks') || 5);
const gapMs = Number(valueFor('--gap') || 1200);

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === 'page');
if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable page target found.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('CDP websocket failed.')), { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
});
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const orderExpression = `(() => {
  const list = document.querySelector('#recent-session-list');
  const rows = list ? [...list.querySelectorAll('[data-session-id]')] : [];
  const active = rows.find((row) => row.className.includes('active'));
  return {
    t: Math.round(performance.now()),
    order: rows.map((row) => (row.getAttribute('data-session-id') || '').slice(-6)),
    active: (active?.getAttribute('data-session-id') || '').slice(-6),
    tab: (document.querySelector('.workspace-tab.active .workspace-tab-main span')?.textContent || '').trim().slice(0, 24),
  };
})()`;

const rowAtExpression = (y) => `(() => {
  const list = document.querySelector('#recent-session-list');
  const rows = list ? [...list.querySelectorAll('[data-session-id]')] : [];
  const row = rows.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.width > 40 && ${y} >= rect.top && ${y} < rect.bottom;
  });
  if (!row) return null;
  const rect = row.getBoundingClientRect();
  return {
    id: (row.getAttribute('data-session-id') || '').slice(-6),
    title: (row.textContent || '').trim().slice(0, 28),
    y: Math.round(rect.y),
    x: Math.round(rect.x + Math.min(rect.width / 2, 90)),
  };
})()`;

await evaluate(`(() => {
  if (window.__mixdogOrderWatch) window.__mixdogOrderWatch.stop = true;
  const samples = [];
  const state = { stop: false, samples };
  window.__mixdogOrderWatch = state;
  const tick = () => {
    if (state.stop) return;
    const list = document.querySelector('#recent-session-list');
    const rows = list ? [...list.querySelectorAll('[data-session-id]')] : [];
    const key = rows.map((row) => (row.getAttribute('data-session-id') || '').slice(-6)).join(',');
    const active = rows.find((row) => row.className.includes('active'));
    const activeId = (active?.getAttribute('data-session-id') || '').slice(-6);
    const last = samples[samples.length - 1];
    if (!last || last.key !== key || last.activeId !== activeId) {
      samples.push({ t: Math.round(performance.now()), key, activeId });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`);

const preflight = await evaluate(`(() => {
  const list = document.querySelector('#recent-session-list');
  const rows = list ? [...list.querySelectorAll('[data-session-id]')] : [];
  return rows.slice(0, 3).map((row) => {
    const rect = row.getBoundingClientRect();
    return { id: (row.getAttribute('data-session-id') || '').slice(-6),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height) };
  });
})()`);
console.log('rows:', JSON.stringify(preflight));
const firstY = preflight[0]?.y ?? 160;
const rowHeight = (preflight[1]?.y ?? firstY + 32) - firstY || 32;
const steps = [];
// Fixed screen positions, walked like a hand moving down the list.
const positions = Array.from({ length: clicks }, (unused, index) =>
  Math.round(firstY + rowHeight * (index + 1) + rowHeight / 2));
for (const y of positions) {
  const before = await evaluate(rowAtExpression(y));
  if (!before) { steps.push({ y, before: null }); continue; }
  const x = before.x || 150;
  await request('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await request('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(gapMs);
  const after = await evaluate(orderExpression);
  const nowAt = await evaluate(rowAtExpression(y));
  steps.push({ y, before, after, nowAt });
}

const watch = await evaluate(`(() => {
  const state = window.__mixdogOrderWatch;
  if (!state) return [];
  state.stop = true;
  return state.samples;
})()`);

console.log('step\ty\tclicked\t\tselected\tmatch\tnow-at-y\ttab');
for (const step of steps) {
  if (!step.before) { console.log(`-\t${step.y}\t(no row)`); continue; }
  const match = step.before.id === step.after.active ? 'OK' : 'MISMATCH';
  console.log([
    '', step.y, `${step.before.id} ${step.before.title}`, step.after.active, match,
    step.nowAt ? step.nowAt.id : '-', step.after.tab,
  ].join('\t'));
}
console.log('--- sidebar order / active changes ---');
for (const sample of watch) {
  console.log(`${sample.t}\tactive=${sample.activeId}\t${sample.key}`);
}
socket.close();
process.exit(0);
