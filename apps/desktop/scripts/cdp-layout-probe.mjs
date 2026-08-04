const argumentsList = process.argv.slice(2);
const valueFor = (prefix) => argumentsList
  .find((argument) => argument.startsWith(`${prefix}=`))
  ?.slice(prefix.length + 1);
const port = Number(valueFor('--port') || 9342);
const repair = argumentsList.includes('--repair');
const exercisePanel = argumentsList.includes('--exercise-panel');

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid CDP port: ${String(port)}`);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out.')), 10_000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP websocket failed.'));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  request(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.request('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
  .then((response) => {
    if (!response.ok) throw new Error(`CDP target list failed with HTTP ${response.status}.`);
    return response.json();
  });
const target = targets.find((candidate) =>
  candidate.type === 'page' && /127\.0\.0\.1|localhost/.test(candidate.url))
  ?? targets.find((candidate) => candidate.type === 'page');
if (!target?.webSocketDebuggerUrl) {
  throw new Error(`No renderer page is available on CDP port ${port}.`);
}

const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();

const readMetrics = () => client.evaluate(`(() => {
  const rect = (node) => {
    if (!node) return null;
    const bounds = node.getBoundingClientRect();
    return {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      right: Math.round(bounds.right),
      bottom: Math.round(bounds.bottom),
    };
  };
  const main = document.querySelector('.main-panel');
  return {
    innerWidth,
    innerHeight,
    outerWidth,
    outerHeight,
    media900: matchMedia('(max-width: 900px)').matches,
    shell: rect(document.querySelector('.app-shell')),
    controls: rect(document.querySelector('.titlebar-leading')),
    main: rect(main),
    mainDirection: main ? getComputedStyle(main).flexDirection : null,
    dock: rect(document.querySelector('.desktop-body > .utility-dock[data-side="right"]')),
    panel: rect(document.querySelector('.bottom-panel')),
  };
})()`);

const waitForLayout = async () => {
  const deadline = Date.now() + 15_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const metrics = await readMetrics();
      if (metrics.shell && metrics.controls && metrics.main) return metrics;
    } catch (error) {
      // A development reload can replace the execution context while the
      // target socket stays live. Retry until the new React shell commits.
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Live layout did not become ready.${lastError ? ` ${lastError.message}` : ''}`);
};

try {
  const before = await waitForLayout();
  if (repair) {
    // Puppeteer applies an 800x600 device override when a live Electron target
    // is connected without an explicit null viewport. Clear only that debugger
    // state; never emulate or resize the application during layout validation.
    await client.request('Emulation.clearDeviceMetricsOverride');
    await client.request('Emulation.setTouchEmulationEnabled', { enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let after = await readMetrics();
  let nativeResynchronized = false;
  const surfaceIsDetached = () =>
    Math.abs(after.outerWidth - after.innerWidth) > 96
    || Math.abs(after.outerHeight - after.innerHeight) > 96;
  if (repair && surfaceIsDetached()) {
    // Chromium can retain the old 800x600 content surface even after the
    // emulation override is gone. Nudge the REAL BrowserWindow bounds and put
    // them straight back; Windows then emits WM_SIZE and Electron resizes the
    // compositor without changing the user's stored geometry.
    await client.evaluate('window.resizeBy(-1, 0)');
    await new Promise((resolve) => setTimeout(resolve, 80));
    await client.evaluate('window.resizeBy(1, 0)');
    await new Promise((resolve) => setTimeout(resolve, 100));
    nativeResynchronized = true;
    after = await readMetrics();
  }
  let panelExercise = null;
  if (exercisePanel) {
    const wasOpen = await client.evaluate(`(() => {
      const button = document.querySelector('.titlebar-leading .toolbar-panel');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Panel layout button is unavailable.');
      }
      const wasOpen = button.getAttribute('aria-pressed') === 'true';
      if (!wasOpen) button.click();
      return wasOpen;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const openedMetrics = await readMetrics();
    panelExercise = {
      wasOpen,
      opened: {
        main: openedMetrics.main,
        panel: openedMetrics.panel,
      },
    };
    if (!wasOpen) {
      await client.evaluate(`document.querySelector(
        '.titlebar-leading .toolbar-panel'
      )?.click()`);
    }
  }

  const widthMismatch = Math.abs(after.outerWidth - after.innerWidth) > 96;
  const heightMismatch = Math.abs(after.outerHeight - after.innerHeight) > 96;
  const controlsAreRightAligned = Boolean(
    after.controls
    && after.controls.x > after.innerWidth / 2
    && after.controls.right <= after.innerWidth
  );
  const dockWidthIsBounded = !after.dock
    || (after.dock.width >= 300 && after.dock.width <= 560);
  const opened = panelExercise?.opened;
  const panelUsesMainWidth = !opened
    || Boolean(
      opened.panel
      && opened.main
      && Math.abs(opened.panel.x - opened.main.x) <= 2
      && Math.abs(opened.panel.right - opened.main.right) <= 2
      && Math.abs(opened.panel.bottom - opened.main.bottom) <= 2
    );
  const valid = !widthMismatch
    && !heightMismatch
    && after.mainDirection === 'column'
    && controlsAreRightAligned
    && dockWidthIsBounded
    && panelUsesMainWidth;
  const report = {
    valid,
    nativeResynchronized,
    repaired: repair && (
      before.innerWidth !== after.innerWidth || before.innerHeight !== after.innerHeight
    ),
    before,
    after,
    panelExercise,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!valid) throw new Error(`Live layout validation failed: ${JSON.stringify(report)}`);
} finally {
  client.close();
}
