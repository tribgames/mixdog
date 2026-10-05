import assert from 'node:assert/strict';
import { BrowserWindow, clipboard, screen } from 'electron';
import type { CapturePayload } from './scenario-types';
import { capturePayload, actionPayload } from './scenario-ocr';
import { eventually, runScenario, skip } from './scenario-runtime';
import type { ScenarioContext, ScenarioGroup } from './scenario-context';

interface NativeTextApp {
  windowId: string;
  app: string;
  capture: CapturePayload;
}

async function launchNativeTextApp(ctx: ScenarioContext): Promise<NativeTextApp> {
  const { fixture, command, nativeTextFixturePath } = ctx;
  // A dedicated native executable avoids modern Notepad's single-instance
  // tab restoration, which can reuse and then close a user's existing app.
  assert.ok(nativeTextFixturePath, 'native text fixture was not compiled');
  fixture.show();
  fixture.focus();
  await eventually(
    async () => BrowserWindow.getFocusedWindow()?.id || 0,
    (id) => id === fixture.id
  );
  const launched = actionPayload(
    await command(
      {
        action: 'launch',
        app: nativeTextFixturePath,
        capture_delay_ms: 2_000,
      },
      'native-app'
    )
  );
  const transition = launched.window_transition as
    | {
        next_target?: { id?: string };
      }
    | undefined;
  const nativeWindowId = transition?.next_target?.id;
  assert.ok(nativeWindowId, JSON.stringify(launched));
  // A launch shows the app without activating it. Windows' foreground lock
  // already blocks most activation here, so this pins the contract against an
  // explicit activation creeping into the launch path later.
  assert.equal(BrowserWindow.getFocusedWindow()?.id, fixture.id, 'launch must not take the foreground from the user');
  const capture = launched.capture_after as CapturePayload;
  assert.equal(capture.window_id, nativeWindowId);
  assert.ok((capture.elements?.length || 0) > 0);
  assert.ok(Number(capture.returned_elements) <= 40);
  const nativeLine = (await command({ action: 'list_windows' }, 'native-app')).text
    .split(/\r?\n/)
    .find((line) => line.startsWith(nativeWindowId));
  const nativeApp = nativeLine?.match(/\bapp=([^\s|]+)/)?.[1]?.trim();
  assert.ok(nativeApp, nativeLine);
  return { windowId: nativeWindowId, app: nativeApp, capture };
}

