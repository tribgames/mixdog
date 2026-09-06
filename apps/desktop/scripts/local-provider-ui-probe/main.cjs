const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const output = process.argv[2];
mkdirSync(join(output, 'profile'), { recursive: true });
app.setPath('userData', join(output, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, frame: false, width: 1396, height: 823, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const reports = [];
  try {
    await win.loadFile(join(output, 'index.html'));
    for (const [theme, width, height, mobile] of [
      ['dark', 1396, 823, false], ['light', 1396, 823, false],
      ['dark', 390, 844, true], ['light', 390, 844, true],
    ]) {
      win.setContentSize(width, height);
      await evaluate(`window.localProviderProbe.render(${JSON.stringify(theme)}, ${mobile})`);
      const name = `${theme}-${width}`;
      const state = await evaluate(`(() => {
        const dialog = document.querySelector('[data-feature-id="localProvider"]');
        const body = dialog.querySelector('.extensions-dialog-body');
        const rect = dialog.getBoundingClientRect();
        const buttons = [...dialog.querySelectorAll('.local-provider-actions button')].map(el => {
          const r = el.getBoundingClientRect(), css = getComputedStyle(el);
          return { x:r.x, y:r.y, width:r.width, height:r.height, background:css.backgroundColor, radius:css.borderRadius };
        });
        return { text: dialog.textContent, nativeSelects: dialog.querySelectorAll('select').length,
          bodyPadding: parseFloat(getComputedStyle(body).paddingLeft),
          overflow: body.scrollWidth > body.clientWidth + 1,
          bounds: { x:rect.x, y:rect.y, right:rect.right, bottom:rect.bottom }, buttons };
      })()`);
      const failures = [];
      if (state.overflow) failures.push('horizontal overflow');
      if (state.bodyPadding < 12) failures.push('production detail styles are missing');
      if (state.bounds.x < 0 || state.bounds.right > width + 1 || state.bounds.y < 0 || state.bounds.bottom > height + 1) failures.push('dialog outside viewport');
      if (/PC 사양 확인 중|Checking hardware/.test(state.text)) failures.push('hardware polling message exposed');
      if (state.nativeSelects) failures.push('native selector exposed');
      if (state.buttons.length !== 3 || new Set(state.buttons.map(b => Math.round(b.y))).size !== 1) failures.push('actions are not on one compact row');
      win.webContents.invalidate();
      await evaluate('window.localProviderProbe.settle()');
      writeFileSync(join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
      await evaluate(`(() => {
        const trigger = document.querySelector('[data-feature-id="localProvider"] [role="combobox"]');
        trigger.scrollIntoView({ block:'center' }); trigger.click();
      })()`);
      await evaluate('window.localProviderProbe.settle()');
      const menu = await evaluate(`(() => {
        const el = document.querySelector('[role="listbox"]'); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom,text:el.textContent };
      })()`);
      if (!menu || menu.x < 0 || menu.right > width + 1 || menu.y < 0 || menu.bottom > height + 1) failures.push('select menu missing or clipped');
      if (menu && !menu.text.includes('1시간 후')) failures.push('human-readable idle duration missing');
      win.webContents.invalidate();
      await evaluate('window.localProviderProbe.settle()');
      writeFileSync(join(output, `${name}-menu.png`), (await win.webContents.capturePage()).toPNG());
      reports.push({ name, failures, state, menu });
    }
    writeFileSync(join(output, 'report.json'), JSON.stringify(reports, null, 2));
    const failed = reports.filter((report) => report.failures.length);
    console.log(JSON.stringify({ output, scenarios: reports.length, failed: failed.map(({ name, failures }) => ({ name, failures })) }));
    app.exit(failed.length ? 1 : 0);
  } catch (error) { console.error(error); app.exit(1); }
});
