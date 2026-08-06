// Continuous jitter recorder (diagnosis tooling).
//
//   node scripts/jitter-recorder.mjs --port=9342 install
//   ... reproduce the shaking in the app ...
//   node scripts/jitter-recorder.mjs --port=9342 dump
//   node scripts/jitter-recorder.mjs --port=9342 now
//
// Layout-shift entries alone cannot explain a transcript that "shakes": the
// virtualizer writes scrollTop and row transforms directly. This recorder
// samples every animation frame — scroll state, per-row top/height, and each
// tool card's width and visible text — then reports only OSCILLATIONS (a
// value that moves and comes back), which is what a reader perceives as
// shaking, plus the text swaps that make a card change width.
const argumentsList = process.argv.slice(2);
const valueFor = (prefix) => argumentsList
  .find((argument) => argument.startsWith(`${prefix}=`))
  ?.slice(prefix.length + 1);
const port = Number(valueFor('--port') || 9342);
const mode = argumentsList.find((argument) => !argument.startsWith('--')) || 'install';

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
const evaluate = async (expression) => {
  const id = nextId++;
  const result = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
};

const installer = `(() => {
  if (window.__mixdogJitter) window.__mixdogJitter.stop = true;
  const frames = [];
  const shifts = [];
  const state = { stop: false, frames, shifts, startedAt: performance.now() };
  window.__mixdogJitter = state;
  const describe = (node) => {
    let current = node;
    const parts = [];
    for (let depth = 0; current && current.nodeType === 1 && depth < 3; depth += 1, current = current.parentElement) {
      const classes = typeof current.className === 'string'
        ? current.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.')
        : '';
      parts.push(current.tagName.toLowerCase() + (classes ? '.' + classes : ''));
    }
    return parts.join(' < ');
  };
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.value < 0.0005) continue;
        shifts.push({
          t: Math.round(entry.startTime),
          value: Number(entry.value.toFixed(5)),
          recent: entry.hadRecentInput === true,
          sources: (entry.sources || []).slice(0, 3).map((source) => ({
            node: describe(source.node),
            dy: Math.round((source.currentRect?.y ?? 0) - (source.previousRect?.y ?? 0)),
            dh: Math.round((source.currentRect?.height ?? 0) - (source.previousRect?.height ?? 0)),
            dw: Math.round((source.currentRect?.width ?? 0) - (source.previousRect?.width ?? 0)),
          })),
        });
        if (shifts.length > 400) shifts.shift();
      }
    });
    observer.observe({ type: 'layout-shift', buffered: false });
    state.observer = observer;
  } catch { /* layout-shift unsupported */ }
  const biggestTranscript = () => {
    let best = null;
    for (const element of document.querySelectorAll('.transcript')) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) continue;
      if (!best || rect.width * rect.height > best.area) best = { element, area: rect.width * rect.height, rect };
    }
    return best;
  };
  const tick = () => {
    if (state.stop) return;
    const found = biggestTranscript();
    if (found) {
      const view = found.element;
      const rows = [...view.querySelectorAll('.transcript-virtual-row')]
        .filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > found.rect.top && rect.top < found.rect.bottom;
        })
        .slice(0, 12)
        .map((row) => {
          const rect = row.getBoundingClientRect();
          return {
            i: Number(row.dataset.index),
            y: Math.round(rect.top - found.rect.top),
            h: Math.round(rect.height),
          };
        });
      const cards = [...view.querySelectorAll('.tool-card')]
        .filter((card) => {
          const rect = card.getBoundingClientRect();
          return rect.bottom > found.rect.top && rect.top < found.rect.bottom;
        })
        .slice(0, 6)
        .map((card) => {
          const rect = card.getBoundingClientRect();
          const title = card.querySelector('.tool-title');
          const detail = card.querySelector('.tool-detail-text');
          const titleRect = title?.getBoundingClientRect();
          return {
            i: Number(card.closest('.transcript-virtual-row')?.dataset.index ?? -1),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            tw: Math.round(titleRect?.width || 0),
            title: (title?.textContent || '').trim().slice(0, 48),
            detail: (detail?.textContent || '').trim().slice(0, 48),
          };
        });
      frames.push({
        t: Math.round(performance.now()),
        top: Math.round(view.scrollTop),
        height: Math.round(view.scrollHeight),
        client: Math.round(view.clientHeight),
        rows,
        cards,
      });
      if (frames.length > 2400) frames.shift();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 'installed';
})()`;

if (mode === 'install') {
  console.log(await evaluate(installer));
  socket.close();
  process.exit(0);
}