async function fillNativeTextFields(ctx: ScenarioContext, native: NativeTextApp): Promise<void> {
  const { command } = ctx;
  const { windowId: nativeWindowId, app: nativeApp } = native;
  const appCapture = capturePayload(
    await command(
      {
        action: 'capture',
        app: nativeApp,
        max_elements: 40,
      },
      'native-app'
    )
  );
  assert.equal(appCapture.window_id, nativeWindowId, JSON.stringify(appCapture));
  const editor = (appCapture.elements || []).find(
    (element) => element.role === 'Edit' && element.name === 'Native text editor'
  );
  assert.ok(editor?.ref, JSON.stringify(appCapture.elements));
  const setValue = actionPayload(
    await command(
      {
        action: 'set_value',
        ref: editor.ref,
        text: 'SETVALUE42',
        delivery: 'background',
        // The next step clicks a point in this observation's frame.
        capture_after_mode: 'state',
      },
      'native-app'
    )
  );
  assert.equal(setValue.verified, true, JSON.stringify(setValue));
  const setValueCapture = setValue.capture_after as CapturePayload;
  const freshEditor = (setValueCapture.elements || []).find(
    (element) => element.role === 'Edit' && element.name === 'Native text editor'
  );
  assert.equal(freshEditor?.value, 'SETVALUE42', JSON.stringify(setValueCapture));
  // An Edit control inserts a line break from the character its own loop
  // translates from Enter, so a background Enter must pass that loop the
  // way a keyboard press does. A point click keeps this on the key-message
  // route instead of the value writer.
  const [editorX, editorY, editorWidth, editorHeight] = freshEditor.bounds as number[];
  const typed = actionPayload(
    await command(
      {
        action: 'type',
        window_id: nativeWindowId,
        frame_id: setValueCapture.frame_id,
        x: Math.round(editorX + editorWidth / 2),
        y: Math.round(editorY + editorHeight / 2),
        text: 'L1\nL2',
        delivery: 'background',
      },
      'native-app'
    )
  );
  assert.equal(typed.path, 'win32_message', JSON.stringify(typed));
  const typedEditor = ((typed.capture_after as CapturePayload | undefined)?.elements || []).find(
    (element) => element.role === 'Edit' && element.name === 'Native text editor'
  );
  assert.match(String(typedEditor?.value ?? ''), /L1\s+L2/, JSON.stringify(typed));
  // One act fills two fields of the same observation: the second step's
  // ref outlives the first delivery and is re-proved before its own.
  const typedElements = (typed.capture_after as CapturePayload | undefined)?.elements || [];
  const secondField = typedElements.find(
    (element) => element.role === 'Edit' && element.name === 'Native second field'
  );
  assert.ok(typedEditor?.ref && secondField?.ref, JSON.stringify(typedElements));
  const filledResult = await command(
    {
      action: 'sequence',
      window_id: nativeWindowId,
      delivery: 'background',
      steps: [
        { action: 'set_value', ref: typedEditor.ref, text: 'MULTI-A' },
        { action: 'set_value', ref: secondField.ref, text: 'MULTI-B' },
      ],
    },
    'native-app'
  );
  const filled = actionPayload(filledResult);
  assert.equal(filled.completed, true, JSON.stringify(filled));
  const filledCapture = filled.capture_after as CapturePayload;
  assert.equal(filledCapture.mode, 'ax', JSON.stringify(filledCapture));
  assert.equal(filledResult.image, undefined, 'a ref-led act answers through its tree');
  const filledValues = Object.fromEntries(
    (filledCapture.elements || [])
      .filter((element) => element.role === 'Edit')
      .map((element) => [element.name, element.value])
  );
  assert.equal(filledValues['Native text editor'], 'MULTI-A', JSON.stringify(filledCapture));
  assert.equal(filledValues['Native second field'], 'MULTI-B', JSON.stringify(filledCapture));
}

