import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { overlayHtml, overlayScript, OVERLAY_WIDTH, OVERLAY_HEIGHT } from '../content';
import { computerUseOverlayPresentation } from '../model';
import { createComputerOverlayController } from '../controls';
import { bindComputerOverlayControls } from '../ipc-controls';
import { checkOverlayOutline, emulateMotionPreference } from './outline-check';
import { nativeOverlayClick } from './native-click';

app.disableHardwareAcceleration();
app.setPath('userData', join(process.env.OVERLAY_TEST_DIRECTORY!, 'profile'));
/** Electron's stdio pipes are asynchronous: text written without waiting for its flush is
 * lost when the process exits, which reads in CI as a successful run with no result. */
const emit = (stream: NodeJS.WriteStream, text: string) =>
  new Promise<void>((resolve) => { stream.write(text, () => resolve()); });
// This fixture owns its only window; Electron's default quit-on-last-window-close would
// otherwise end the process the moment a failing step reaches the finally-block destroy.
app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT, show: false, focusable: false, transparent: true, frame: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: join(process.env.OVERLAY_TEST_DIRECTORY!, 'preload/computer-overlay.js') },
  });
  // A renderer failure otherwise surfaces only as the generic "script failed to execute".
  window.webContents.on('console-message', (event) => {
    process.stderr.write(`renderer console [${event.level}] ${event.message}\n`);
  });
  try {
    // Windows Server (the CI runner) turns system animations off, which Chromium reads as reduced
    // motion. The checks read the stylesheet's own motion states, so pin the media feature.
    window.webContents.debugger.attach('1.3');
    let resumed = 0, stopped = 0, seconds = 5;
    let stopReceived: (() => void) | undefined;
    const controls = {
      async resume(generation: number) {
        if (generation !== 7) throw new Error('computer_resume_stale');
        resumed++;
      },
      async stop() { stopped++; stopReceived?.(); },
      configureIdleResume(value: number) { seconds = value; },
    };
    const controller = createComputerOverlayController(controls, () => {});
    bindComputerOverlayControls(window.webContents, controller, controls,
      () => ({ sessionIds: ['fixture'], generation: 7, canDismiss: true }), () => window.hide());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    await window.loadURL(`data:text/html;base64,${Buffer.from(overlayHtml('ko')).toString('base64')}`);
    await emulateMotionPreference(window.webContents, 'no-preference');
    await window.webContents.executeJavaScript(overlayScript('ko'));
    const click = async (isPaused: boolean, revision: number, id = 'resume') => window.webContents.executeJavaScript(`
      window.mixdogComputerOverlay({paused:${isPaused},canResume:true,generation:7,renderRevision:${revision}});
      new Promise((resolve,reject) => {
        const timeout=setTimeout(()=>reject(new Error('control acknowledgement missing')),3000);
        const button=document.getElementById(${JSON.stringify(id)});
        const observer=new MutationObserver(()=>{
          if(button.getAttribute('aria-busy')==='false'){
            clearTimeout(timeout);observer.disconnect();resolve(true);
          }
        });
        observer.observe(button,{attributes:true,attributeFilter:['aria-busy']});
        button.click();
      });
    `);
    await click(true, 1);
    assert.equal(resumed, 1);
    // Running state: Resume is not on the surface at all.
    const running = await window.webContents.executeJavaScript(`
      window.mixdogComputerOverlay({paused:false,canResume:false,generation:7,renderRevision:2});
      ({ resumeHidden: document.getElementById('resume').hidden,
         buttons: [...document.querySelectorAll('button')].filter((b) => !b.hidden).length })`);
    assert.deepEqual(running, { resumeHidden: true, buttons: 1 });
    await checkOverlayOutline(window.webContents);
    // Unlike button.click(), native hit-testing exercises a non-activating
    // transparent window and mouse down/up while takeover changes its layout.
    const workArea = screen.getPrimaryDisplay().workArea;
    window.setPosition(workArea.x + 16, workArea.y + 110);
    window.showInactive();
    const point = await window.webContents.executeJavaScript(`
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const button = document.getElementById('stop');
        button.addEventListener('pointerdown', () => {
          window.mixdogComputerOverlay({
            paused:true,canResume:true,generation:7,renderRevision:3,
            title:'일시정지',canDismiss:true
          });
          button.getBoundingClientRect();
        }, {once:true});
        const rect=button.getBoundingClientRect();
        resolve({x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+4)});
      })))
    `);
    const [windowX, windowY] = window.getPosition();
    const handle = window.getNativeWindowHandle();
    let nativeDeadline: NodeJS.Timeout | undefined;
    const nativeAck = new Promise<void>((resolve, reject) => {
      stopReceived = resolve;
      nativeDeadline = setTimeout(() => reject(new Error('native Stop acknowledgement missing')),10_000);
    });
    try {
      const [clickMode] = await Promise.all([
        nativeOverlayClick(
          handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE()),
          screen.dipToScreenPoint({ x: windowX + point.x, y: windowY + point.y }),
        ),
        nativeAck,
      ]);
      await emit(process.stderr, `OVERLAY_CLICK_MODE ${clickMode}\n`);
    } finally {
      clearTimeout(nativeDeadline);
      stopReceived = undefined;
    }
    assert.equal(stopped, 1, 'native mouse click must survive the takeover layout change');
    assert.equal(window.isFocused(), false, 'the Stop control must not activate its window');
    window.hide();
    const layout = [];
    let revision = 4;
    for (const locale of ['ko', 'en']) {
      await window.loadURL(`data:text/html;base64,${Buffer.from(overlayHtml(locale)).toString('base64')}`);
      await emulateMotionPreference(window.webContents, 'no-preference');
      await window.webContents.executeJavaScript(overlayScript(locale));
      let stopBounds: unknown;
      for (const reason of ['', 'user_input_active', 'user_stop', 'input_cleanup_unconfirmed', 'turn_stop']) {
        const presentation = computerUseOverlayPresentation({
          revision: 0, userControlActive: Boolean(reason), takeoverReason: reason,
          takeoverGeneration: 7, cleanupState: reason === 'input_cleanup_unconfirmed' ? 'failed' : 'ready',
          pausedSessionIds: ['fixture'], activities: [], cursors: [], targetLeases: [],
        }, locale, { error: reason === 'turn_stop' ? 'stop' : '' });
        const observed = await window.webContents.executeJavaScript(`
          window.mixdogComputerOverlay(${JSON.stringify({ ...presentation, renderRevision: revision++ })});
          ({
            title:document.getElementById('title').textContent,
            pillWidth:document.getElementById('pill').getBoundingClientRect().width,
            stopBounds:(() => { const r=document.getElementById('stop').getBoundingClientRect();
              return {x:r.x,y:r.y,width:r.width,height:r.height}; })(),
            text:document.body.innerText.trim(),
            moving:document.getElementById('outline').getAnimations({subtree:true})
              .some(animation=>animation.playState==='running'),
            fits:[...document.querySelectorAll('#pill,#status,#title,button')].filter(element=>!element.hidden).every(element=>{
              const rect=element.getBoundingClientRect();
              return element.scrollWidth<=element.clientWidth && element.scrollHeight<=element.clientHeight
                && rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight;
            })
          })
        `);
        assert.equal(observed.title, presentation.title);
        assert.equal(observed.text, presentation.title);
        assert.equal(observed.moving, !presentation.paused);
        assert.equal(observed.fits, true, `${locale}/${reason} overflows`);
        assert.equal(observed.pillWidth, OVERLAY_WIDTH - 20,
          `${locale}/${reason} must keep the same compact width`);
        stopBounds ??= observed.stopBounds;
        assert.deepEqual(observed.stopBounds, stopBounds, `${locale}/${reason} moved the Stop hit target`);
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
    assert.equal(stopped, 2);
    window.showInactive();
    const dismissed = await window.webContents.executeJavaScript(
      `window.mixdogComputerControl({action:'dismiss',generation:7})`);
    assert.equal(dismissed.accepted, true);
    assert.equal(window.isVisible(), false);
    await emit(process.stdout,
      `OVERLAY_RESULT ${JSON.stringify({ resumed, stopped, seconds, layout, visible: false })}\n`);
  } finally {
    window.destroy();
  }
  // app.quit() would hand the exit code to the quit sequence; exit only after the flush above.
  app.exit(0);
}).catch(async (error) => {
  await emit(process.stderr, `${(error as Error)?.stack || String(error)}\n`);
  app.exit(1);
});
