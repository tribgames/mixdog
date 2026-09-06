import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { overlayHtml, overlayScript, OVERLAY_WIDTH, OVERLAY_HEIGHT } from '../content';
import { computerUseOverlayPresentation } from '../model';
import { createComputerOverlayController } from '../controls';
import { bindComputerOverlayControls } from '../ipc-controls';
import { checkOverlayOutline, emulateMotionPreference } from './outline-check';

app.disableHardwareAcceleration();
app.setPath('userData', join(process.env.OVERLAY_TEST_DIRECTORY!, 'profile'));
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT, show: false, focusable: false, transparent: true, frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: join(process.env.OVERLAY_TEST_DIRECTORY!, 'preload.cjs') },
  });
  // A renderer failure otherwise surfaces only as the generic "script failed to execute".
  window.webContents.on('console-message', (event) => {
    process.stderr.write(`renderer console [${event.level}] ${event.message}\n`);
  });
  try {
    // Windows Server (the CI runner) turns system animations off, which Chromium reads as reduced
    // motion. The checks read the stylesheet's own motion states, so pin the media feature.
    window.webContents.debugger.attach('1.3');
    let resumed = 0, paused = 0, stopped = 0, seconds = 5;
    const controls = {
      async resume(generation: number) {
        if (generation !== 7) throw new Error('computer_resume_stale');
        resumed++;
      },
      async stop() { stopped++; },
      async pause() { paused++; },
      configureIdleResume(value: number) { seconds = value; },
    };
    const controller = createComputerOverlayController(controls, () => {});
    bindComputerOverlayControls(window.webContents, controller, controls,
      () => ({ sessionIds: ['fixture'], generation: 7 }));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    await window.loadURL(`data:text/html;base64,${Buffer.from(overlayHtml('ko')).toString('base64')}`);
    await emulateMotionPreference(window.webContents, 'no-preference');
    await window.webContents.executeJavaScript(overlayScript('ko'));
    const click = async (isPaused: boolean, revision: number, id = 'toggle') => window.webContents.executeJavaScript(`
      window.mixdogComputerOverlay({paused:${isPaused},canResume:true,generation:7,renderRevision:${revision}});
      new Promise((resolve,reject) => {
        const timeout=setTimeout(()=>reject(new Error('resume acknowledgement missing')),3000);
        const button=document.getElementById('toggle');
        const observer=new MutationObserver(()=>{
          if(button.getAttribute('aria-busy')==='false'){
            clearTimeout(timeout);observer.disconnect();resolve(true);
          }
        });
        observer.observe(button,{attributes:true,attributeFilter:['aria-busy']});
        document.getElementById(${JSON.stringify(id)}).click();
      });
    `);
    await click(true, 1);
    assert.equal(resumed, 1);
    await click(false, 2);
    assert.equal(paused, 1);
    await checkOverlayOutline(window.webContents);
    const layout = [];
    let revision = 3;
    for (const locale of ['ko', 'en']) {
      await window.loadURL(`data:text/html;base64,${Buffer.from(overlayHtml(locale)).toString('base64')}`);
      await emulateMotionPreference(window.webContents, 'no-preference');
      await window.webContents.executeJavaScript(overlayScript(locale));
      for (const reason of ['', 'user_input_active', 'user_pause', 'input_cleanup_unconfirmed']) {
        const presentation = computerUseOverlayPresentation({
          revision: 0, userControlActive: Boolean(reason), takeoverReason: reason,
          takeoverGeneration: 7, cleanupState: reason === 'input_cleanup_unconfirmed' ? 'failed' : 'ready',
          pausedSessionIds: ['fixture'], activities: [], cursors: [], targetLeases: [],
        }, locale);
        const observed = await window.webContents.executeJavaScript(`
          window.mixdogComputerOverlay(${JSON.stringify({ ...presentation, renderRevision: revision++ })});
          ({
            title:document.getElementById('title').textContent,
            text:document.body.innerText.trim(),
            moving:document.getElementById('outline').getAnimations({subtree:true})
              .some(animation=>animation.playState==='running'),
            fits:[...document.querySelectorAll('#pill,#status,#title,button')].every(element=>{
              const rect=element.getBoundingClientRect();
              return element.scrollWidth<=element.clientWidth && element.scrollHeight<=element.clientHeight
                && rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight;
            })
          })
        `);
        assert.equal(observed.title, locale === 'ko' ? 'Mixdog 사용 중' : 'Mixdog using');
        assert.equal(observed.text, observed.title);
        assert.equal(observed.moving, !presentation.paused);
        assert.equal(observed.fits, true, `${locale}/${reason} overflows`);
        layout.push({ locale, reason, ...observed });
      }
    }
    const stale = await window.webContents.executeJavaScript(`window.mixdogComputerControl({action:'resume',generation:6})`);
    assert.equal(stale.error, 'stale');
    await window.webContents.executeJavaScript(`window.mixdogComputerControl({action:'configure',seconds:10})`);
    assert.equal(seconds, 10);
    assert.equal(await window.webContents.executeJavaScript(
      `window.mixdogComputerControl({action:'configure',seconds:-1}).then(()=>false,()=>true)`), true);
    await click(true, revision++, 'stop');
    assert.equal(stopped, 1);
    assert.equal(window.isVisible(), false);
    process.stdout.write(`OVERLAY_RESULT ${JSON.stringify({ resumed, paused, stopped, seconds, layout, visible: false })}\n`);
  } finally {
    window.destroy();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