if (mode === 'now') {
  console.log(JSON.stringify(await evaluate(`(() => {
    const state = window.__mixdogJitter;
    return {
      installed: Boolean(state) && !state.stop,
      frames: state?.frames.length ?? 0,
      shifts: state?.shifts.length ?? 0,
      streaming: document.querySelectorAll('.message.streaming').length,
      toolCards: document.querySelectorAll('.tool-card').length,
    };
  })()`), null, 1));
  socket.close();
  process.exit(0);
}

const data = await evaluate(`(() => {
  const state = window.__mixdogJitter;
  if (!state) return null;
  state.stop = true;
  try { state.observer?.disconnect(); } catch {}
  const payload = { frames: state.frames.slice(), shifts: state.shifts.slice() };
  delete window.__mixdogJitter;
  return payload;
})()`);
if (!data) {
  console.log('recorder not installed');
  socket.close();
  process.exit(0);
}

const frames = data.frames;
const base = frames[0]?.t ?? 0;
console.log(`frames=${frames.length} span=${(frames.at(-1)?.t ?? 0) - base}ms shifts=${data.shifts.length}`);

// A reader perceives shaking as REVERSALS: a value moves one way and comes
// straight back. Count them per tracked quantity.
function reversals(series, threshold) {
  const events = [];
  for (let index = 2; index < series.length; index += 1) {
    const previous = series[index - 1].v - series[index - 2].v;
    const delta = series[index].v - series[index - 1].v;
    if (Math.abs(delta) < threshold || Math.abs(previous) < threshold) continue;
    if (Math.sign(delta) === Math.sign(previous)) continue;
    events.push({ t: series[index].t, from: series[index - 1].v, to: series[index].v, prev: previous });
  }
  return events;
}

const scrollSeries = frames.map((frame) => ({ t: frame.t - base, v: frame.top }));
const scrollReversals = reversals(scrollSeries, 4);
console.log(`scrollTop reversals(>=4px): ${scrollReversals.length}`);
for (const event of scrollReversals.slice(0, 12)) {
  console.log(`  ${event.t}ms  ${event.from} -> ${event.to} (prev ${event.prev})`);
}

const rowSeries = new Map();
for (const frame of frames) {
  for (const row of frame.rows) {
    if (!rowSeries.has(row.i)) rowSeries.set(row.i, []);
    rowSeries.get(row.i).push({ t: frame.t - base, v: row.y });
  }
}
const rowShake = [...rowSeries.entries()]
  .map(([index, series]) => ({ index, events: reversals(series, 3) }))
  .filter((entry) => entry.events.length > 0)
  .sort((left, right) => right.events.length - left.events.length);
console.log(`rows with vertical reversals(>=3px): ${rowShake.length}`);
for (const entry of rowShake.slice(0, 6)) {
  const sample = entry.events.slice(0, 4)
    .map((event) => `${event.t}ms ${event.from}->${event.to}`).join(', ');
  console.log(`  row ${entry.index}: ${entry.events.length} reversals | ${sample}`);
}

const cardSeries = new Map();
for (const frame of frames) {
  for (const card of frame.cards) {
    if (!cardSeries.has(card.i)) cardSeries.set(card.i, []);
    cardSeries.get(card.i).push({ t: frame.t - base, ...card });
  }
}
console.log('--- tool card width / text churn ---');
for (const [index, series] of cardSeries) {
  const widths = series.map((entry) => ({ t: entry.t, v: entry.tw }));
  const widthReversals = reversals(widths, 3);
  const titleSwaps = [];
  const detailSwaps = [];
  for (let step = 1; step < series.length; step += 1) {
    if (series[step].title !== series[step - 1].title) {
      titleSwaps.push(`${series[step].t}ms "${series[step - 1].title}" -> "${series[step].title}"`);
    }
    if (series[step].detail !== series[step - 1].detail) {
      detailSwaps.push(`${series[step].t}ms "${series[step - 1].detail}" -> "${series[step].detail}"`);
    }
  }
  if (!widthReversals.length && !titleSwaps.length && !detailSwaps.length) continue;
  console.log(`  card row=${index} titleWidthReversals=${widthReversals.length}`
    + ` titleSwaps=${titleSwaps.length} detailSwaps=${detailSwaps.length}`);
  for (const swap of titleSwaps.slice(0, 6)) console.log(`    title  ${swap}`);
  for (const swap of detailSwaps.slice(0, 6)) console.log(`    detail ${swap}`);
  for (const event of widthReversals.slice(0, 4)) {
    console.log(`    width  ${event.t}ms ${event.from} -> ${event.to}`);
  }
}

console.log('--- layout shifts (>=0.0005) ---');
for (const shift of data.shifts.slice(0, 20)) {
  console.log(`${shift.t - base}ms value=${shift.value}${shift.recent ? ' (recent-input)' : ''}`);
  for (const source of shift.sources) {
    console.log(`    dy=${source.dy} dh=${source.dh} dw=${source.dw}  ${source.node}`);
  }
}
socket.close();
process.exit(0);
