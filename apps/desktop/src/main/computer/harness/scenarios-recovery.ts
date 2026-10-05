import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';
import type { CapturePayload } from './scenario-types';
import { capturePayload, actionPayload, ocrText, ocrMark } from './scenario-ocr';
import { progress, eventually, readDiscovery, runScenario, dataDirectory } from './scenario-runtime';
import { createDenseFixture, foregroundHwnd, nativeHwnd, spawnNativeDialogFixture } from './scenario-fixtures';
import type { ScenarioContext, ScenarioGroup } from './scenario-context';

async function findNativeDialogParent(command: ScenarioContext['command']): Promise<string> {
  const parentLine = (text: string) =>
    text.split(/\r?\n/).find((line) => line.includes('"Mixdog Native Dialog Fixture"')) || '';
  const listed = await eventually(
    async () => (await command({ action: 'list_windows' }, 'popup-transition')).text,
    (text) => Boolean(parentLine(text)),
    20_000
  );
  const parentWindowId = parentLine(listed).match(/^(hwnd:0x[0-9a-f]+)/i)?.[1] || '';
  assert.ok(parentWindowId, listed);
  await command(
    {
      action: 'capture',
      window_id: parentWindowId,
      mode: 'state',
      max_elements: 40,
    },
    'popup-transition'
  );
  return parentWindowId;
}

async function warmUpOpenDialog(command: ScenarioContext['command'], parentWindowId: string): Promise<void> {
  // The first shell-backed file dialog pays Explorer's cold start, which can
  // outlast any settle budget the transition is sampled at. Paying it here
  // keeps the measured open about the host's transition report, not about
  // how busy Windows was when the dialog first painted.
  const dialogLine = (text: string) =>
    text.split(/\r?\n/).find((line) => line.includes('"Mixdog Native Open Dialog"')) || '';
  const warmup = actionPayload(
    await command(
      {
        action: 'key',
        window_id: parentWindowId,
        keys: '^o',
        delivery: 'foreground',
        capture_delay_ms: 1_000,
      },
      'popup-transition'
    )
  );
  assert.equal(
    warmup.delivery_accepted,
    true,
    `dialog warmup input refused: ${JSON.stringify({
      code: warmup.code,
      verdict: warmup.verdict,
      input_may_have_executed: warmup.input_may_have_executed,
    })}`
  );
  const warmupListed = await eventually(
    async () => (await command({ action: 'list_windows' }, 'popup-transition')).text,
    (text) => Boolean(dialogLine(text)),
    20_000
  );
  const warmupPopupId = dialogLine(warmupListed).match(/^(hwnd:0x[0-9a-f]+)/i)?.[1] || '';
  assert.ok(warmupPopupId, warmupListed);
  await command(
    {
      action: 'capture',
      window_id: warmupPopupId,
      mode: 'state',
      max_elements: 10,
    },
    'popup-transition'
  );
  await command(
    {
      action: 'key',
      window_id: warmupPopupId,
      keys: '{ESC}',
      delivery: 'foreground',
      capture_delay_ms: 300,
    },
    'popup-transition'
  );
  await eventually(
    async () => (await command({ action: 'list_windows' }, 'popup-transition')).text,
    (text) => !dialogLine(text),
    10_000
  );
}

async function openDialogForMeasurement(command: ScenarioContext['command'], parentWindowId: string): Promise<string> {
  // Every mutation invalidates the session's observation, so the measured
  // open needs its own fresh look at the parent.
  await command(
    {
      action: 'capture',
      window_id: parentWindowId,
      mode: 'state',
      max_elements: 40,
    },
    'popup-transition'
  );
  const opened = actionPayload(
    await command(
      {
        action: 'key',
        window_id: parentWindowId,
        keys: '^o',
        delivery: 'foreground',
        // The transition is sampled once the requested settle ends, so this
        // budget is what the scenario claims a warm dialog needs.
        capture_delay_ms: 1_500,
      },
      'popup-transition'
    )
  );
  const openedTransition = opened.window_transition as
    | {
        next_target?: { id?: string };
        opened_windows?: Array<{ id?: string; title?: string }>;
      }
    | undefined;
  const popupWindowId =
    openedTransition?.next_target?.id ||
    openedTransition?.opened_windows?.find((window) => window.title === 'Mixdog Native Open Dialog')?.id ||
    '';
  assert.ok(popupWindowId, JSON.stringify(opened));
  const popupCapture = capturePayload(
    await command(
      {
        action: 'capture',
        window_id: popupWindowId,
        mode: 'state',
        max_elements: 40,
      },
      'popup-transition'
    )
  );
  // A dialog whose own surface cannot be captured is answered by the owner
  // it belongs to, and the payload says so. Either outcome is truthful; a
  // silent substitution would not be.
  assert.equal(
    popupCapture.window_id === popupWindowId ||
      (popupCapture.requested_window_id === popupWindowId && popupCapture.capture_target_reason === 'capturable_owner'),
    true,
    JSON.stringify(popupCapture)
  );
  assert.equal(popupCapture.pixel_status, 'available', JSON.stringify(popupCapture));
  assert.ok(popupCapture.frame_id, JSON.stringify(popupCapture));
  return popupWindowId;
}

