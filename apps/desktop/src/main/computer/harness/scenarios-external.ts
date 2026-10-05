import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capturePayload, actionPayload, ocrMark } from './scenario-ocr';
import { eventually, runScenario } from './scenario-runtime';
import type { ScenarioGroup } from './scenario-context';

export const externalScenarios: ScenarioGroup = {
  S19: async (ctx) => {
    const { command, externalStatePath, externalChild } = ctx;
    await runScenario('S19', 'external Electron background type is truthful', 'external-electron', async () => {
      try {
        const externalPid = externalChild?.pid;
        assert.ok(externalPid, 'external Electron process PID is unavailable');
        const externalLine = (text: string) =>
          text
            .split(/\r?\n/)
            .find(
              (line) =>
                /\|\s+app=electron\b/i.test(line) &&
                /Chrome_WidgetWin/i.test(line) &&
                (line.includes(`pid=${externalPid}`) ||
                  line.includes('"Electron"') ||
                  line.includes('"Mixdog External Electron Fixture"'))
            ) || '';
        const listed = await eventually(
          async () => (await command({ action: 'list_windows' }, 'external-type')).text,
          (text) => Boolean(externalLine(text)),
          30_000
        ).catch((error) => {
          let state = '';
          try {
            state = readFileSync(externalStatePath, 'utf8');
          } catch {
            state = '<missing>';
          }
          throw new Error(`${(error as Error).message}; external fixture state=${state}`);
        });
        const externalWindowId = externalLine(listed).match(/^(hwnd:0x[0-9a-f]+)/i)?.[1] || '';
        assert.ok(externalWindowId);
        const capture = capturePayload(
          await command(
            {
              action: 'capture',
              window_id: externalWindowId,
              mode: 'som',
              include_ocr: true,
              max_elements: 50,
            },
            'external-type'
          )
        );
        const typeMark = ocrMark(capture, 'TYPE');
        const typed = actionPayload(
          await command(
            {
              action: 'type',
              element: typeMark,
              text: 'EXTERNAL42',
              delivery: 'background',
            },
            'external-type'
          )
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
        const state = JSON.parse(readFileSync(externalStatePath, 'utf8')) as { value?: string };
        const semanticallyApplied = state.value === 'EXTERNAL42';
        const truthfulEscalation =
          typed.ok === false && ['foreground', 'browser_use'].includes(String(typed.escalation || ''));
        assert.ok(
          semanticallyApplied || truthfulEscalation,
          `background type claimed ${JSON.stringify(typed)} but external value remained ${JSON.stringify(state.value)}`
        );
      } finally {
        await command({ action: 'session_release' }, 'external-type');
      }
    });
  },
};
