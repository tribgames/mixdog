import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { overlayHtml, overlayScript, OVERLAY_WIDTH, OVERLAY_HEIGHT } from '../content';
import { computerUseOverlayPresentation } from '../model';
import { createComputerOverlayController } from '../controls';
import { bindComputerOverlayControls } from '../ipc-controls';
import { checkOverlayControlHitTarget, checkOverlayPulse, emulateMotionPreference } from './pill-motion';
import { nativeOverlayClick } from './native-click';
import { emit } from './process-output';
import { requireEnv } from './require-env';
import { overlayWindowOptions } from '../cursor-surface';

if (process.env.OVERLAY_SOFTWARE_RENDERING === '1') app.disableHardwareAcceleration();
app.setPath('userData', join(requireEnv('OVERLAY_TEST_DIRECTORY'), 'profile'));
// This fixture owns its only window; Electron's default quit-on-last-window-close would
// otherwise end the process the moment a failing step reaches the finally-block destroy.
app.on('window-all-closed', () => {});
void app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      ...overlayWindowOptions(),
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      alwaysOnTop: true,
      webPreferences: {
        ...overlayWindowOptions().webPreferences,
        preload: join(requireEnv('OVERLAY_TEST_DIRECTORY'), 'preload/computer-overlay.js'),
      },
    });
    // The shipped overlay is hardened after creation, and each of those calls
    // changes how Windows treats the window. A native press must survive them,
    // or the controls are dead exactly where the user reaches for them.
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setContentProtection(true);
    try {
      window.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true, visibleOnFullScreen: true });
    } catch {
      // Best effort, as in the shipped path.
    }
    // A renderer failure otherwise surfaces only as the generic "script failed to execute".
    window.webContents.on('console-message', (event) => {
      process.stderr.write(`renderer console [${event.level}] ${event.message}\n`);
    });
    try {
      // Windows Server (the CI runner) turns system animations off, which Chromium reads as reduced
      // motion. The checks read the stylesheet's own motion states, so pin the media feature.
      window.webContents.debugger.attach('1.3');
      let paused = 0,
        stopped = 0,
        seconds = 5;
      const resumed: number[] = [];
      let stopReceived: (() => void) | undefined;
      const controls = {
        async pause() {
          paused++;
        },
        async stop() {
          stopped++;
          stopReceived?.();
        },
        async resume(generation: number) {
          resumed.push(generation);
        },
        configureIdleResume(value: number) {
          seconds = value;
        },
      };
      const controller = createComputerOverlayController(controls, () => {});
      bindComputerOverlayControls(window.webContents, controller, controls, () => ({
        sessionIds: ['fixture'],
        generation: 7,
      }));
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      await window.loadURL(`data:text/html;base64,${Buffer.from(overlayHtml('ko')).toString('base64')}`);
      await emulateMotionPreference(window.webContents, 'no-preference');
      await window.webContents.executeJavaScript(overlayScript('ko'));
      // Every word the pill can show must come from its own face: with two
      // unrelated fallbacks behind it, any glyph the face lacks changes the width.
      const words = [
        '컴퓨터 사용 중',
        '일시정지',
        '확인 필요',
        '중단 중',
        '실패',
        'Computer in use',
        'Paused',
        'Check',
        'Stopping',
        'Failed',
      ].join(' ');
      const font = await window.webContents.executeJavaScript(`
      document.fonts.load('500 14px "Mixdog Overlay"', ${JSON.stringify(words)}).then((faces) => {
        const context = document.createElement('canvas').getContext('2d');
        const width = (fallback) => {
          context.font = '500 14px "Mixdog Overlay", ' + fallback;
          return context.measureText(${JSON.stringify(words)}).width;
        };
        return {
          faces: faces.length,
          covered: Math.abs(width('serif') - width('monospace')) < 0.01,
          title: getComputedStyle(document.getElementById('title')).fontFamily,
        };
      })`);
      assert.equal(font.faces, 1, 'the pill face must load');
      assert.equal(font.covered, true, 'a pill word fell back to another face');
      assert.match(font.title, /^"Mixdog Overlay"/);
      const clickStop = async (revision: number) =>
        window.webContents.executeJavaScript(`
      window.mixdogComputerOverlay({paused:false,generation:7,renderRevision:${revision}});
      new Promise((resolve,reject) => {
        const timeout=setTimeout(()=>reject(new Error('control acknowledgement missing')),3000);
        const button=document.getElementById('stop');
        const observer=new MutationObserver(()=>{
          if(button.getAttribute('aria-busy')==='false'){
            clearTimeout(timeout);observer.disconnect();resolve(true);
          }
        });
        observer.observe(button,{attributes:true,attributeFilter:['aria-busy']});
        button.click();
      });
    `);
      await clickStop(1);
      assert.equal(stopped, 1);
      // While working, Stop is the only control: an icon whose name is spoken, never shown.
      const running = await window.webContents.executeJavaScript(`
      window.mixdogComputerOverlay({paused:false,resumable:false,generation:7,renderRevision:2});
      ({ label: document.getElementById('stop').getAttribute('aria-label'),
         text: document.getElementById('stop').textContent,
         buttons: [...document.querySelectorAll('button')].filter((button) => !button.hidden).length })`);
      assert.deepEqual(running, { label: '중단', text: '', buttons: 1 });
      await checkOverlayPulse(window.webContents);
      await checkOverlayControlHitTarget(window.webContents);
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
            paused:true,generation:7,renderRevision:3,
            title:'일시정지'
          });
          button.getBoundingClientRect();
        }, {once:true});
        const rect=button.getBoundingClientRect();
        resolve({x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+1)});
      })))
    `);
      const [windowX, windowY] = window.getPosition();
      const handle = window.getNativeWindowHandle();
      let nativeDeadline: NodeJS.Timeout | undefined;
      const nativeAck = new Promise<void>((resolve, reject) => {
        stopReceived = resolve;
        nativeDeadline = setTimeout(() => reject(new Error('native Stop acknowledgement missing')), 10_000);
      });
      try {
        const [clickMode] = await Promise.all([
          nativeOverlayClick(
            handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE()),
            screen.dipToScreenPoint({ x: windowX + point.x, y: windowY + point.y })
          ),
          nativeAck,
        ]);
        await emit(process.stderr, `OVERLAY_CLICK_MODE ${clickMode}\n`);
      } finally {
        clearTimeout(nativeDeadline);
        stopReceived = undefined;
      }
      assert.equal(stopped, 2, 'native Stop click must survive the takeover state change');
      // Where the top-level pill window owns the hit test, Windows discards the
      // button-down; the release alone must still reach Stop.
      const eatenAck = new Promise<void>((resolve, reject) => {
        stopReceived = resolve;
        nativeDeadline = setTimeout(() => reject(new Error('eaten-press Stop acknowledgement missing')), 10_000);
      });
      try {
        await Promise.all([
          nativeOverlayClick(
            handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE()),
            screen.dipToScreenPoint({ x: windowX + point.x, y: windowY + point.y }),
            true
          ),
          eatenAck,
        ]);
      } finally {
        clearTimeout(nativeDeadline);
        stopReceived = undefined;
      }
      assert.equal(stopped, 3, 'a release whose press Windows discarded must still stop');
      assert.equal(paused, 0, 'the overlay never pauses');
      assert.equal(window.isFocused(), false, 'Stop must not activate its window');
      window.hide();
      const layout = [];
      let revision = 4;
      for (const locale of ['ko', 'en']) {
        await window.loadURL(`data:text/html;base64,${Buffer.from(overlayHtml(locale)).toString('base64')}`);
        await emulateMotionPreference(window.webContents, 'no-preference');
        await window.webContents.executeJavaScript(overlayScript(locale));
        let stopBounds: unknown;
        for (const reason of ['', 'user_input_active', 'user_stop', 'input_cleanup_unconfirmed', 'turn_stop']) {
          const presentation = computerUseOverlayPresentation(
            {
              revision: 0,
              userControlActive: Boolean(reason),
              takeoverReason: reason,
              takeoverGeneration: 7,
              cleanupState: reason === 'input_cleanup_unconfirmed' ? 'failed' : 'ready',
              pausedSessionIds: ['fixture'],
              activities: [],
              cursors: [],
              targetLeases: [],
            },
            locale,
            { error: reason === 'turn_stop' ? 'stop' : '' }
          );
          const observed = await window.webContents.executeJavaScript(`
          window.mixdogComputerOverlay(${JSON.stringify({ ...presentation, renderRevision: revision++ })});
          ({
            title:document.getElementById('title').textContent,
            pillWidth:document.getElementById('pill').getBoundingClientRect().width,
            stopBounds:(() => { const r=document.getElementById('stop').getBoundingClientRect();
              return {x:r.x,y:r.y,width:r.width,height:r.height}; })(),
            buttons:[...document.querySelectorAll('button')].filter((button) => !button.hidden).length,
            label:document.getElementById('stop').getAttribute('aria-label'),
            disabled:document.getElementById('stop').disabled,
            text:document.body.textContent.replace(/\\s+/g,' ').trim(),
            moving:document.getElementById('mark').getAnimations({subtree:true})
              .some(animation=>animation.playState==='running'),
            fits:[...document.querySelectorAll('#pill,#status,#title,button')].every(element=>{
              const rect=element.getBoundingClientRect();
              return element.scrollWidth<=element.clientWidth && element.scrollHeight<=element.clientHeight
                && rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight;
            })
          })
        `);
          const label = locale === 'ko' ? '중단' : 'Stop';
          assert.equal(observed.title, presentation.title);
          assert.equal(observed.text, presentation.title);
          assert.equal(observed.moving, !presentation.paused);
          assert.equal(observed.fits, true, `${locale}/${reason} overflows`);
          assert.equal(observed.pillWidth, OVERLAY_WIDTH - 20, `${locale}/${reason} must keep the same compact width`);
          // Stop is in every state and in the same place; Resume joins it only while paused.
          assert.equal(observed.buttons, presentation.resumable ? 2 : 1);
          assert.equal(observed.label, label);
          assert.equal(observed.disabled, false);
          stopBounds ??= observed.stopBounds;
          assert.deepEqual(observed.stopBounds, stopBounds, `${locale}/${reason} moved the Stop hit target`);
          layout.push({ locale, reason, ...observed });
        }
        await checkOverlayControlHitTarget(window.webContents, '#resume');
      }
      await window.webContents.executeJavaScript(`window.mixdogComputerControl({action:'configure',seconds:10})`);
      assert.equal(seconds, 10);
      assert.equal(
        await window.webContents.executeJavaScript(
          `window.mixdogComputerControl({action:'configure',seconds:-1}).then(()=>false,()=>true)`
        ),
        true
      );
      // Resume carries the generation the user saw; nothing else is a control.
      await window.webContents.executeJavaScript(`window.mixdogComputerControl({action:'resume',generation:7})`);
      assert.deepEqual(resumed, [7]);
      for (const action of ['pause', 'cancel', 'dismiss']) {
        assert.equal(
          await window.webContents.executeJavaScript(
            `window.mixdogComputerControl({action:${JSON.stringify(action)},generation:7}).then(()=>false,()=>true)`
          ),
          true
        );
      }
      await clickStop(revision++);
      assert.equal(paused, 0);
      assert.equal(stopped, 4);
      assert.equal(window.isVisible(), false);
      await emit(
        process.stdout,
        `OVERLAY_RESULT ${JSON.stringify({ stopped, paused, resumed, seconds, font, layout, visible: false })}\n`
      );
    } finally {
      window.destroy();
    }
    // app.quit() would hand the exit code to the quit sequence; exit only after the flush above.
    app.exit(0);
  })
  .catch(async (error) => {
    await emit(process.stderr, `${(error as Error)?.stack || String(error)}\n`);
    app.exit(1);
  });