async function closeDialogAndVerify(
  command: ScenarioContext['command'],
  parentWindowId: string,
  popupWindowId: string
): Promise<void> {
  await command(
    {
      action: 'focus_window',
      window_id: parentWindowId,
    },
    'popup-transition'
  );
  const closed = actionPayload(
    await command(
      {
        action: 'key',
        window_id: popupWindowId,
        keys: '{ESC}',
        delivery: 'foreground',
        capture_delay_ms: 300,
      },
      'popup-transition'
    )
  );
  assert.equal(closed.window_id, parentWindowId, JSON.stringify(closed));
  assert.equal(closed.input_surface_window_id, popupWindowId, JSON.stringify(closed));
  assert.equal((closed.input_recovery as Record<string, unknown> | undefined)?.ok, true, JSON.stringify(closed));
  const closedWindows =
    (
      closed.window_transition as
        | {
            closed_windows?: Array<{ id?: string }>;
          }
        | undefined
    )?.closed_windows || [];
  assert.ok(
    closedWindows.some((window) => window.id === popupWindowId),
    JSON.stringify(closed)
  );
  const verified = closed.capture_after as Record<string, unknown> | undefined;
  assert.equal(verified?.ok, true, JSON.stringify(closed));
  assert.equal(verified?.window_id, parentWindowId, JSON.stringify(closed));
  assert.equal(verified?.pixel_status, 'available', JSON.stringify(closed));
}

