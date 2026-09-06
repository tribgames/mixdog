const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const output = process.argv[2];
const requestedViews = process.argv.find(arg => arg.startsWith("--views="))?.slice(8).split(",");
mkdirSync(join(output, "profile"), { recursive: true });
app.setPath("userData", join(output, "profile"));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, frame: false, width: 1113, height: 687, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true },
  });
  const reports = [];
  const evaluate = code => win.webContents.executeJavaScript(code);
  const delay = () => new Promise(resolve => setTimeout(resolve, 180));
  const check = (condition, label, failures) => { if (!condition) failures.push(label); };
  try {
    await win.loadFile(join(output, "index.html"));
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    for (const [theme, width, height, mobile] of [
      ["dark", 1113, 687, false], ["light", 1113, 687, false],
      ["dark", 900, 420, false], ["light", 390, 600, true],
    ]) {
      win.setContentSize(width, height);
      for (const view of ["resources", "sessions", "dialog", "select"]) {
        if (requestedViews && !requestedViews.includes(view)) continue;
        const failures = [];
        const name = `${theme}-${width}x${height}-${view}`;
        await evaluate(`window.polishProbe.render(${JSON.stringify(view)}, ${JSON.stringify(theme)}, ${mobile})`);
        await delay();
        if (view === "resources") {
          await evaluate(`document.querySelector(".projects-row:last-child .row-overflow-trigger").click()`);
          await delay();
        }
        const measured = await evaluate(`(() => {
          const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; };
          const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
          const menu = document.querySelector(".row-overflow-menu, .mx-menu");
          const dialog = document.querySelector(".mx-dialog");
          const rows = [...document.querySelectorAll(".projects-row")].filter(visible);
          const sessions = [...document.querySelectorAll(".session-row")].filter(visible);
          const body = document.querySelector(".mx-dialog-body");
          return {
            pageWidth: document.documentElement.scrollWidth,
            menu: menu && rect(menu),
            menuExposed: menu && menu.contains(document.elementFromPoint(
              menu.getBoundingClientRect().x + menu.clientWidth / 2,
              menu.getBoundingClientRect().y + Math.min(24, menu.clientHeight / 2),
            )),
            menuRows: menu && [...menu.querySelectorAll("button")].map(el => ({...rect(el),disabled:el.disabled})),
            anchor: menu && document.querySelector('.row-overflow-trigger[aria-expanded="true"]') && rect(document.querySelector('.row-overflow-trigger[aria-expanded="true"]')),
            rows: rows.map(rect),
            rowOverflow: rows.some(el => el.scrollWidth > el.clientWidth + 1),
            sessions: sessions.map(el => ({rect:rect(el), action:el.querySelector(".session-row-actions") && rect(el.querySelector(".session-row-actions"))})),
            dialog: dialog && rect(dialog),
            title: dialog && rect(dialog.querySelector("h2")),
            field: body && rect(body.querySelector("input")),
            footer: dialog && rect(dialog.querySelector("footer")),
            save: dialog && rect(dialog.querySelector("footer button:last-child")),
            body: body && { ...rect(body), scrollHeight:body.scrollHeight,clientHeight:body.clientHeight },
          };
        })()`);
        check(measured.pageWidth <= width + 1, "page horizontal overflow", failures);
        if (view === "resources" || view === "select") {
          const menu = measured.menu;
          check(Boolean(menu), "menu absent", failures);
          if (menu) {
            check(measured.menuExposed, "menu hidden behind another surface", failures);
            check(menu.x >= 0 && menu.right <= width + 1 && menu.y >= 0 && menu.bottom <= height + 1, "menu outside viewport", failures);
            check(measured.menuRows.every(row => row.height >= (mobile ? 44 : 32)), "menu target too small", failures);
          }
          if (view === "resources") {
            check(measured.rows.length === 4 && !measured.rowOverflow, "resource row missing or overflowing", failures);
            const target = measured.menuRows[0];
            await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseMoved", x: target.x + 15, y: target.y + target.height / 2,
            });
            await delay();
            const hover = await evaluate(`getComputedStyle(document.querySelector(".row-overflow-menu button")).backgroundColor`);
            await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
              type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40,
            });
            await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
              type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40,
            });
            await delay();
            const focused = await evaluate(`({ id:document.activeElement.dataset.actionId, ring:getComputedStyle(document.activeElement).boxShadow })`);
            measured.interaction = { ...focused, hover };
            check(focused.id === "rename" && focused.ring !== "none", "keyboard focus not distinguished", failures);
            // Touch surfaces are verified by tapping below, not by requiring
            // a desktop hover state from the mobile layout.
            if (!mobile) check(hover !== "rgba(0, 0, 0, 0)", "hover missing", failures);
          }
        }
        if (view === "sessions") {
          check(measured.sessions.length > 0, "session rows absent", failures);
          check(measured.sessions.every(({rect,action}) => !action || Math.abs((rect.y + rect.height / 2) - (action.y + action.height / 2)) <= 1), "session action not vertically centered", failures);
        }
        if (view === "dialog") {
          const { dialog, title, field, save, footer, body } = measured;
          check(Boolean(dialog && title && field && footer), "dialog content absent", failures);
          if (dialog) {
            check(dialog.x >= 0 && dialog.right <= width + 1 && dialog.y >= 0 && dialog.bottom <= height + 1, "dialog outside viewport", failures);
            check(Math.abs(title.x - field.x) <= 1, "title and field axis differ", failures);
            check(Math.abs(field.right - save.right) <= 1, "field and footer axis differ", failures);
            check(footer.bottom <= dialog.bottom + 1 && footer.y >= body.bottom - 1, "footer overlaps body", failures);
            check(body.scrollHeight > body.clientHeight, "long dialog body must scroll", failures);
          }
        }
        win.webContents.invalidate();
        await delay();
        writeFileSync(join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
        if (mobile && view === "resources") {
          const target = measured.menuRows[1];
          await win.webContents.debugger.sendCommand("Input.dispatchTouchEvent", {
            type: "touchStart", touchPoints: [{ x: target.x + 20, y: target.y + target.height / 2 }],
          });
          await win.webContents.debugger.sendCommand("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await delay();
          check(await evaluate(`!document.querySelector(".row-overflow-menu")`), "touch selection did not close menu", failures);
        }
        reports.push({ name, failures, measured });
      }
    }
    writeFileSync(join(output, "report.json"), JSON.stringify(reports, null, 2));
    const failed = reports.filter(report => report.failures.length);
    console.log(JSON.stringify({ output, scenarios: reports.length, failed: failed.map(({name,failures}) => ({name,failures})) }, null, 2));
    app.exit(failed.length ? 1 : 0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
