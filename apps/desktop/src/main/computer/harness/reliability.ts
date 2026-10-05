import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { createComputerHost } from '../index';
import {
  authorizationLiveDispatch,
  electronBackgroundEdit,
  excelIsolatedWorkbookInput,
  explorerRename,
  nativeObservationSoak,
  wpfBackgroundEdit,
  wpfTextSurfaceRead,
  win32NativeBackgroundEdit,
  winui3BackgroundEdit,
  winuiForegroundInvoke,
} from './reliability-scenarios';
import {
  directory,
  eventually,
  payload,
  progress,
  readDiscovery,
  type ReliabilityContext,
  results,
  type ScenarioOutcome,
  ScenarioPrecondition,
  summary,
} from './reliability-support';

async function run() {
  await app.whenReady();
  app.setAccessibilitySupportEnabled(true);
  const host = createComputerHost();
  const sentinel = new BrowserWindow({
    width: 640,
    height: 420,
    title: 'Mixdog Reliability Fixture',
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  await sentinel.loadURL(
    'data:text/html,<title>Mixdog Reliability Fixture</title><label>Fixture editor<input aria-label="Fixture editor" value="fixture"></label>'
  );
  sentinel.show();
  const dataDir = process.env.MIXDOG_DATA_DIR;
  if (!dataDir) throw new Error('MIXDOG_DATA_DIR is required');
  const discovery = await readDiscovery(join(dataDir, 'computer-bridge.json'), 45_000);
  const command = async (input: Record<string, unknown>, session = 'reliability') => {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
      method: 'POST',
      headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, session_id: session }),
      signal: AbortSignal.timeout(45_000),
    });
    const result = (await response.json()) as { ok?: boolean; error?: string; value?: { text: string } };
    if (!result.ok) throw new Error(result.error);
    return result.value as { text: string };
  };
  const ownedWindow = async (pid: number) => {
    const windows = await eventually(
      () => host.authorizationWindows(),
      (candidates) => candidates.some((window) => window.pid === pid)
    );
    const owned = windows.find((window) => window.pid === pid);
    if (!owned) throw new Error(`no authorized window belongs to pid ${pid}`);
    return owned;
  };
  const edit = async (id: string, name: string, value: string) => {
    const capture = payload(await command({ action: 'capture', window_id: id, max_elements: 100, include_ocr: false }));
    id = capture.window_id ?? id;
    const target = capture.elements?.find((element) => element.name === name && element.ref);
    assert.ok(target?.ref, `fixture editor missing; ${summary(capture)}`);
    const result = payload(
      await command({
        action: 'set_value',
        window_id: id,
        ref: target.ref,
        text: value,
        delivery: 'background',
        capture_after: true,
        include_ocr: false,
      })
    );
    assert.equal(result.ok, true, summary(result));
    return result;
  };
  // The window standing in for the user's must actually hold the foreground,
  // or a foreground check afterwards measures the desktop instead of Mixdog.
  const holdForeground = async (windowId: string, session: string) => {
    await command({ action: 'focus_window', window_id: windowId }, session);
    const line =
      (await command({ action: 'list_windows' }, session)).text
        .split(/\r?\n/)
        .find((entry) => / focused(\s|$)/.test(entry)) || '';
    if (!line.toLowerCase().startsWith(windowId.toLowerCase())) {
      throw new ScenarioPrecondition(
        `the user window could not take the foreground; it is held by: ${line || 'no listed window'}`
      );
    }
  };
  const scenario = async (name: string, operation: () => Promise<unknown>) => {
    const only = process.env.MIXDOG_RELIABILITY_ONLY?.split('|');
    if (only?.length && !only.includes(name)) return;
    progress(`START ${name}`);
    const start = performance.now();
    try {
      const details = await operation();
      results.push({
        name,
        status: 'passed',
        ms: Math.round(performance.now() - start),
        ...(details as ScenarioOutcome),
      });
    } catch (error) {
      const skipped = error instanceof ScenarioPrecondition;
      results.push({
        name,
        status: skipped ? 'skipped' : 'failed',
        [skipped ? 'reason' : 'error']: String((error as Error).message),
        ms: Math.round(performance.now() - start),
      });
    } finally {
      await host.stopAllSessions();
      sentinel.show();
      sentinel.focus();
      progress(`END ${name} ${String(results.at(-1)?.status)}`);
    }
  };
  const ctx: ReliabilityContext = { host, sentinel, command, ownedWindow, edit, holdForeground };
  try {
    await scenario('Electron background edit', () => electronBackgroundEdit(ctx));
    await scenario('Win32 native background edit', () => win32NativeBackgroundEdit(ctx));
    await scenario('WPF background edit', () => wpfBackgroundEdit(ctx));
    await scenario('WPF text surface read', () => wpfTextSurfaceRead(ctx));
    const winuiPath = process.env.MIXDOG_WINUI3_FIXTURE;
    if (!winuiPath)
      results.push({
        name: 'WinUI3 background edit',
        status: 'skipped',
        reason: 'MIXDOG_WINUI3_FIXTURE is not configured; requires the dedicated WinUI3 fixture executable',
      });
    else await scenario('WinUI3 background edit', () => winui3BackgroundEdit(ctx, winuiPath));
    await scenario('Office Excel isolated workbook input', () => excelIsolatedWorkbookInput(ctx));
    await scenario('Native observation soak', () => nativeObservationSoak(ctx));
    await scenario('WinUI background invoke keeps the foreground', () => winuiForegroundInvoke(ctx));
    await scenario('Explorer rename touches only its own item', () => explorerRename(ctx));
    await scenario('Authorization live dispatch', () => authorizationLiveDispatch(ctx));
  } finally {
    await host.stopAllSessions();
    await host.dispose();
    sentinel.destroy();
    writeFileSync(
      join(directory, 'report.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          scope: 'dedicated fixture windows only; no user app mutation',
          results,
        },
        null,
        2
      )
    );
  }
}
run()
  .then(() => app.exit(results.some((result) => result.status === 'failed') ? 1 : 0))
  .catch((error) => {
    progress(String(error?.stack || error));
    writeFileSync(
      join(directory, 'report.json'),
      JSON.stringify({ results: [...results, { name: 'harness', status: 'failed', error: String(error) }] })
    );
    app.exit(1);
  });
