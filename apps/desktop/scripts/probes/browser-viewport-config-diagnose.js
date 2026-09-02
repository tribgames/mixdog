(async () => {
  const view = document.querySelector('webview');
  if (!view) throw new Error('Visible Browser webview is unavailable.');
  const webContentsId = view.getWebContentsId();
  const sessionEntry = Object.entries(localStorage)
    .find(([key]) => key.startsWith('mixdog.browser-viewport.v1:'));
  const sessionId = sessionEntry?.[0].slice('mixdog.browser-viewport.v1:'.length);
  if (!sessionId) throw new Error('Browser session id is unavailable.');
  const configure = window.mixdogDesktop?.browserConfigureGuestViewport;
  if (typeof configure !== 'function') {
    throw new Error('browserConfigureGuestViewport preload API is unavailable.');
  }
  try {
    await configure(sessionId, webContentsId, {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
      touch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
        + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 '
        + 'Mobile/15E148 Safari/604.1',
    });
    view.reload();
    return { ok: true, sessionId, webContentsId };
  } catch (error) {
    return {
      ok: false,
      sessionId,
      webContentsId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
})()
