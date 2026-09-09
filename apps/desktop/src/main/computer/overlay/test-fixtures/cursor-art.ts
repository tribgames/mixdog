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
    const feedback = await window.webContents.executeJavaScript(`(() => {
      const sample = (effect, time) => {
        window.mixdogAgentCursor({ effect });
        for (const animation of document.getAnimations()) {
          animation.pause();
          animation.currentTime = time;
        }
        return ['halo', 'ring', 'echo'].map(id => {
          const element = document.getElementById(id);
          const box = element.getBoundingClientRect();
          return { opacity: Number(getComputedStyle(element).opacity), width: box.width,
            left: box.left, top: box.top, right: box.right, bottom: box.bottom };
        });
      };
      return { early: sample('click', 80), late: sample('click', 200),
        ended: sample('click', 650), second: sample('double_click', 380) };
    })()`);
    assert.ok(feedback.early[0].opacity > 0, 'click has a visible pressed halo');
    assert.ok(feedback.late[1].width > feedback.early[1].width, 'click ripple expands');
    assert.ok(feedback.late[1].opacity > 0 && feedback.late[2].opacity > 0,
      'click displays two overlapping ripples');
    assert.ok(feedback.late[1].width > feedback.late[2].width, 'second ripple follows the first');
    assert.ok(feedback.ended.every((layer: { opacity: number }) => layer.opacity === 0),
      'completed click leaves no lingering feedback');
    assert.ok(feedback.second[1].opacity > 0, 'double click shows a second pulse');
    for (const layer of [...feedback.early, ...feedback.late, ...feedback.ended]) {
      assert.ok(layer.left >= 0 && layer.top >= 0 && layer.right <= CURSOR_SIZE && layer.bottom <= CURSOR_SIZE,
        'feedback remains inside the overlay');
    }
    // Inspect actual renderer pixels, not just CSS declarations.
    for (const effect of ['move', 'prepare', 'press', 'click', 'double_click', 'drag', 'scroll', 'type']) {
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
