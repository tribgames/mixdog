// The office HTML layout routes (pptx, pdf, docx, xlsx) lay a document out in a headless browser.
// In the extension host that browser is the core's single shared one: the call asks the core for
// its DevTools endpoint, connects, works in its own browser context and disconnects. Closing the
// context ends this call's pages only; the browser outlives every call.

/** `connect(ws)` resolves a puppeteer `Browser`; injected so the host never owns a launch path. */
export function sharedBrowserProvider({ requestBrowser, connect }) {
  return async () => {
    const browser = await connect(await requestBrowser());
    let context;
    try {
      context = await browser.createBrowserContext();
    } catch (error) {
      await browser.disconnect();
      throw error;
    }
    return {
      newPage: () => context.newPage(),
      close: async () => {
        await context.close().catch(() => {});
        await browser.disconnect();
      },
    };
  };
}