export const recoveryScenarios: ScenarioGroup = {
  S15: async (ctx) => {
    const { koreanWindowId, command } = ctx;
    await runScenario('S15', 'Korean OCR produces actionable mark', 'korean-ocr', async () => {
      try {
        const capture = capturePayload(
          await command(
            {
              action: 'capture',
              window_id: koreanWindowId,
              mode: 'som',
              include_ocr: true,
              ocr_language: 'ko',
              max_elements: 40,
              max_ocr_words: 60,
            },
            'korean-ocr'
          )
        );
        assert.equal(capture.ocr?.ok, true);
        const mark = ocrMark(capture, '보내기');
        const clicked = actionPayload(
          await command(
            {
              action: 'click',
              element: mark,
              delivery: 'background',
              capture_after_mode: 'som',
              capture_after_include_ocr: true,
              capture_after_ocr_language: 'ko',
              capture_after_max_elements: 40,
              capture_after_max_ocr_words: 60,
            },
            'korean-ocr'
          )
        );
        const verified = clicked.capture_after as CapturePayload;
        assert.match(ocrText(verified), /클릭\s*1\s*회/);
      } finally {
        await command({ action: 'session_release' }, 'korean-ocr');
      }
    });
  },
  S16: async (ctx) => {
    const { clutterWindowId, command } = ctx;
    await runScenario('S16', 'OCR clutter stays within shared budget', 'ocr-budget', async () => {
      const capture = capturePayload(
        await command(
          {
            action: 'capture',
            window_id: clutterWindowId,
            mode: 'som',
            include_ocr: true,
            max_elements: 25,
            max_ocr_words: 100,
          },
          'ocr-clutter'
        )
      );
      assert.equal(capture.ocr?.ok, true);
      assert.ok(Number(capture.returned_elements) <= 25);
      assert.ok((capture.ocr?.words?.length || 0) <= 25);
      const identities = (capture.ocr?.words || []).map(
        (word) =>
          `${String(word.text || '')
            .trim()
            .toLocaleUpperCase()}@${word.x},${word.y},${word.width},${word.height}`
      );
      assert.equal(new Set(identities).size, identities.length);
    });
  },
  S17: async (ctx) => {
    const { fixture, fixtureWindowId, command, turnEndHome } = ctx;
    await runScenario(
      'S17',
      'foreground pointer keeps task focus until session release',
      'focus-recovery',
      async () => {
        try {
          const home = await turnEndHome();
          const clickCountBefore = Number(
            await fixture.webContents.executeJavaScript('globalThis.mixdogMotorState().clickCount')
          );
          const capture = capturePayload(
            await command(
              {
                action: 'capture',
                window_id: fixtureWindowId,
                mode: 'som',
                include_ocr: true,
                max_elements: 40,
              },
              'focus-recovery'
            )
          );
          assert.ok(capture.frame_id, JSON.stringify(capture));
          progress('S17 home window holds focus');
          const action = actionPayload(
            await command(
              {
                action: 'click',
                window_id: fixtureWindowId,
                frame_id: capture.frame_id,
                // Deterministic center of the fixture's SEND button. This scenario
                // verifies frame-bound foreground focus/recovery, not OCR segmentation.
                x: 220,
                y: 141,
                delivery: 'foreground',
              },
              'focus-recovery'
            )
          );
          const recovery = action.input_recovery as
            | {
                focus_restored?: boolean;
                focus_preserved_for_followup?: boolean;
                focus_recovery?: string;
                cursor_held_for_followup?: boolean;
                expected_focus_window_id?: string;
              }
            | undefined;
          assert.equal(recovery?.focus_restored, false, JSON.stringify(action));
          assert.equal(recovery?.focus_preserved_for_followup, true, JSON.stringify(action));
          assert.equal(recovery?.focus_recovery, 'session_release', JSON.stringify(action));
          // The session keeps the pointer where the agent left it; the user's
          // position returns once, at session release.
          assert.equal(recovery?.cursor_held_for_followup, true, JSON.stringify(action));
          assert.notEqual(recovery?.expected_focus_window_id, fixtureWindowId);
          // Home is the guard, or the app Windows' foreground lock kept in front; the host records it as where the user left focus.
          const restoreHwnd = BigInt(String(recovery?.expected_focus_window_id || '0').replace(/^hwnd:/i, '') || '0');
          assert.equal(restoreHwnd, home, JSON.stringify(action));
          await eventually(
            async () => BrowserWindow.getFocusedWindow()?.id || 0,
            (id) => id === fixture.id
          );
          progress('S17 fixture keeps focus after the click');
          assert.ok(
            Number(await fixture.webContents.executeJavaScript('globalThis.mixdogMotorState().clickCount')) >
              clickCountBefore,
            JSON.stringify(action)
          );
          await command({ action: 'session_release' }, 'focus-recovery');
          progress('S17 session released');
          await eventually(foregroundHwnd, (hwnd) => hwnd === home);
          progress('S17 focus restored to the home window');
        } finally {
          await command({ action: 'session_release' }, 'focus-recovery');
        }
      }
    );
  },
  S18: async (ctx) => {
    const { command } = ctx;
    await runScenario('S18', 'owned popup input preserves parent observation scope', 'window-transition', async () => {
      try {
        ctx.nativeDialogChild = spawnNativeDialogFixture();
        const parentWindowId = await findNativeDialogParent(command);
        await warmUpOpenDialog(command, parentWindowId);
        const popupWindowId = await openDialogForMeasurement(command, parentWindowId);
        await closeDialogAndVerify(command, parentWindowId, popupWindowId);
      } finally {
        await command({ action: 'session_release' }, 'popup-transition');
        ctx.nativeDialogChild?.kill();
        ctx.nativeDialogChild = null;
      }
    });
  },
  S26: async (ctx) => {
    const { command, windows } = ctx;
    await runScenario('S26', 'closed HWND and frame are rejected before replacement', 'stress', async () => {
      assert.ok(ctx.denseFixture && ctx.denseWindowId);
      const captured = capturePayload(
        await command(
          {
            action: 'capture',
            window_id: ctx.denseWindowId,
            max_elements: 20,
          },
          'closed-target'
        )
      );
      assert.ok(captured.frame_id);
      const closedWindowId = ctx.denseWindowId;
      const closedFrameId = String(captured.frame_id);
      ctx.denseFixture.destroy();
      ctx.denseFixture = null;
      ctx.denseWindowId = '';
      await new Promise((resolve) => setTimeout(resolve, 80));
      await assert.rejects(
        command({ action: 'screenshot', window_id: closedWindowId }, 'closed-target'),
        /stale or invalid|window_id is stale/
      );
      await assert.rejects(
        command(
          {
            action: 'zoom',
            frame_id: closedFrameId,
            region: [0, 0, 16, 16],
          },
          'closed-target'
        ),
        /stale_frame|stale or invalid/
      );
      ctx.denseFixture = await createDenseFixture();
      windows.push(ctx.denseFixture);
      const listed = (await command({ action: 'list_windows' }, 'closed-target')).text;
      ctx.denseWindowId =
        listed
          .split(/\r?\n/)
          .find((line) => line.includes('"Mixdog Dense Accessibility Fixture"'))
          ?.match(/^(hwnd:0x[0-9a-f]+)/i)?.[1] || '';
      assert.ok(ctx.denseWindowId);
    });
  },
  S35: async (ctx) => {
    const { command, host } = ctx;
    await runScenario('S35', 'bridge restart retires workers and republishes one generation', 'lifecycle', async () => {
      const discoveryPath = join(dataDirectory, 'computer-bridge.json');
      const rapidPreviousToken = ctx.bridge.discovery.token;
      host.setBridgeEnabled(false);
      host.setBridgeEnabled(true);
      await eventually(
        async () => {
          try {
            return String(JSON.parse(readFileSync(discoveryPath, 'utf8')).token || '');
          } catch {
            return '';
          }
        },
        (candidate) => Boolean(candidate && candidate !== rapidPreviousToken),
        45_000
      );
      ctx.bridge.discovery = await readDiscovery(discoveryPath, 45_000);
      const rapidSessionId = 'bridge-rapid-toggle';
      try {
        const waited = await command(
          {
            action: 'wait',
            duration: 0,
          },
          rapidSessionId
        );
        assert.equal(waited.text, 'waited 0s');
        // Workers are created on demand, so a republished bridge owns one only
        // after a command has actually needed it.
        await eventually(
          async () => host.residentWorkerPids().length,
          (count) => count === 1,
          10_000
        );
      } finally {
        await command({ action: 'session_release' }, rapidSessionId);
      }
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        const previousToken = ctx.bridge.discovery.token;
        // The restart has to retire a live worker, so create one here instead of
        // depending on an earlier session having left one behind.
        const warmSessionId = `bridge-restart-warm-${cycle}`;
        assert.equal((await command({ action: 'wait', duration: 0 }, warmSessionId)).text, 'waited 0s');
        assert.ok(host.residentWorkerPids().length > 0);
        host.setBridgeEnabled(false);
        progress(`S35 cycle ${cycle} disable requested`);
        await eventually(
          async () => {
            try {
              readFileSync(discoveryPath);
              return false;
            } catch {
              return true;
            }
          },
          Boolean,
          10_000
        );
        progress(`S35 cycle ${cycle} discovery removed`);
        await eventually(
          async () => host.residentWorkerPids().length,
          (count) => count === 0,
          10_000
        );
        progress(`S35 cycle ${cycle} workers retired`);
        host.setBridgeEnabled(true);
        progress(`S35 cycle ${cycle} enable requested`);
        ctx.bridge.discovery = await readDiscovery(discoveryPath, 45_000);
        progress(`S35 cycle ${cycle} discovery republished`);
        assert.notEqual(ctx.bridge.discovery.token, previousToken);
        const sessionId = `bridge-restart-${cycle}`;
        try {
          const waited = await command(
            {
              action: 'wait',
              duration: 0,
            },
            sessionId
          );
          assert.equal(waited.text, 'waited 0s');
          progress(`S35 cycle ${cycle} command passed`);
          await eventually(
            async () => host.residentWorkerPids().length,
            (count) => count === 1,
            10_000
          );
          progress(`S35 cycle ${cycle} one worker ready`);
        } finally {
          await command({ action: 'session_release' }, sessionId);
        }
      }
    });
  },
  S41: async (ctx) => {
    const { fixtureWindowId, command } = ctx;
    await runScenario(
      'S41',
      'screen vision capture clears the previous exact-window input scope',
      'stale-state',
      async () => {
        const sessionId = 'screen-capture-scope';
        try {
          await command(
            {
              action: 'capture',
              window_id: fixtureWindowId,
              mode: 'state',
              max_elements: 20,
            },
            sessionId
          );
          const screenCapture = capturePayload(
            await command(
              {
                action: 'capture',
                mode: 'vision',
                screen: 0,
              },
              sessionId
            )
          );
          assert.ok(screenCapture.frame_id, JSON.stringify(screenCapture));
          await assert.rejects(
            command(
              {
                action: 'type',
                window_id: fixtureWindowId,
                text: 'STALE-SCOPE-MUST-NOT-TYPE',
                delivery: 'background',
              },
              sessionId
            ),
            /requires a fresh capture|stale_target/
          );
        } finally {
          await command({ action: 'session_release' }, sessionId);
        }
      }
    );
  },
  S42: async (ctx) => {
    const { fixtureWindowId, command, windows } = ctx;
    await runScenario('S42', 'failed exact-window capture clears the previous input scope', 'stale-state', async () => {
      const sessionId = 'failed-capture-scope';
      const disposable = new BrowserWindow({
        width: 320,
        height: 180,
        show: true,
        title: 'Mixdog Failed Capture Fixture',
      });
      windows.push(disposable);
      try {
        await disposable.loadURL(
          'data:text/html,<meta charset="utf-8"><title>Mixdog Failed Capture Fixture</title><body>FAILED CAPTURE</body>'
        );
        disposable.showInactive();
        const listed = await command({ action: 'list_windows' }, sessionId);
        const closedWindowId =
          listed.text
            .split(/\r?\n/)
            .find((line) => line.includes('"Mixdog Failed Capture Fixture"'))
            ?.match(/^(hwnd:0x[0-9a-f]+)/i)?.[1] || '';
        assert.ok(closedWindowId, listed.text);
        await command(
          {
            action: 'capture',
            window_id: fixtureWindowId,
            mode: 'state',
            max_elements: 20,
          },
          sessionId
        );
        disposable.destroy();
        await assert.rejects(
          command(
            {
              action: 'capture',
              window_id: closedWindowId,
              mode: 'state',
              max_elements: 20,
            },
            sessionId
          ),
          /stale or invalid|window_id is stale|window lookup failed/
        );
        await assert.rejects(
          command(
            {
              action: 'type',
              window_id: fixtureWindowId,
              text: 'FAILED-CAPTURE-MUST-NOT-TYPE',
              delivery: 'background',
            },
            sessionId
          ),
          /requires a fresh capture|stale_target/
        );
      } finally {
        if (!disposable.isDestroyed()) disposable.destroy();
        await command({ action: 'session_release' }, sessionId);
      }
    });
  },
  S43: async (ctx) => {
    const { command, windows } = ctx;
    await runScenario('S43', 'closed target cannot retain its previous input scope', 'stale-state', async () => {
      const sessionId = 'closed-input-scope';
      const disposable = new BrowserWindow({
        width: 320,
        height: 180,
        show: true,
        title: 'Mixdog Closed Scope Fixture',
      });
      windows.push(disposable);
      try {
        await disposable.loadURL(
          'data:text/html,<meta charset="utf-8"><title>Mixdog Closed Scope Fixture</title><body>CLOSE SCOPE</body>'
        );
        disposable.showInactive();
        const listed = await command({ action: 'list_windows' }, sessionId);
        const windowId =
          listed.text
            .split(/\r?\n/)
            .find((line) => line.includes('"Mixdog Closed Scope Fixture"'))
            ?.match(/^(hwnd:0x[0-9a-f]+)/i)?.[1] || '';
        assert.ok(windowId, listed.text);
        await command(
          {
            action: 'capture',
            window_id: windowId,
            mode: 'state',
            max_elements: 20,
          },
          sessionId
        );
        const closed = actionPayload(
          await command(
            {
              action: 'close_window',
              window_id: windowId,
            },
            sessionId
          )
        );
        assert.equal(closed.verified, true, JSON.stringify(closed));
        await assert.rejects(
          command(
            {
              action: 'type',
              window_id: windowId,
              text: 'CLOSED-SCOPE-MUST-NOT-TYPE',
              delivery: 'background',
            },
            sessionId
          ),
          /requires a fresh capture/
        );
      } finally {
        if (!disposable.isDestroyed()) disposable.destroy();
        await command({ action: 'session_release' }, sessionId);
      }
    });
  },
  S45: async (ctx) => {
    const { fixtureWindowId, command, turnEndHome, inputHeld } = ctx;
    await runScenario(
      'S45',
      'turn end releases held keys and hands focus and pointer back at once',
      'focus-recovery',
      async () => {
        const sessionId = 'turn-end-held-key';
        const diagnoseSessionId = 'turn-end-held-key-diagnose';
        try {
          const home = await turnEndHome();
          const origin = screen.getCursorScreenPoint();
          const capture = capturePayload(
            await command(
              { action: 'capture', window_id: fixtureWindowId, mode: 'som', include_ocr: true, max_elements: 40 },
              sessionId
            )
          );
          assert.ok(capture.frame_id, JSON.stringify(capture));
          // The click moves the pointer and focus to the field; the held key then lands there.
          await command({ action: 'click', element: ocrMark(capture, 'TYPE'), delivery: 'foreground' }, sessionId);
          await command({ action: 'capture', window_id: fixtureWindowId, max_elements: 20 }, sessionId);
          const held = actionPayload(
            await command(
              { action: 'key_down', window_id: fixtureWindowId, keys: 'shift', delivery: 'foreground' },
              sessionId
            )
          );
          assert.equal(await inputHeld(diagnoseSessionId), true, JSON.stringify(held));
          await command({ action: 'execution_end' }, sessionId);
          const turnState = async () => ({
            held: await inputHeld(diagnoseSessionId),
            foreground: await foregroundHwnd(),
            cursor: screen.getCursorScreenPoint(),
          });
          try {
            await eventually(
              turnState,
              (state) =>
                state.held === false &&
                state.foreground === home &&
                Math.abs(state.cursor.x - origin.x) <= 2 &&
                Math.abs(state.cursor.y - origin.y) <= 2
            );
          } catch (error) {
            const state = await turnState();
            throw new Error(
              `${(error as Error).message}; held=${state.held} foreground=0x${state.foreground.toString(16)}` +
                ` home=0x${home.toString(16)} target=${fixtureWindowId} cursor=${state.cursor.x},${state.cursor.y}` +
                ` origin=${origin.x},${origin.y}`
            );
          }
        } finally {
          await command({ action: 'session_release' }, sessionId);
          await command({ action: 'session_release' }, diagnoseSessionId);
        }
      }
    );
  },
  S46: async (ctx) => {
    const { fixtureWindowId, command, windows, turnEndHome } = ctx;
    await runScenario(
      'S46',
      "turn end of one session leaves another session's foreground work alone",
      'focus-recovery',
      async () => {
        const sessionA = 'turn-end-session-a';
        const sessionB = 'turn-end-session-b';
        try {
          const peer = new BrowserWindow({
            width: 360,
            height: 220,
            show: true,
            title: 'Mixdog Turn End Peer',
          });
          windows.push(peer);
          await peer.loadURL('data:text/html,<title>Mixdog Turn End Peer</title><body>PEER</body>');
          const peerLine = (text: string) =>
            text.split(/\r?\n/).find((line) => line.includes('"Mixdog Turn End Peer"')) || '';
          const listed = await eventually(
            async () => (await command({ action: 'list_windows' }, sessionB)).text,
            (text) => Boolean(peerLine(text))
          );
          const peerWindowId = peerLine(listed).match(/^(hwnd:0x[0-9a-f]+)/i)?.[1] || '';
          assert.ok(peerWindowId, listed);
          // Both targets are observed first; the home window is settled right before the clicks.
          const captureOf = async (windowId: string, sessionId: string) =>
            capturePayload(
              await command(
                { action: 'capture', window_id: windowId, mode: 'som', include_ocr: true, max_elements: 40 },
                sessionId
              )
            );
          const captureA = await captureOf(fixtureWindowId, sessionA);
          const captureB = await captureOf(peerWindowId, sessionB);
          const home = await turnEndHome();
          await command(
            {
              action: 'click',
              window_id: fixtureWindowId,
              frame_id: captureA.frame_id,
              x: 220,
              y: 141,
              delivery: 'foreground',
            },
            sessionA
          );
          await command(
            {
              action: 'click',
              window_id: peerWindowId,
              frame_id: captureB.frame_id,
              x: 180,
              y: 110,
              delivery: 'foreground',
            },
            sessionB
          );
          await eventually(foregroundHwnd, (hwnd) => hwnd === nativeHwnd(peer));
          await command({ action: 'execution_end' }, sessionA);
          // Give a wrongly applied restore time to land before asserting nothing moved.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          assert.equal(await foregroundHwnd(), nativeHwnd(peer));
          await command({ action: 'execution_end' }, sessionB);
          try {
            await eventually(foregroundHwnd, (hwnd) => hwnd === home);
          } catch (error) {
            throw new Error(
              `${(error as Error).message}; foreground=0x${(await foregroundHwnd()).toString(16)}` +
                ` home=0x${home.toString(16)} sessionA=${fixtureWindowId} sessionB=${peerWindowId}`
            );
          }
        } finally {
          await command({ action: 'session_release' }, sessionA);
          await command({ action: 'session_release' }, sessionB);
        }
      }
    );
  },
};
