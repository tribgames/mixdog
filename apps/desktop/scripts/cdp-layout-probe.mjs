import { CdpClient } from './cdp-client.mjs';
import { optionValue } from './cli-args.mjs';

const argumentsList = process.argv.slice(2);
const port = Number(optionValue('port', argumentsList) || 9342);
const repair = argumentsList.includes('--repair');

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid CDP port: ${String(port)}`);
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => {
  if (!response.ok) throw new Error(`CDP target list failed with HTTP ${response.status}.`);
  return response.json();
});
const target =
  targets.find((candidate) => candidate.type === 'page' && /127\.0\.0\.1|localhost/.test(candidate.url)) ??
  targets.find((candidate) => candidate.type === 'page');
if (!target?.webSocketDebuggerUrl) {
  throw new Error(`No renderer page is available on CDP port ${port}.`);
}

const client = new CdpClient(target.webSocketDebuggerUrl, {
  defaultTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
});
await client.connect();

const readMetrics = () =>
  client.evaluate(`(() => {
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
    // The two shell bands (use-responsive-shell-bands.ts).
    narrowShell: matchMedia('(max-width: 760px)').matches,
    bottomSheetBand: matchMedia('(max-width: 940px)').matches,
    shell: rect(document.querySelector('.app-shell')),
    // The right titlebar cluster (updater badge) ahead of the caption reserve;
    // the first .titlebar-leading is the left brand mark.
    controls: rect(document.querySelector('.titlebar-controls')),
    main: rect(main),
    mainDirection: main ? getComputedStyle(main).flexDirection : null,
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
    Math.abs(after.outerWidth - after.innerWidth) > 96 || Math.abs(after.outerHeight - after.innerHeight) > 96;
  if (repair && surfaceIsDetached()) {
    // Chromium keeps the old 800x600 surface after the emulation override is gone; resizing the real window by 1px and back makes Windows emit WM_SIZE.
    await client.evaluate('window.resizeBy(-1, 0)');
    await new Promise((resolve) => setTimeout(resolve, 80));
    await client.evaluate('window.resizeBy(1, 0)');
    await new Promise((resolve) => setTimeout(resolve, 100));
    nativeResynchronized = true;
    after = await readMetrics();
  }
  // The bottom panel is a file pane's own sub-panel now, not a window-wide
  // column, so there is no global panel geometry left to exercise here.
  const widthMismatch = Math.abs(after.outerWidth - after.innerWidth) > 96;
  const heightMismatch = Math.abs(after.outerHeight - after.innerHeight) > 96;
  const controlsAreRightAligned = Boolean(
    after.controls && after.controls.x > after.innerWidth / 2 && after.controls.right <= after.innerWidth
  );
  const valid = !widthMismatch && !heightMismatch && after.mainDirection === 'column' && controlsAreRightAligned;
  const report = {
    valid,
    nativeResynchronized,
    repaired: repair && (before.innerWidth !== after.innerWidth || before.innerHeight !== after.innerHeight),
    before,
    after,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!valid) throw new Error(`Live layout validation failed: ${JSON.stringify(report)}`);
} finally {
  client.close();
}
