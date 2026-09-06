const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const output = process.argv[2];
const requestedViews = process.argv.find(arg => arg.startsWith("--views="))?.slice(8).split(",");
mkdirSync(join(output, "profile"), { recursive: true });
app.setPath("userData", join(output, "profile"));
app.disableHardwareAcceleration();
const views = [
  "plugins", "skills", "comparison", "git-plain", "git-custom", "browser", "computer",
  "memory", "office", "voice", "localProvider", "plugin", "skill", "mcp-stdio", "mcp-http",
  "create-skill", "install-plugin", "schedule", "webhook", "workflow", "project",
].filter(view => !requestedViews || requestedViews.includes(view));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, frame: false, width: 1396, height: 823, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true },
  });
  const evaluate = code => win.webContents.executeJavaScript(code);
  const reports = [];
  const runtimeErrors = [];
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) runtimeErrors.push(message); });
  try {
    await win.loadFile(join(output, "index.html"));
    for (const [theme, width, height, language, mobile] of [
      ["dark", 1396, 823, "ko", false], ["light", 1113, 687, "ko", false],
      ["dark", 900, 420, "ko", false], ["light", 390, 600, "ko", true],
      ["dark", 1396, 823, "en", false], ["dark", 390, 600, "en", true],
    ]) {
      win.setContentSize(width, height);
      for (const view of views) {
        if (view === "comparison" && width < 1000) continue;
        const name = `${language}-${theme}-${width}x${height}-${view}`;
        const failures = [];
        const check = (ok, text) => { if (!ok) failures.push(text); };
        const errorStart = runtimeErrors.length;
        await evaluate(`window.extensionsProbe.render(${JSON.stringify(view)}, ${JSON.stringify(theme)}, ${JSON.stringify(language)}, ${mobile}, ${view === "comparison" ? 220 : 260})`);
        const measured = await evaluate(`(() => {
          const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; };
          const dialog = document.querySelector(".schedules-dialog");
          const body = dialog && (dialog.querySelector(":scope > form") || dialog.querySelector(".extensions-dialog-body"));
          const footer = dialog && dialog.querySelector("footer");
          const rows = [...document.querySelectorAll("[data-probe-panel] .schedules-row")];
          const row = el => {
            const title = el.querySelector(".schedules-row-copy b");
            return { ...rect(el), overflow:el.scrollWidth > el.clientWidth + 1,
              padding:getComputedStyle(el).padding, title:title && { ...rect(title),
                size:getComputedStyle(title).fontSize, weight:getComputedStyle(title).fontWeight } };
          };
          const controls = dialog && [...dialog.querySelectorAll("input:not([type=checkbox]), textarea, .mx-select-root")];
          const labels = dialog && [...dialog.querySelectorAll(".mixdog-settings__row-title")];
          const searches = [...document.querySelectorAll(".schedules-search, .workbench-search-input")];
          return {
            pageWidth:document.documentElement.scrollWidth,
            rows:rows.map(row), panelRows:[...document.querySelectorAll("[data-probe-panel]")].map(panel => {
              const first=panel.querySelector(".schedules-row"); return first && { ...row(first), panel:rect(panel) };
            }).filter(Boolean),
            descriptions:[...document.querySelectorAll(".extensions-row small")].map(el => ({
              height:el.getBoundingClientRect().height, lineHeight:parseFloat(getComputedStyle(el).lineHeight),
              length:el.textContent.length
            })),
            searches:searches.map(el => ({ ...rect(el), background:getComputedStyle(el).backgroundColor,
              border:getComputedStyle(el).border, radius:getComputedStyle(el).borderRadius })),
            dialog:dialog && rect(dialog), header:dialog && rect(dialog.querySelector(":scope > header")),
            body:body && { ...rect(body), scrollHeight:body.scrollHeight, clientHeight:body.clientHeight },
            footer:footer && rect(footer),
            controls:controls && controls.filter(el => el.getClientRects().length).map(rect),
            labels:labels && labels.map(el => ({...rect(el), text:el.textContent})),
            inlineForms:dialog && [...dialog.querySelectorAll(".settings-form-row")].map(el => ({
              padding:getComputedStyle(el).padding, overflow:getComputedStyle(el).overflowY
            })),
          };
        })()`);
        check(measured.pageWidth <= width + 1, "page overflows horizontally");
        check(measured.rows.length > 0, "rail rows are absent");
        check(measured.rows.every(row => !row.overflow), "rail row overflows");
        check(measured.panelRows.every(row => row.x >= row.panel.x && row.right <= row.panel.right + 1), "panel clips a resource row");
        const longDescriptions = measured.descriptions.filter(description => description.length > 60);
        if (view === "skills" || view === "comparison") check(longDescriptions.length > 0, "long-description fixture is absent");
        check(longDescriptions.every(description =>
          description.height > description.lineHeight + 1 && description.height <= description.lineHeight * 2 + 1),
          "long extension descriptions do not use two readable lines");
        const expectsDialog = !["plugins", "skills", "comparison"].includes(view);
        check(Boolean(measured.dialog) === expectsDialog, "unexpected dialog visibility");
        if (measured.dialog) {
          const d = measured.dialog;
          check(d.x >= 0 && d.right <= width + 1 && d.y >= 0 && d.bottom <= height + 1, "dialog escapes viewport");
          check(measured.header.height > 0 && measured.header.bottom <= d.bottom, "header is clipped");
          check(measured.controls.every(c => c.x >= d.x && c.right <= d.right + 1), "field escapes dialog horizontally");
          check(measured.labels.every(label => label.width >= Math.min(110, label.text.length * 12)), "setting label is squeezed");
          check(measured.inlineForms.every(form => form.padding === "0px" && form.overflow !== "auto"), "inline form inherits outer editor scrolling");
          if (measured.footer) {
            check(measured.footer.y >= measured.header.bottom && measured.footer.bottom <= d.bottom + 1, "footer is not visible");
            const after = await evaluate(`(() => {
              const dialog=document.querySelector(".schedules-dialog");
              const body=dialog.querySelector(":scope > form") || dialog.querySelector(".extensions-dialog-body");
              body.scrollTop=body.scrollHeight;
              const footer=dialog.querySelector("footer").getBoundingClientRect();
              return { y:footer.y,bottom:footer.bottom };
            })()`);
            check(after.y >= measured.header.bottom && after.bottom <= d.bottom + 1, "footer leaves dialog while scrolling");
          }
          await evaluate(`(() => {
            const dialog=document.querySelector(".schedules-dialog");
            const body=dialog.querySelector(":scope > form") || dialog.querySelector(".extensions-dialog-body");
            if (body) body.scrollTop=0;
          })()`);
        }
        if (view === "comparison") {
          check(new Set(measured.panelRows.map(row => row.padding)).size === 1, "resource row padding differs between panels");
          check(new Set(measured.panelRows.map(row => row.title.size)).size === 1, "resource title sizes differ");
          check(new Set(measured.panelRows.map(row => row.title.weight)).size === 1, "resource title weights differ");
          check(new Set(measured.searches.map(({height,background,border,radius}) => JSON.stringify({height,background,border,radius}))).size === 1, "search field skins differ between panels");
          const resized = await evaluate(`(() => {
            const panel=document.querySelector("[data-probe-panel]");
            const original=panel.style.cssText;
            const results=[320,232].map(width => {
              panel.style.width=width+"px"; panel.style.flexBasis=width+"px";
              panel.style.setProperty("--workbench-side-panel-width",width+"px");
              const bounds=panel.getBoundingClientRect();
              return [...panel.querySelectorAll(".schedules-row, .session-panel-header")].every(el => {
                const box=el.getBoundingClientRect(); return box.x>=bounds.x && box.right<=bounds.right+1;
              });
            });
            panel.style.cssText=original;
            return results.every(Boolean);
          })()`);
          check(resized, "resizing a mounted panel clips its header or rows");
        }
        check(runtimeErrors.length === errorStart, `renderer errors: ${runtimeErrors.slice(errorStart).join("; ")}`);
        if (language === "ko" || failures.length) {
          await evaluate("window.extensionsProbe.settle()");
          writeFileSync(join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
        }
        // Dismissal is exercised against the actual portal, not a fixture handler.
        if (expectsDialog) {
          const dismissed = await evaluate(`(() => {
            const close=document.querySelector(".schedules-dialog > header .schedules-dialog-header-actions > button");
            if (!close) return false;
            close.click(); return true;
          })()`);
          await evaluate("window.extensionsProbe.settle()");
          check(dismissed && await evaluate('!document.querySelector(".schedules-dialog")'), "close does not dismiss the dialog");
        }
        reports.push({ name, failures, measured });
      }
    }
    writeFileSync(join(output, "report.json"), JSON.stringify(reports, null, 2));
    const failed = reports.filter(report => report.failures.length);
    console.log(JSON.stringify({ output, scenarios:reports.length, failed:failed.map(({name,failures}) => ({name,failures})) }, null, 2));
    app.exit(failed.length ? 1 : 0);
  } catch (error) {
    writeFileSync(join(output, "report.json"), JSON.stringify({ reports, runtimeErrors, error:String(error.stack || error) }, null, 2));
    console.error(error);
    console.log(`Artifacts: ${output}`);
    app.exit(1);
  }
});
