const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const directory = process.argv[2];
app.setPath("userData", join(directory, "profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000, height: 720, show: false, useContentSize: true,
    webPreferences: { backgroundThrottling: false, offscreen: true },
  });
  win.webContents.on("console-message", (event) => {
    if (event.level >= 2) process.stderr.write(`${event.message}\n`);
  });
  try {
    await win.loadFile(join(directory, "index.html"));
    const deadline = setTimeout(() => {
      writeFileSync(join(directory, "report.json"), JSON.stringify({
        failures: ["Composer layout probe did not finish within 60 seconds"],
      }));
      app.exit(1);
    }, 60_000);
    const report = await win.webContents.executeJavaScript(
      `typeof window.runComposerLayoutProbe !== "function" ? { failures: window.probeErrors } :
      window.runComposerLayoutProbe(${JSON.stringify(process.argv[3])}).catch(error => ({
        failures: [String(error.stack || error)]
      }))`,
    );
    clearTimeout(deadline);
    writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
    app.exit(report.failures.length ? 1 : 0);
  } catch (error) {
    writeFileSync(join(directory, "report.json"), JSON.stringify({ error: String(error.stack || error) }));
    app.exit(1);
  }
});