async function invokeNativeMenuAndClose(ctx: ScenarioContext, native: NativeTextApp): Promise<void> {
  const { fixture, command } = ctx;
  const { windowId: nativeWindowId, app: nativeApp, capture } = native;
  fixture.show();
  fixture.focus();
  await eventually(
    async () => BrowserWindow.getFocusedWindow()?.id || 0,
    (id) => id === fixture.id
  );
  let menu: Record<string, unknown>;
  try {
    menu = actionPayload(
      await command(
        {
          action: 'invoke_menu',
          app: nativeApp,
          path: ['Fixture', 'Activate'],
        },
        'native-app'
      )
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}; capture elements=${JSON.stringify(capture.elements)}`);
  }
  assert.ok(['uia_menu', 'msaa_menu', 'win32_menu'].includes(String(menu.path)), JSON.stringify(menu));
  await eventually(
    async () => BrowserWindow.getFocusedWindow()?.id || 0,
    (id) => id === fixture.id
  );
  const verified = actionPayload(
    await command(
      {
        action: 'verify',
        window_id: nativeWindowId,
        expect: [{ present: 'MENU ACTIVATED' }, { title_contains: 'Native Menu Activated' }],
        timeout_ms: 3_000,
        stable_samples: 2,
      },
      'native-app'
    )
  );
  assert.equal(verified.decision, 'satisfied', JSON.stringify(verified));
  const appSequence = actionPayload(
    await command(
      {
        action: 'sequence',
        app: nativeApp,
        steps: [
          { action: 'key', keys: '{TAB}' },
          { action: 'wait', duration: 0 },
        ],
      },
      'native-app'
    )
  );
  assert.equal(appSequence.completed, true, JSON.stringify(appSequence));
  assert.equal(appSequence.window_id, nativeWindowId, JSON.stringify(appSequence));
  await command({ action: 'close_window', window_id: nativeWindowId }, 'native-app');
}

export const realAppsScenarios: ScenarioGroup = {
  S20: async (ctx) => {
    const { command } = ctx;
    await runScenario('S20', 'native text app capture and close', 'native-app', async () => {
      try {
        const native = await launchNativeTextApp(ctx);
        await fillNativeTextFields(ctx, native);
        await invokeNativeMenuAndClose(ctx, native);
      } finally {
        await command({ action: 'session_release' }, 'native-app');
      }
    });
  },
  S21: async (ctx) => {
    const { command, liveAppWindows } = ctx;
    await runScenario('S21', 'running Mixdog Electron capture', 'real-app', async () => {
      if (!liveAppWindows.mixdog) skip('running Mixdog window unavailable');
      const capture = capturePayload(
        await command(
          {
            action: 'capture',
            window_id: liveAppWindows.mixdog,
            max_elements: 40,
          },
          'mixdog-live'
        )
      );
      assert.equal(capture.pixel_status, 'available');
      assert.ok(capture.frame_id);
      assert.ok(Number(capture.returned_elements) <= 40);
    });
  },
  S22: async (ctx) => {
    const { command, liveAppWindows } = ctx;
    await runScenario('S22', 'running Chrome capture is available or fails closed', 'real-app', async () => {
      if (!liveAppWindows.chrome) skip('running Chrome/Edge window unavailable');
      // The window belongs to the user and was resolved at setup; closing it
      // mid-run is the user's action, and rejecting its old id is the fail-closed path.
      const result = await command(
        {
          action: 'capture',
          window_id: liveAppWindows.chrome,
          max_elements: 40,
        },
        'chrome-live'
      ).catch((error: unknown) => {
        if (/window_id is stale or invalid/.test(String((error as Error)?.message ?? error)))
          skip('running Chrome/Edge window closed during the run');
        throw error;
      });
      const capture = capturePayload(result);
      assert.ok(Number(capture.returned_elements) <= 40);
      if (capture.pixel_status === 'available') {
        assert.ok(capture.frame_id);
        assert.equal(result.image?.mimeType, 'image/jpeg');
      } else {
        assert.equal(capture.pixel_unavailable?.code, 'pixel_unavailable');
        assert.equal(capture.frame_id, undefined);
        assert.equal(result.image, undefined);
      }
    });
  },
  S23: async (ctx) => {
    const { command } = ctx;
    await runScenario('S23', 'session release is idempotent', 'cleanup', async () => {
      await command({ action: 'wait', duration: 0 }, 'cleanup-session');
      const first = await command({ action: 'session_release' }, 'cleanup-session');
      const second = await command({ action: 'session_release' }, 'cleanup-session');
      assert.match(first.text, /session released/i);
      assert.match(second.text, /session released/i);
    });
  },
  S29: async (ctx) => {
    const { denseWindowId, command } = ctx;
    await runScenario('S29', 'semantic invoke is confirmed by exact-window transition', 'verification', async () => {
      try {
        assert.ok(ctx.denseFixture && denseWindowId);
        const capture = capturePayload(
          await command(
            {
              action: 'capture',
              window_id: denseWindowId,
              max_elements: 40,
            },
            'semantic-transition'
          )
        );
        const target = (capture.elements || []).find(
          (element) => element.source === 'uia' && element.name === 'Dense Control 001'
        );
        assert.ok(target?.ref, JSON.stringify(capture.elements));
        const invokedResult = await command(
          {
            action: 'invoke',
            ref: target.ref,
            delivery: 'background',
            capture_after_mode: 'state',
          },
          'semantic-transition'
        );
        const invoked = actionPayload(invokedResult);
        // Added/removed rows can be a late tree or title transition rather than
        // the target's own state update, so pixels remain as independent evidence.
        assert.equal(
          (invoked.capture_after as Record<string, unknown>)?.image_omitted,
          undefined,
          JSON.stringify(invoked)
        );
        assert.equal((invoked.capture_after as Record<string, unknown>)?.changes, undefined, JSON.stringify(invoked));
        assert.ok(invokedResult.image, JSON.stringify(invoked));
        assert.equal(invoked.path, 'uia_invoke', JSON.stringify(invoked));
        assert.equal(invoked.effect, 'confirmed', JSON.stringify(invoked));
        assert.equal(invoked.verified, true, JSON.stringify(invoked));
        assert.equal(invoked.goal_verified, true, JSON.stringify(invoked));
        assert.equal(invoked.verification_source, 'window_transition', JSON.stringify(invoked));
        const compatible = capturePayload(
          await command(
            {
              action: 'capture',
              window_id: denseWindowId,
              mode: 'state',
              max_elements: 80,
            },
            'semantic-transition'
          )
        );
        assert.equal(compatible.changes?.baseline, 'previous_capture_of_same_window', JSON.stringify(compatible));
      } finally {
        await command({ action: 'session_release' }, 'semantic-transition');
      }
    });
  },
  S33: async (ctx) => {
    const { fixture, fixtureWindowId, command } = ctx;
    await runScenario('S33', 'window move and state operations restore their fixture', 'window-coverage', async () => {
      const original = fixture.getBounds();
      const workArea = screen.getPrimaryDisplay().workArea;
      try {
        await assert.rejects(
          command(
            {
              action: 'move_window',
              window_id: fixtureWindowId,
            },
            'window-coverage'
          ),
          /move_window requires x, y, width, or height/
        );
        await assert.rejects(
          command(
            {
              action: 'move_window',
              window_id: fixtureWindowId,
              width: 0,
            },
            'window-coverage'
          ),
          /invalid_window_bounds: width must be positive/
        );
        await assert.rejects(
          command(
            {
              action: 'window_state',
              window_id: fixtureWindowId,
              state: 'hide',
            },
            'window-coverage'
          ),
          /invalid_window_state: state must be minimize, maximize, or restore/
        );
        assert.deepEqual(fixture.getBounds(), original);
        assert.equal(fixture.isVisible(), true);
        const moved = actionPayload(
          await command(
            {
              action: 'move_window',
              window_id: fixtureWindowId,
              x: workArea.x + 180,
              y: workArea.y + 120,
              width: 720,
              height: 520,
            },
            'window-coverage'
          )
        );
        assert.equal(moved.verified, true, JSON.stringify(moved));
        for (const state of ['minimize', 'restore', 'maximize', 'restore']) {
          const changed = actionPayload(
            await command(
              {
                action: 'window_state',
                window_id: fixtureWindowId,
                state,
              },
              'window-coverage'
            )
          );
          assert.equal(changed.verified, true, JSON.stringify(changed));
          if (state === 'minimize') assert.equal(fixture.isMinimized(), true);
          if (state === 'maximize') assert.equal(fixture.isMaximized(), true);
          if (state === 'restore') {
            assert.equal(fixture.isMinimized(), false);
            assert.equal(fixture.isMaximized(), false);
          }
        }
        await command({ action: 'wait', duration: 0 }, 'window-coverage');
      } finally {
        fixture.setBounds(original);
        await command({ action: 'session_release' }, 'window-coverage');
      }
    });
  },
  S34: async (ctx) => {
    const { command } = ctx;
    await runScenario('S34', 'clipboard read is exact, bounded, and non-mutating', 'clipboard-coverage', async () => {
      const before = clipboard.readText();
      try {
        const result = await command({ action: 'clipboard_read' }, 'clipboard-coverage');
        const expected =
          before.length > 30_000
            ? `${before.slice(0, 30_000)}... (truncated)`
            : before || 'Clipboard is empty or not text.';
        assert.equal(result.text, expected);
        assert.equal(clipboard.readText(), before);
      } finally {
        await command({ action: 'session_release' }, 'clipboard-coverage');
      }
    });
  },
};
