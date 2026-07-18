const [webSocketUrl, projectPath] = process.argv.slice(2);
if (!webSocketUrl || !projectPath) {
  throw new Error('Usage: node scripts/cdp-smoke.mjs <webSocketUrl> <projectPath>');
}

const socket = new WebSocket(webSocketUrl);
const rendererExpression = `(async () => {
  const timing = {};
  const api = window.mixdogDesktop;
  if (!api) throw new Error('preload bridge missing');
  const methods = ['startProject', 'getSnapshot', 'submit', 'resolveToolApproval', 'dispose'];
  if (!methods.every((name) => typeof api[name] === 'function')) {
    throw new Error('preload bridge incomplete');
  }
  let startedAt = performance.now();
  const started = await api.startProject(${JSON.stringify(projectPath)});
  timing.projectMs = performance.now() - startedAt;
  startedAt = performance.now();
  const submitted = await api.submit('/help');
  timing.chatMs = performance.now() - startedAt;
  await new Promise((done) => setTimeout(done, 250));
  const snapshot = await api.getSnapshot();
  const titlebar = document.querySelector('header.topbar[aria-label="Workspace tabs"]');
  const titlebarBounds = titlebar?.getBoundingClientRect();
  // Windows uses titleBarStyle:hidden with a controls overlay; the topbar is
  // expected to span the titlebar area, which excludes the native buttons.
  const overlay = navigator.windowControlsOverlay;
  const overlayRect = overlay?.visible ? overlay.getTitlebarAreaRect() : null;
  const interactiveRects = Array.from(titlebar?.querySelectorAll('button, nav') || [])
    .filter((element) => element.getClientRects().length)
    .map((element) => element.getBoundingClientRect());
  const interactiveRight = interactiveRects.reduce((right, rect) => Math.max(right, rect.right), 0);
  const captionBounds = titlebar?.querySelector('.titlebar-caption-space')?.getBoundingClientRect() || null;
  const overlayRight = overlayRect ? overlayRect.x + overlayRect.width : window.innerWidth;
  const titlebarPaddingRight = titlebar ? Number.parseFloat(getComputedStyle(titlebar).paddingRight) || 0 : 0;
  const captionReservedRight = captionBounds ? captionBounds.right + titlebarPaddingRight : 0;
  const interactiveContentSafe = !overlay?.visible || (
    interactiveRight <= overlayRight &&
    captionBounds && captionBounds.left <= overlayRight + 1 &&
    captionReservedRight >= window.innerWidth - 1
  );
  startedAt = performance.now();
  const approvalRoutingResult = await api.resolveToolApproval(
    '__packaging_smoke__',
    { approved: false, reason: 'acceptance-smoke' },
  );
  timing.approvalRoutingMs = performance.now() - startedAt;
  await api.dispose();
  return {
    bridge: true,
    projectStarted: started !== null,
    chatSubmitted: submitted,
    snapshotAvailable: snapshot !== null,
    approvalRoutingResult,
    chrome: {
      windowTitle: document.title === 'Mixdog',
      titlebar: Boolean(
        titlebarBounds
        && Math.round(titlebarBounds.top) === 0
        && Math.round(titlebarBounds.height) === 36
        && Math.round(titlebarBounds.width) === Math.round(window.innerWidth)
        && interactiveContentSafe
      ),
      titlebarGeometry: {
        bounds: titlebarBounds ? {
          x: titlebarBounds.x,
          y: titlebarBounds.y,
          width: titlebarBounds.width,
          height: titlebarBounds.height,
        } : null,
        overlayVisible: overlay?.visible === true,
        overlayRect: overlayRect ? {
          x: overlayRect.x,
          y: overlayRect.y,
          width: overlayRect.width,
          height: overlayRect.height,
        } : null,
        overlayRight,
        interactiveRight,
        interactiveContentSafe,
        titlebarPaddingRight,
        captionReservedRight,
        captionBounds: captionBounds ? {
          x: captionBounds.x,
          y: captionBounds.y,
          width: captionBounds.width,
          height: captionBounds.height,
        } : null,
        innerWidth: window.innerWidth,
      },
      sidebarToggle: Boolean(titlebar?.querySelector(
        'button[aria-controls="session-sidebar"]',
      )),
      newTask: Boolean(titlebar?.querySelector('button[aria-label="New task"]')),
    },
    timing,
  };
})()`;
const response = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP smoke timed out')), 60_000);
  socket.addEventListener('open', () => socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: rendererExpression,
      awaitPromise: true,
      returnByValue: true,
    },
  })));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.result?.exceptionDetails) {
      reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
    } else {
      resolve(message.result.result.value);
    }
  });
  socket.addEventListener('error', () => reject(new Error('CDP websocket failed')));
});

socket.close();
console.log(JSON.stringify(response));
