import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BrowserWindow } from 'electron';
import type { CapturePayload } from './scenario-types';
import { capturePayload, actionPayload, ocrMark } from './scenario-ocr';
import { ScenarioSkip, runScenario } from './scenario-runtime';
import type { ScenarioGroup } from './scenario-context';

export const observationScenarios: ScenarioGroup = {
  S01: async (ctx) => {
    const { fixtureWindowId, koreanWindowId, clutterWindowId, blackWindowId, whiteWindowId, denseWindowId, command } =
      ctx;
    await runScenario('S01', 'exact window discovery', 'observation', async () => {
      const listed = (await command({ action: 'list_windows' })).text;
      for (const [title, expectedId] of [
        ['Mixdog Scenario Renderer', fixtureWindowId],
        ['Mixdog Korean OCR Fixture', koreanWindowId],
        ['Mixdog OCR Clutter Fixture', clutterWindowId],
        ['Mixdog Black Frame Fixture', blackWindowId],
        ['Mixdog White Frame Fixture', whiteWindowId],
        ...(ctx.denseFixture ? [['Mixdog Dense Accessibility Fixture', denseWindowId]] : []),
      ]) {
        assert.ok(
          listed.split(/\r?\n/).some((line) => line.startsWith(`${expectedId} `) && line.includes(`"${title}"`)),
          `${expectedId} "${title}" missing from\n${listed}`
        );
      }
      const appList = JSON.parse((await command({ action: 'list_apps' })).text) as {
        apps?: Array<{ windows?: Array<{ window_id?: string }> }>;
      };
      assert.ok(
        appList.apps?.some((entry) => entry.windows?.some((window) => window.window_id === fixtureWindowId)),
        JSON.stringify(appList)
      );
    });
  },
  S02: async (ctx) => {
    const { fixtureWindowId, displayPlacement, command } = ctx;
    await runScenario('S02', 'secondary or off-screen compact capture', 'coordinates', async () => {
      assert.ok(['secondary_display', 'partially_offscreen'].includes(displayPlacement));
      const capture = await command({
        action: 'capture',
        window_id: fixtureWindowId,
        max_elements: 20,
      });
      const payload = capturePayload(capture);
      assert.equal(payload.pixel_status, 'available');
      assert.ok(payload.frame_id);
      assert.equal(capture.image?.mimeType, 'image/jpeg');
      assert.ok(Number(payload.returned_elements) <= 20);
    });
  },
  S03: async (ctx) => {
    const { fixtureWindowId, command } = ctx;
    await runScenario('S03', 'compact state defaults and budget', 'observation', async () => {
      const payload = capturePayload(
        await command({
          action: 'capture',
          window_id: fixtureWindowId,
          max_elements: 12,
        })
      );
      assert.equal(payload.mode, 'state');
      assert.ok(Number(payload.returned_elements) <= 12);
      assert.equal(payload.overlay_rendered, undefined);
    });
  },
  S04: async (ctx) => {
    const { blackWindowId, command } = ctx;
    await runScenario('S04', 'black pixel frame fails closed', 'pixel-quality', async () => {
      const capture = await command({ action: 'capture', window_id: blackWindowId, max_elements: 20 });
      const payload = capturePayload(capture);
      assert.equal(payload.pixel_status, 'unavailable');
      assert.equal(payload.pixel_unavailable?.code, 'pixel_unavailable');
      assert.equal(payload.frame_id, undefined);
      assert.equal(capture.image, undefined);
      assert.equal(payload.ok, (payload.elements?.length || 0) > 0);
    });
  },
  S05: async (ctx) => {
    const { whiteWindowId, command } = ctx;
    await runScenario('S05', 'white pixel frame fails closed', 'pixel-quality', async () => {
      const capture = await command({ action: 'capture', window_id: whiteWindowId, max_elements: 20 });
      const payload = capturePayload(capture);
      assert.equal(payload.pixel_status, 'unavailable');
      assert.equal(payload.pixel_unavailable?.code, 'pixel_unavailable');
      assert.equal(payload.frame_id, undefined);
      assert.equal(capture.image, undefined);
      assert.equal(payload.ok, (payload.elements?.length || 0) > 0);
    });
  },
  S24: async (ctx) => {
    const { denseWindowId, command } = ctx;
    await runScenario('S24', 'dense Chromium accessibility stays bounded', 'stress', async () => {
      assert.ok(ctx.denseFixture && denseWindowId);
      const capture = capturePayload(
        await command(
          {
            action: 'capture',
            window_id: denseWindowId,
            max_elements: 40,
          },
          'dense-accessibility'
        )
      );
      assert.equal(capture.pixel_status, 'available');
      assert.ok(capture.frame_id);
      assert.ok(Number(capture.returned_elements) <= 40);
      assert.ok(
        (capture.elements || []).some((element) => element.name?.startsWith('Dense Control')),
        JSON.stringify(capture.elements)
      );
      const continuation = String(capture.continuation || '');
      assert.ok(continuation, JSON.stringify(capture));
      const nextPage = capturePayload(
        await command(
          {
            action: 'capture',
            window_id: denseWindowId,
            max_elements: 40,
            continuation,
          },
          'dense-accessibility'
        )
      );
      assert.ok(Number(nextPage.returned_elements) <= 40);
      assert.ok((nextPage.elements || []).length > 0, JSON.stringify(nextPage));
      await assert.rejects(
        command(
          {
            action: 'capture',
            window_id: denseWindowId,
            max_elements: 40,
            continuation,
          },
          'dense-accessibility'
        ),
        /continuation is stale or incompatible/
      );
      const malformedFirstPage = capturePayload(
        await command(
          {
            action: 'capture',
            window_id: denseWindowId,
            max_elements: 40,
          },
          'dense-accessibility-malformed'
        )
      );
      const malformedParts = String(malformedFirstPage.continuation || '').split(':');
      assert.equal(malformedParts.length, 4, JSON.stringify(malformedFirstPage));
      malformedParts[1] = String(Number(malformedParts[3]) + 1);
      await assert.rejects(
        command(
          {
            action: 'capture',
            window_id: denseWindowId,
            max_elements: 40,
            continuation: malformedParts.join(':'),
          },
          'dense-accessibility-malformed'
        ),
        /continuation is stale or incompatible/
      );
      const tamperedFirstPage = capturePayload(
        await command(
          {
            action: 'capture',
            window_id: denseWindowId,
            max_elements: 40,
          },
          'dense-accessibility-tampered'
        )
      );
      const tamperedParts = String(tamperedFirstPage.continuation || '').split(':');
      assert.equal(tamperedParts.length, 4, JSON.stringify(tamperedFirstPage));
      tamperedParts[1] = tamperedParts[1] === '1' ? '2' : '1';
      await assert.rejects(
        command(
          {
            action: 'capture',
            window_id: denseWindowId,
            max_elements: 40,
            continuation: tamperedParts.join(':'),
          },
          'dense-accessibility-tampered'
        ),
        /continuation is stale or incompatible/
      );
    });
  },
  S25: async (ctx) => {
    const { denseWindowId, command } = ctx;
    await runScenario('S25', 'minimized exact target is available or fails closed', 'stress', async () => {
      assert.ok(ctx.denseFixture && denseWindowId);
      try {
        ctx.denseFixture.minimize();
        await new Promise((resolve) => setTimeout(resolve, 120));
        const result = await command(
          {
            action: 'capture',
            window_id: denseWindowId,
            max_elements: 40,
          },
          'minimized-target'
        );
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
      } finally {
        if (ctx.denseFixture && !ctx.denseFixture.isDestroyed()) {
          ctx.denseFixture.restore();
          ctx.denseFixture.showInactive();
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
    });
  },
  S27: async (ctx) => {
    const { fixtureWindowId, command } = ctx;
    await runScenario('S27', 'diagnostics report Windows OCR and accessibility readiness', 'diagnostics', async () => {
      const diagnostics = actionPayload(
        await command(
          {
            action: 'diagnose',
            window_id: fixtureWindowId,
            ocr_language: 'ko',
          },
          'diagnostics'
        )
      );
      const capabilities = diagnostics.capabilities as
        | {
            semantic_accessibility?: { available?: boolean };
            ocr?: { available?: boolean; installed_languages?: string[] };
            input_observation?: { input_held?: boolean };
          }
        | undefined;
      // Readiness folds in foreground availability, which the user's own hand on
      // the mouse legitimately withholds. That is an environment state, not a
      // diagnostics defect, so it must not be recorded as a failing scenario.
      if (diagnostics.ready !== true && capabilities?.input_observation?.input_held === true) {
        throw new ScenarioSkip('diagnose reports physical input held by the user; foreground readiness is withheld');
      }
      assert.equal(diagnostics.ready, true, JSON.stringify(diagnostics));
      assert.equal(capabilities?.semantic_accessibility?.available, true, JSON.stringify(diagnostics));
      assert.equal(capabilities?.ocr?.available, true, JSON.stringify(diagnostics));
      assert.ok(
        capabilities?.ocr?.installed_languages?.some((language) => /^ko(?:-|$)/i.test(language)),
        JSON.stringify(diagnostics)
      );
    });
  },
  S31: async (ctx) => {
    const { fixtureWindowId, command } = ctx;
    await runScenario('S31', 'a frame can answer beside the run instead of in the reply', 'efficiency', async () => {
      try {
        const inline = await command(
          {
            action: 'capture',
            window_id: fixtureWindowId,
            max_elements: 20,
          },
          'frame-output'
        );
        assert.ok(inline.image?.data, inline.text);
        const inlinePayload = capturePayload(inline);
        const zoomRegion = [
          0,
          0,
          Math.min(256, Number(inlinePayload.width)),
          Math.min(192, Number(inlinePayload.height)),
        ];
        const zoomed = await command(
          {
            action: 'zoom',
            frame_id: inlinePayload.frame_id,
            region: zoomRegion,
          },
          'frame-output'
        );
        assert.equal(zoomed.image?.mimeType, 'image/jpeg', zoomed.text);
        assert.match(zoomed.text, /frame_id=frame-\d+/);
        await assert.rejects(
          command(
            {
              action: 'zoom',
              frame_id: inlinePayload.frame_id,
              region: zoomRegion,
            },
            'frame-output'
          ),
          /stale_frame: unknown frame_id/
        );
        const filed = await command(
          {
            action: 'capture',
            window_id: fixtureWindowId,
            max_elements: 20,
            image_output: 'file',
          },
          'frame-output'
        );
        assert.equal(filed.image, undefined, filed.text);
        const payload = capturePayload(filed);
        const stored = payload.image_file;
        assert.ok(stored?.path, filed.text);
        const written = readFileSync(String(stored.path));
        assert.equal(written.length, stored.bytes, JSON.stringify(stored));
        assert.ok(written.length > 1_000, JSON.stringify(stored));
        // The reply still describes the frame, so the agent can act on marks
        // and coordinates without ever seeing the pixels.
        assert.ok(payload.frame_id, filed.text);
        assert.equal(payload.pixel_status, 'available', filed.text);
        assert.ok(Number(payload.width) > 0 && Number(payload.height) > 0, filed.text);
        // The same switch governs the observation a mutation returns. The
        // canvas moves without moving its tree, so that frame is kept — and
        // with this switch it is kept on disk instead of in the reply.
        const marked = capturePayload(
          await command(
            {
              action: 'capture',
              window_id: fixtureWindowId,
              mode: 'som',
              include_ocr: true,
              max_elements: 40,
            },
            'frame-output'
          )
        );
        const clicked = await command(
          {
            action: 'click',
            element: ocrMark(marked, 'SEND'),
            delivery: 'background',
            capture_after_image_output: 'file',
          },
          'frame-output'
        );
        assert.equal(clicked.image, undefined, clicked.text);
        const after = actionPayload(clicked).capture_after as CapturePayload;
        assert.ok(after?.image_file?.path, clicked.text);
        assert.ok(readFileSync(String(after.image_file?.path)).length > 1_000, clicked.text);
      } finally {
        await command({ action: 'session_release' }, 'frame-output');
      }
    });
  },
  S40: async (ctx) => {
    const { fixtureWindowId, command, windows } = ctx;
    await runScenario(
      'S40',
      'verify skips trees for title and proves a closed exact window',
      'verification',
      async () => {
        const sessionId = 'verify-window-lifecycle';
        const disposable = new BrowserWindow({
          width: 360,
          height: 220,
          show: true,
          title: 'Mixdog Verify Closed Fixture',
        });
        windows.push(disposable);
        try {
          await disposable.loadURL(
            'data:text/html,<meta charset="utf-8"><title>Mixdog Verify Closed Fixture</title><body>VERIFY</body>'
          );
          disposable.showInactive();
          const title = actionPayload(
            await command(
              {
                action: 'verify',
                window_id: fixtureWindowId,
                expect: [{ title_contains: 'Scenario Renderer' }],
                // Two stable samples need room for a slow accessibility read: a
                // budget that only fits one sample tests the machine, not verify.
                timeout_ms: 5_000,
              },
              sessionId
            )
          );
          assert.equal(title.decision, 'satisfied', JSON.stringify(title));
          assert.equal(title.observed_elements, 0, JSON.stringify(title));

          const listed = await command({ action: 'list_windows' }, sessionId);
          const closedWindowId =
            listed.text
              .split(/\r?\n/)
              .find((line) => line.includes('"Mixdog Verify Closed Fixture"'))
              ?.match(/^(hwnd:0x[0-9a-f]+)/i)?.[1] || '';
          assert.ok(closedWindowId, listed.text);
          disposable.destroy();
          const closed = actionPayload(
            await command(
              {
                action: 'verify',
                window_id: closedWindowId,
                expect: [{ window_exists: false }],
                timeout_ms: 5_000,
              },
              sessionId
            )
          );
          assert.equal(closed.decision, 'satisfied', JSON.stringify(closed));
          assert.equal(closed.observed_elements, 0, JSON.stringify(closed));
        } finally {
          if (!disposable.isDestroyed()) disposable.destroy();
          await command({ action: 'session_release' }, sessionId);
        }
      }
    );
  },
  S44: async (ctx) => {
    const { blackWindowId, command, windows } = ctx;
    await runScenario('S44', 'post-action vision capture preserves pixel failure', 'pixel-quality', async () => {
      const sessionId = 'post-action-pixel-failure';
      const blackFixture = windows.find(
        (window) => !window.isDestroyed() && window.getTitle() === 'Mixdog Black Frame Fixture'
      );
      assert.ok(blackFixture);
      const originalBounds = blackFixture.getBounds();
      try {
        const moved = actionPayload(
          await command(
            {
              action: 'move_window',
              window_id: blackWindowId,
              x: originalBounds.x + 1,
              y: originalBounds.y,
              width: originalBounds.width,
              height: originalBounds.height,
              capture_after_mode: 'vision',
            },
            sessionId
          )
        );
        const after = moved.capture_after as CapturePayload;
        assert.equal(after.ok, false, JSON.stringify(moved));
        assert.equal(after.pixel_status, 'unavailable', JSON.stringify(moved));
        assert.equal(moved.escalation, 'recapture', JSON.stringify(moved));
        assert.equal((moved.verdict as Record<string, unknown>)?.recommended, 'recapture', JSON.stringify(moved));
        await assert.rejects(
          command(
            {
              action: 'type',
              window_id: blackWindowId,
              text: 'FAILED-POST-CAPTURE-MUST-NOT-TYPE',
              delivery: 'background',
            },
            sessionId
          ),
          /requires a fresh capture/
        );
      } finally {
        blackFixture.setBounds(originalBounds);
        await command({ action: 'session_release' }, sessionId);
      }
    });
  },
};
