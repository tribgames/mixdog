// Run with Electron: npx electron apps/desktop/scripts/dock-resize-geometry.cjs
// Real layout/hit testing: jsdom cannot detect clipped or covered resize edges.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { backgroundThrottling: false },
    });
    try {
      const renderer = path.resolve(__dirname, '../src/renderer');
      const css = [
        'desktop/06-activity-rail.css',
        'desktop/08-mobile-tabs.css',
        'pane-layout.css',
        'session-browser-surfaces.css',
        'desktop/26-editor.css',
      ]
        .map((file) => fs.readFileSync(path.join(renderer, file), 'utf8'))
        .join('\n');
      await window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(`
      <style>${css}
      :root { --mx-border-structure: #444; --mx-focus: #08f; }
      body { margin: 0; }
      .pane-leaf { width: 1100px; height: 700px; }
      .pane-cell { height: 100%; }
      .pane-side-dock { width: 400px; }
      .pane-side-dock-main { height: 600px; }
      .workbench-side-panel { --workbench-side-panel-width: 400px;
        --workbench-side-panel-min-width: 320px;
        --workbench-side-panel-max-width: 1160px; }
      </style>
      <div class="pane-leaf"><div class="pane-cell">
        <div class="workspace-tabs-shell">Conversation</div>
        <div class="pane-surface-stack"><div class="pane-surface-handoff-layer"></div></div>
        <div class="pane-side-dock" data-open="true" data-overlay="false">
          <header class="pane-side-dock-header">Panel</header>
          <div class="pane-side-dock-main">
            <aside class="workbench-side-panel" data-side="right" data-embedded="true">
              <div class="workbench-side-panel-resize" role="separator"></div>
              <div class="workbench-side-panel-content"></div>
            </aside>
          </div>
        </div>
      </div></div>
      <div id="surface" data-parked="false"></div>
    `)
      );
      window.webContents.debugger.attach('1.3');
      for (const overlay of [false, true]) {
        for (const kind of ['browser', 'terminal', 'diff']) {
          const result = await window.webContents.executeJavaScript(`(() => {
          const dock = document.querySelector(".pane-side-dock");
          dock.dataset.overlay = ${JSON.stringify(String(overlay))};
          const column = document.querySelector("aside");
          const handle = column.firstElementChild;
          const diff = ${JSON.stringify(kind)} === "diff";
          column.className = diff ? "pane-dock-diff-column" : "workbench-side-panel";
          column.style.setProperty("--pane-dock-diff-width", "400px");
          handle.className = diff ? "pane-dock-diff-resize" : "workbench-side-panel-resize";
          const surface = document.querySelector("#surface");
          surface.className = diff ? "" : "session-" + ${JSON.stringify(kind)} + "-surface-container";
          const box = column.getBoundingClientRect();
          surface.style.cssText = diff ? "display:none" :
            "left:" + box.left + "px;top:" + box.top + "px;width:" + box.width + "px;height:" + box.height + "px";
          const rect = handle.getBoundingClientRect();
          const y = rect.top + rect.height / 2;
          return {
            hits: [1, 4, 7].map(dx => document.elementFromPoint(rect.left + dx, y) === handle),
            cursor: getComputedStyle(handle).cursor,
            indicator: getComputedStyle(handle, "::after").backgroundColor,
            x: rect.left + 4, y
          };
        })()`);
          assert.deepEqual(result.hits, [true, true, true], `${kind}, overlay=${overlay}: exposed drag target`);
          assert.equal(result.cursor, 'col-resize');
          assert.equal(result.indicator, 'rgb(68, 68, 68)');
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: result.x,
            y: result.y,
          });
          const hover = await window.webContents.executeJavaScript(`(() => {
          const handle = document.querySelector('[role="separator"]');
          const style = getComputedStyle(handle, "::after");
          return { color: style.backgroundColor, width: style.width };
        })()`);
          assert.deepEqual(hover, { color: 'rgb(0, 136, 255)', width: '3px' });
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: 10,
            y: 10,
          });
          console.log(`PASS ${kind}, overlay=${overlay}: hit target, resize cursor, hover indicator`);
        }
      }
    } finally {
      window.destroy();
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    }
  );
