const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const output = process.argv[2];
mkdirSync(join(output, 'profile'), { recursive: true });
app.setPath('userData', join(output, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    width: 1396,
    height: 823,
    useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true },
  });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const reports = [];
  try {
    await win.loadFile(join(output, 'index.html'));
    for (const [theme, width, height, mobile] of [
      ['dark', 1396, 823, false],
      ['light', 1396, 823, false],
      ['dark', 390, 844, true],
      ['light', 390, 844, true],
    ]) {
      win.setContentSize(width, height);
      await evaluate(`window.localProviderProbe.render(${JSON.stringify(theme)}, ${mobile})`);
      const name = `${theme}-${width}`;
      const state = await evaluate(`(() => {
        const dialog = document.querySelector('[data-feature-id="localProvider"]');
        const body = dialog.querySelector('.extensions-dialog-body');
        const rect = dialog.getBoundingClientRect();
        const actions = (row) => [...(row?.querySelectorAll('.extensions-action') || [])].map(el => {
          const r = el.getBoundingClientRect(), css = getComputedStyle(el);
          return { label:el.getAttribute('aria-label'), disabled:el.disabled, x:r.x, y:r.y, width:r.width, height:r.height,
            background:css.backgroundColor, radius:css.borderRadius };
        });
        const row = (name) => dialog.querySelector('[data-extension-item="' + name + '"]');
        const shell = dialog.querySelector('.local-provider-table-shell');
        return { text: dialog.textContent, nativeSelects: dialog.querySelectorAll('select').length,
          bodyPadding: parseFloat(getComputedStyle(body).paddingLeft),
          overflow: body.scrollWidth > body.clientWidth + 1,
          tableOverflow: shell ? shell.scrollWidth > shell.clientWidth + 1 : true,
          headerWeight: Number(getComputedStyle(dialog.querySelector('.local-provider-table th')).fontWeight),
          rows: [...dialog.querySelectorAll('.local-provider-table tbody tr')].map((tr) => tr.dataset.extensionItem),
          bounds: { x:rect.x, y:rect.y, right:rect.right, bottom:rect.bottom },
          buttons: actions(row('Qwen3.8 27B Q4_K_M')),
          installing: actions(row('Gemma 4 12B Q4_K_M')),
          failed: actions(row('Llama 4 8B Q5_K_M')),
          progress: row('Gemma 4 12B Q4_K_M')?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? null };
      })()`);
      const failures = [];
      if (state.overflow) failures.push('horizontal overflow');
      if (state.bodyPadding < 12) failures.push('production detail styles are missing');
      if (
        state.bounds.x < 0 ||
        state.bounds.right > width + 1 ||
        state.bounds.y < 0 ||
        state.bounds.bottom > height + 1
      )
        failures.push('dialog outside viewport');
      if (/PC 사양 확인 중|Checking hardware/.test(state.text)) failures.push('hardware polling message exposed');
      if (state.nativeSelects) failures.push('native selector exposed');
      // One table: installed, installing and failed models share it, in the
      // usage table's style (emphasized header band), without overflowing.
      if (state.rows.join('|') !== 'Gemma 4 12B Q4_K_M|Llama 4 8B Q5_K_M|Qwen3.8 27B Q4_K_M')
        failures.push(`unexpected table rows: ${state.rows.join('|')}`);
      if (state.tableOverflow) failures.push('model table overflows its card');
      if (!(state.headerWeight >= 600)) failures.push('table header is not emphasized');
      // Icon actions: the idle loaded model stays deletable.
      if (state.buttons.map((b) => b.label).join('|') !== '삭제' || state.buttons[0]?.disabled !== false)
        failures.push('idle loaded model not deletable');
      if (state.installing.map((b) => b.label).join('|') !== '다운로드 중지' || state.progress !== '42')
        failures.push('installing row lacks stop or progress');
      if (
        state.failed.map((b) => b.label).join('|') !== '다시 시도|정리' ||
        new Set(state.failed.map((b) => Math.round(b.y))).size !== 1
      )
        failures.push('failed installation lacks retry and discard on one row');
      win.webContents.invalidate();
      await evaluate('window.localProviderProbe.settle()');
      writeFileSync(join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
      await evaluate(`(() => {
        const trigger = document.querySelector('[data-feature-id="localProvider"] [role="combobox"][aria-label="유휴 시 자동 언로드"]');
        trigger.scrollIntoView({ block:'center' }); trigger.click();
      })()`);
      await evaluate('window.localProviderProbe.settle()');
      const menu = await evaluate(`(() => {
        const el = document.querySelector('[role="listbox"]'); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom,text:el.textContent };
      })()`);
      if (!menu || menu.x < 0 || menu.right > width + 1 || menu.y < 0 || menu.bottom > height + 1)
        failures.push('select menu missing or clipped');
      if (menu && !menu.text.includes('1시간 후')) failures.push('human-readable idle duration missing');
      win.webContents.invalidate();
      await evaluate('window.localProviderProbe.settle()');
      writeFileSync(join(output, `${name}-menu.png`), (await win.webContents.capturePage()).toPNG());
      // Both confirmations, captured once per theme at desktop width.
      const confirmations = {};
      if (!mobile) {
        for (const [label, file] of [
          ['정리', 'discard'],
          ['삭제', 'delete'],
        ]) {
          await evaluate(`(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            [...document.querySelectorAll('[data-feature-id="localProvider"] .extensions-action')]
              .find((el) => el.getAttribute('aria-label') === ${JSON.stringify(label)}).click();
          })()`);
          await evaluate('window.localProviderProbe.settle()');
          confirmations[file] = await evaluate(
            `document.querySelector('[role="alertdialog"]')?.textContent || null`
          );
          if (!confirmations[file]) failures.push(`${file} confirmation missing`);
          win.webContents.invalidate();
          await evaluate('window.localProviderProbe.settle()');
          writeFileSync(join(output, `${name}-${file}.png`), (await win.webContents.capturePage()).toPNG());
          await evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find((el) => !el.classList.contains('danger'))?.click()`);
          await evaluate('window.localProviderProbe.settle()');
        }
        if (!/먼저 내린 뒤/.test(confirmations.delete || '')) failures.push('delete confirmation omits unload notice');
      }
      reports.push({ name, failures, state, menu, confirmations });
    }
    writeFileSync(join(output, 'report.json'), JSON.stringify(reports, null, 2));
    const failed = reports.filter((report) => report.failures.length);
    console.log(
      JSON.stringify({
        output,
        scenarios: reports.length,
        failed: failed.map(({ name, failures }) => ({ name, failures })),
      })
    );
    app.exit(failed.length ? 1 : 0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
