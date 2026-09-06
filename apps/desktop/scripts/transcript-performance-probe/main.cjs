const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const directory = process.argv[2];
app.setPath("userData", join(directory, "profile"));
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000, height: 740, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true },
  });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] },
    (_details, callback) => callback({ cancel: true }));
  const deadline = setTimeout(() => {
    writeFileSync(join(directory, "screen-report.json"), JSON.stringify({ failures: ["Probe exceeded 90 seconds"] }));
    app.exit(1);
  }, 90000);
  try {
    await win.loadFile(join(directory, "index.html"));
    await win.webContents.executeJavaScript("window.prepareProbe()");
    for (let i = 0; i < 30; i++) {
      await win.webContents.insertText("x");
      await win.webContents.executeJavaScript(`window.scrollProbe(${i + 1})`);
    }
    const report = await win.webContents.executeJavaScript("window.finishProbe()");
    writeFileSync(join(directory, "screen-report.json"), JSON.stringify(report, null, 2));
    clearTimeout(deadline);
    app.exit(report.failures.length ? 1 : 0);
  } catch (error) {
    writeFileSync(join(directory, "screen-report.json"), JSON.stringify({ failures: [String(error.stack || error)] }));
    clearTimeout(deadline);
    app.exit(1);
  }
});
