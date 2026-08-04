/** Electron shell for the Source Control overlay geometry probe.
 *  Usage: npx electron scripts/scm-geometry-probe/main.cjs [--cases=300x687,290x420,290x420:many,290x687:rows]
 *  Prints one JSON report per dock width / window height on stdout.
 *  A case is `<dock width>x<window content height>[:many|:rows]`; the height
 *  resizes the REAL BrowserWindow (a short window, not a short div inside a
 *  tall one), `:many` swaps the branch fixture for one that overflows the list
 *  and `:rows` swaps the changed-file / history fixtures for 2000 files and a
 *  paged 120-commit history — the windowed lists' scenario. */
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");

const outFile = (process.argv.find((arg) => arg.startsWith("--out=")) || "").split("=")[1] || "";

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

const cases = (process.argv.find((arg) => arg.startsWith("--cases="))
  || "--cases=300x687,290x687,290x420,290x420:many,290x687:rows").split("=")[1].split(",").map((value) => {
  const [size, mode] = value.trim().split(":");
  const [width, height] = size.split("x").map(Number);
  return {
    width,
    height,
    branches: mode === "many" ? "many" : "few",
    rows: mode === "rows" ? "many" : "few",
  };
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1113,
    height: 687,
    useContentSize: true,
    frame: false,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: false, offscreen: false },
  });
  win.webContents.on("console-message", (_event, _level, message) => {
    process.stderr.write(`[page] ${message}\n`);
  });
  try {
    await win.loadFile(path.join(__dirname, "probe.html"));
    const report = [];
    for (const scenario of cases) {
      // The WINDOW is what shrinks: `#shell` used to be resized inside a
      // 687px viewport, so overlay containment was never measured against a
      // genuinely short window.
      win.setContentSize(1113, scenario.height);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const measured = await win.webContents.executeJavaScript(
        `window.__probe.run(${JSON.stringify([scenario])})`,
      );
      report.push(...measured);
    }
    const json = `${JSON.stringify(report, null, 2)}\n`;
    // stdout can be truncated by app.exit on Windows; a file is the stable lane.
    if (outFile) fs.writeFileSync(path.resolve(outFile), json);
    else process.stdout.write(json);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    app.exit(1);
  }
});
