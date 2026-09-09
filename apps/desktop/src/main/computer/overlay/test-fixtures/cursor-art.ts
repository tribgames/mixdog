import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cursorHtml, cursorScript, CURSOR_HOTSPOT, CURSOR_SIZE } from '../cursor-art';

app.disableHardwareAcceleration();
app.setPath('userData', join(process.env.CURSOR_TEST_DIRECTORY!, 'profile'));
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: CURSOR_SIZE, height: CURSOR_SIZE, show: false, frame: false,
    focusable: false, skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    await window.loadURL(`data:text/html;base64,${Buffer.from(cursorHtml()).toString('base64')}`);
    await window.webContents.executeJavaScript(cursorScript());
    const result = await window.webContents.executeJavaScript(`(() => {
      window.mixdogAgentCursor({ effect: 'move' });
      const ring = document.querySelector('#ring');
      const box = ring.getBoundingClientRect();
      const movingAnimations = ring.getAnimations().length;
      const movingOpacity = Number(getComputedStyle(ring).opacity);
      window.mixdogAgentCursor({ effect: 'prepare' });
      const preparation = ring.getAnimations().map(a => a.animationName);
      window.mixdogAgentCursor({ effect: 'click' });
      const animations = ring.getAnimations();
      return { center: [box.x + box.width/2, box.y + box.height/2],
        text: document.body.innerText.trim(), movingAnimations, movingOpacity, preparation,
        clickAnimation: animations.map(a => a.animationName), duplicatePointer: Boolean(document.querySelector('#arrow')) };
    })()`);
    assert.ok(result.center.every((coordinate: number) => Math.abs(coordinate - CURSOR_HOTSPOT) < 0.01));
    assert.equal(result.text, '');
    assert.equal(result.movingAnimations, 0);
    assert.ok(result.movingOpacity > 0);
    assert.deepEqual(result.preparation, ['prepare']);
    assert.deepEqual(result.clickAnimation, ['press']);
    assert.equal(result.duplicatePointer, false);
    // Inspect actual renderer pixels, not just CSS declarations.
    for (const effect of ['move', 'prepare', 'click', 'scroll', 'type']) {
      await window.webContents.executeJavaScript(`(async () => {
        window.mixdogAgentCursor({ effect: ${JSON.stringify(effect)} });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        for (const animation of document.getAnimations()) {
          animation.pause();
          animation.currentTime = 80;
        }
      })()`);
      const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const pixels = image.toBitmap();
      let colored = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > pixels[index + 2] + 15 && pixels[index + 3] > 0) colored++;
      }
      assert.ok(colored > 15, `${effect} did not produce visible colored pixels`);
    }
    process.stdout.write(`CURSOR_ART_OK ${JSON.stringify(result)}\n`);
  } finally { window.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
