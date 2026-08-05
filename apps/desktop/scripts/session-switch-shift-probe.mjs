// Session-entry shift probe (diagnosis tooling).
//
//   node scripts/session-switch-shift-probe.mjs --port=9342 [--index=0]
//
// Clicking a session in the sidebar remounts the pane's transcript. This probe
// samples, every animation frame across that remount, the viewport scroll
// state and the on-screen position of the first/last virtual row, and wraps
// scrollTop/scrollTo so every programmatic write is attributed to its caller.
// The output tells whether a visible up/down shift comes from measurement
// growth (scrollHeight), from a scroll writer, or from late row geometry.
const argumentsList = process.argv.slice(2);
const valueFor = (prefix) => argumentsList
  .find((argument) => argument.startsWith(`${prefix}=`))
  ?.slice(prefix.length + 1);
const port = Number(valueFor('--port') || 9342);
const rowIndex = Number(valueFor('--index') || 0);
const settleMs = Number(valueFor('--settle') || 2500);
const traceMs = Number(valueFor('--trace') || 0);

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => {
  if (!response.ok) throw new Error(`CDP target list failed with HTTP ${response.status}.`);
  return response.json();
});
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
  const result = await request('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Navigation collapses an overlay sidebar, and a fresh install boots with it
// closed. The probe measures a session CLICK, so the list has to be on screen.
const ensureSidebar = async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const visible = await evaluate(`(() => {
      const row = document.querySelector('#recent-session-list [data-session-id]');
      if (!row) return false;
      const rect = row.getBoundingClientRect();
      return rect.width > 40 && rect.x >= 0;
    })()`);
    if (visible) return true;
    await evaluate(`(() => {
      const toggle = document.querySelector('button[aria-label="Toggle session list"]');
      if (toggle) toggle.click();
      return Boolean(toggle);
    })()`);
    await sleep(500);
  }
  return evaluate(`Boolean(document.querySelector('#recent-session-list [data-session-id]'))`);
};
await ensureSidebar();

const install = `(() => {
  if (!window.__mixdogShiftObserver) {
    const shifts = [];
    const describe = (node) => {
      let current = node;
      const parts = [];
      for (let depth = 0; current && current.nodeType === 1 && depth < 3; depth += 1, current = current.parentElement) {
        const classes = typeof current.className === 'string'
          ? current.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.')
          : '';
        parts.push(current.tagName.toLowerCase() + (classes ? '.' + classes : ''));
      }
      return parts.join(' < ');
    };
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        shifts.push({
          t: Math.round(entry.startTime),
          value: Number(entry.value.toFixed(5)),
          recent: entry.hadRecentInput === true,
          sources: (entry.sources || []).slice(0, 4).map((source) => ({
            node: describe(source.node),
            from: Math.round(source.previousRect?.y ?? 0),
            to: Math.round(source.currentRect?.y ?? 0),
            fromH: Math.round(source.previousRect?.height ?? 0),
            toH: Math.round(source.currentRect?.height ?? 0),
          })),
        });
      }
    });
    observer.observe({ type: 'layout-shift', buffered: false });
    window.__mixdogShiftObserver = { observer, shifts };
  }
  window.__mixdogShiftObserver.shifts.length = 0;
  if (!window.__mixdogShiftWrites) {
    const writes = [];
    const stackOf = () => (new Error().stack || '').split('\\n').slice(3, 7)
      .map((line) => line.trim().replace(/^at /, '').replace(/https?:\\/\\/[^/]+\\//g, ''))
      .join(' | ');
    const proto = Element.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'scrollTop');
    Object.defineProperty(proto, 'scrollTop', {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) {
        if (this.classList && this.classList.contains('transcript')) {
          writes.push({ t: Math.round(performance.now()), kind: 'scrollTop=',
            from: Math.round(descriptor.get.call(this)), to: Math.round(value), stack: stackOf() });
        }
        descriptor.set.call(this, value);
      },
    });
    const originalScrollTo = proto.scrollTo;
    proto.scrollTo = function scrollToProbe(...args) {
      const top = args.length === 1 && typeof args[0] === 'object' ? args[0]?.top : args[1];
      if (typeof top === 'number' && this.classList && this.classList.contains('transcript')) {
        writes.push({ t: Math.round(performance.now()), kind: 'scrollTo',
          from: Math.round(descriptor.get.call(this)), to: Math.round(top), stack: stackOf() });
      }
      return originalScrollTo.apply(this, args);
    };
    window.__mixdogShiftWrites = writes;
  }
  window.__mixdogShiftWrites.length = 0;
  const frames = [];
  window.__mixdogShiftFrames = frames;
  const visibleTranscript = () => {
    let best = null;
    for (const element of document.querySelectorAll('.transcript')) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) continue;
      if (!best || rect.width * rect.height > best.area) {
        best = { element, area: rect.width * rect.height, rect };
      }
    }
    return best;
  };
  const sample = () => {
    if (!window.__mixdogShiftFrames) return;
    const found = visibleTranscript();
    const list = document.querySelector('#recent-session-list');
    const listRows = list ? [...list.querySelectorAll('[data-session-id]')] : [];
    const above = [...document.querySelectorAll('.session-sidebar-scroll > section')]
      .map((section) => Math.round(section.getBoundingClientRect().height)).join(',');
    if (found) {
      const view = found.element;
      const surface = view.closest('.pane-chat-surface') || document;
      const composer = surface.querySelector('.composer-region');
      const composerKids = composer
        ? [...composer.querySelectorAll('*')]
          .filter((node) => node.parentElement === composer
            || node.parentElement?.classList?.contains('composer'))
          .map((node) => {
            const name = typeof node.className === 'string'
              ? node.className.trim().split(/\\s+/)[0]
              : node.tagName.toLowerCase();
            return name ? name + ':' + Math.round(node.getBoundingClientRect().height) : '';
          })
          .filter(Boolean).slice(0, 10).join(',')
        : '';
      const rows = view.querySelectorAll('.transcript-virtual-row');
      const first = rows[0];
      const last = rows[rows.length - 1];
      const space = view.querySelector('.transcript-virtual-space');
      frames.push({
        t: Math.round(performance.now()),
        key: view.getAttribute('data-session-key') || view.closest('[data-session-key]')?.getAttribute('data-session-key') || '',
        top: Math.round(view.scrollTop),
        height: Math.round(view.scrollHeight),
        client: Math.round(view.clientHeight),
        space: space ? Math.round(parseFloat(space.style.height) || 0) : 0,
        rows: rows.length,
        welcome: view.querySelector('.thread-welcome') ? 1 : 0,
        firstIndex: first ? Number(first.dataset.index) : -1,
        firstTop: first ? Math.round(first.getBoundingClientRect().top - found.rect.top) : 0,
        lastIndex: last ? Number(last.dataset.index) : -1,
        lastBottom: last ? Math.round(last.getBoundingClientRect().bottom - found.rect.top) : 0,
        listTop: list ? Math.round(list.getBoundingClientRect().y) : -1,
        listCount: listRows.length,
        listHead: listRows.slice(0, 3).map((row) => (row.getAttribute('data-session-id') || '').slice(-6)).join('/'),
        sections: above,
        composerH: composer ? Math.round(composer.getBoundingClientRect().height) : -1,
        composerKids,
      });
    }
    if (frames.length < 1200) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  const rows = [...document.querySelectorAll('#recent-session-list [data-session-id]')];
  return rows.slice(0, 24).map((row, index) => {
    const rect = row.getBoundingClientRect();
    return {
      index,
      id: row.getAttribute('data-session-id'),
      active: row.className.includes('active') || row.getAttribute('aria-current') === 'page',
      title: (row.textContent || '').trim().slice(0, 40),
      x: Math.round(rect.x + Math.min(rect.width / 2, 90)),
      y: Math.round(rect.y + rect.height / 2),
    };
  });
})()`;

const rows = await evaluate(install);
if (!rows?.length) {
  console.log('no sidebar session rows found');
  socket.close();
  process.exit(0);
}
const pick = rows.filter((row) => !row.active)[rowIndex] || rows[rowIndex];
console.log('clicking', JSON.stringify(pick));
await request('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: pick.x, y: pick.y, button: 'left', clickCount: 1,
});
await request('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: pick.x, y: pick.y, button: 'left', clickCount: 1,
});
await sleep(settleMs);

const result = await evaluate(`(() => {
  const frames = window.__mixdogShiftFrames || [];
  const writes = window.__mixdogShiftWrites || [];
  const shifts = window.__mixdogShiftObserver?.shifts || [];
  delete window.__mixdogShiftFrames;
  return { frames, writes: writes.splice(0, writes.length), shifts: shifts.splice(0, shifts.length) };
})()`);

const frames = result?.frames || [];
const base = frames[0]?.t || 0;
const changed = frames.filter((frame, index) => {
  if (index === 0) return true;
  if (traceMs > 0 && frame.t - base <= traceMs) return true;
  const previous = frames[index - 1];
  return frame.top !== previous.top
    || frame.height !== previous.height
    || frame.rows !== previous.rows
    || frame.key !== previous.key
    || frame.welcome !== previous.welcome
    || frame.listTop !== previous.listTop
    || frame.listCount !== previous.listCount
    || frame.listHead !== previous.listHead
    || frame.sections !== previous.sections
    || frame.composerH !== previous.composerH
    || frame.composerKids !== previous.composerKids
    || Math.abs(frame.lastBottom - previous.lastBottom) > 1
    || Math.abs(frame.firstTop - previous.firstTop) > 1;
});
console.log(`frames=${frames.length} changed=${changed.length} writes=${result.writes.length}`);
console.log('ms\ttop\theight\tspace\trows\tlast@\tcompH\tcomposer children');
for (const frame of changed) {
  console.log([
    frame.t - base, frame.top, frame.height, frame.space,
    `${frame.firstIndex}/${frame.rows}`, frame.lastBottom,
    frame.composerH, frame.composerKids,
  ].join('\t'));
}
console.log('--- programmatic scroll writes ---');
for (const write of result.writes) {
  console.log(`${write.t - base}\t${write.kind}\t${write.from} -> ${write.to}\t${write.stack}`);
}
const placement = await evaluate(`(() => {
  const slot = document.querySelector('.turn-review-slot');
  if (!slot) return 'no review slot mounted';
  return 'review slot parent=' + (slot.parentElement?.className || '(none)')
    + ' insideTranscript=' + Boolean(slot.closest('.transcript'))
    + ' insideComposer=' + Boolean(slot.closest('.composer-region'));
})()`);
console.log('--- review placement ---');
console.log(placement);
console.log('--- layout shifts ---');
for (const shift of result.shifts || []) {
  console.log(`${shift.t - base}\tvalue=${shift.value}${shift.recent ? ' (recent-input)' : ''}`);
  for (const source of shift.sources) {
    console.log(`\t  y ${source.from} -> ${source.to}  h ${source.fromH} -> ${source.toH}  ${source.node}`);
  }
}
socket.close();
process.exit(0);
