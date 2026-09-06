import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { createComputerHost } from '../index';
import { compileNativeTextFixture } from '../backend/native-fixture';
import { startManagedFixture } from './reliability-fixtures';
import { createPolling } from '../../host-harness-poll';
import { diagnosticRecord } from '../session/failure-diagnostics';

const directory = process.env.MIXDOG_RELIABILITY_DIRECTORY!;
if (!directory || !isAbsolute(directory)) throw new Error('an explicit fixture directory is required');
mkdirSync(directory, { recursive: true });
app.setPath('userData', join(directory, 'profile'));
app.on('window-all-closed', () => {});
const results: Array<Record<string, unknown>> = [];
const { eventually, readDiscovery } = createPolling({ timeoutMs: 30_000, intervalMs: 150 });
const progress = (text: string) => appendFileSync(join(directory, 'progress.log'), `${text}\n`);
const payload = (value: { text: string }): any => JSON.parse(value.text);
const summary = (value: Record<string, unknown>) => JSON.stringify(diagnosticRecord(value));
const exited = (child: ChildProcess) => new Promise<void>((resolveExit) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
  child.once('exit', () => resolveExit());
});

async function run() {
  await app.whenReady();
  app.setAccessibilitySupportEnabled(true);
  const host = createComputerHost();
  const sentinel = new BrowserWindow({ width: 640, height: 420, title: 'Mixdog Reliability Fixture',
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await sentinel.loadURL('data:text/html,<title>Mixdog Reliability Fixture</title><label>Fixture editor<input aria-label="Fixture editor" value="fixture"></label>');
  sentinel.show();
  const discovery = await readDiscovery(join(process.env.MIXDOG_DATA_DIR!, 'computer-bridge.json'), 45_000);
  const command = async (input: Record<string, unknown>, session = 'reliability') => {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
      method: 'POST', headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, session_id: session }), signal: AbortSignal.timeout(45_000),
    });
    const result = await response.json() as any;
    if (!result.ok) throw new Error(result.error);
    return result.value as { text: string };
  };
  const ownedWindow = async (pid: number) => await eventually(
    () => host.authorizationWindows(),
    (windows) => windows.some((window) => window.pid === pid),
  ).then((windows) => windows.find((window) => window.pid === pid)!);
  const edit = async (id: string, name: string, value: string) => {
    const capture = payload(await command({ action: 'capture', window_id: id, max_elements: 100, include_ocr: false }));
    id = capture.window_id;
    const target = capture.elements?.find((element: any) => element.name === name && element.ref);
    assert.ok(target?.ref, `fixture editor missing; ${summary(capture)}`);
    const result = payload(await command({
      action: 'set_value', window_id: id, ref: target.ref, text: value, delivery: 'background',
      capture_after: true, include_ocr: false,
    }));
    assert.equal(result.ok, true, summary(result));
    return result;
  };
  const scenario = async (name: string, operation: () => Promise<void | Record<string, unknown>>) => {
    const only = process.env.MIXDOG_RELIABILITY_ONLY?.split('|');
    if (only?.length && !only.includes(name)) return;
    progress(`START ${name}`);
    const start = performance.now();
    try {
      const details = await operation();
      results.push({ name, status: 'passed', ms: Math.round(performance.now() - start), ...details });
    }
    catch (error) { results.push({ name, status: 'failed', error: String((error as Error).message), ms: Math.round(performance.now() - start) }); }
    finally {
      await host.stopAllSessions();
      sentinel.show(); sentinel.focus();
      progress(`END ${name} ${String(results.at(-1)?.status)}`);
    }
  };
  try {
    await scenario('Electron background edit', async () => {
      const id = `hwnd:0x${sentinel.getNativeWindowHandle().readBigUInt64LE().toString(16)}`;
      await edit(id, 'Fixture editor', 'ELECTRON42');
      assert.equal(await sentinel.webContents.executeJavaScript('document.querySelector("input").value'), 'ELECTRON42');
    });
    await scenario('Win32 native background edit', async () => {
      const child = spawn(compileNativeTextFixture(directory), [], { windowsHide: false });
      try {
        const target = await ownedWindow(child.pid!);
        const result = await edit(target.id, 'Native text editor', 'WIN3242');
        assert.ok(result.capture_after?.elements?.some((element: any) => element.value === 'WIN3242'));
        await command({ action: 'close_window', window_id: target.id });
        await exited(child);
      } finally { if (child.exitCode === null) { child.kill(); await exited(child); } }
    });
    await scenario('WPF background edit', async () => {
      const fixture = startManagedFixture('wpf', directory);
      try {
        const target = await ownedWindow(fixture.child.pid!);
        await edit(target.id, 'Fixture editor', 'WPF42');
        await eventually(async () => fixture.state(), (value) => value === 'WPF42');
      } finally { fixture.stop(); await exited(fixture.child); }
    });
    const winuiPath = process.env.MIXDOG_WINUI3_FIXTURE;
    if (!winuiPath) results.push({ name: 'WinUI3 background edit', status: 'skipped', reason: 'MIXDOG_WINUI3_FIXTURE is not configured; requires the dedicated WinUI3 fixture executable' });
    else await scenario('WinUI3 background edit', async () => {
      assert.ok(isAbsolute(winuiPath) && /\.exe$/i.test(winuiPath));
      const child = spawn(winuiPath, [], { windowsHide: false });
      try {
        const target = await ownedWindow(child.pid!);
        const result = await edit(target.id, 'Fixture editor', 'WINUI42');
        assert.ok(result.capture_after?.elements?.some((element: any) => element.value === 'WINUI42'));
      } finally { if (child.exitCode === null) { child.kill(); await exited(child); } }
    });
    await scenario('Office Excel isolated workbook input', async () => {
      const fixture = startManagedFixture('excel', directory);
      try {
        const id = await eventually(async () => fixture.windowId(), (value) => /^hwnd:0x/.test(value));
        const capture = payload(await command({ action: 'capture', window_id: id, include_ocr: false, max_elements: 400 }));
        const observedId = capture.window_id;
        const editor = capture.elements?.find((element: any) => element.value === 'fixture' && element.actions?.includes('set_value'));
        assert.ok(editor?.ref, 'Excel did not expose an editable value for the fixture cell');
        const typed = payload(await command({
          action: 'set_value', window_id: observedId, ref: editor.ref, text: 'OFFICE42', delivery: 'background', capture_after: true,
        }));
        assert.equal(typed.ok, true, summary(typed));
        await eventually(async () => fixture.state(), (value) => value === 'OFFICE42');
      } finally { fixture.stop(); await exited(fixture.child); }
    });
    await scenario('Native observation soak', async () => {
      const target = (await host.authorizationWindows()).find((window) => window.pid === process.pid)!;
      assert.ok(target);
      const capture = () => command({ action: 'capture', window_id: target.id, include_ocr: false, max_elements: 40 });
      await capture(); await capture();
      const expectedWorkers = host.residentWorkerPids().length;
      const durationMs = Math.max(10_000, Math.min(600_000, Number(process.env.MIXDOG_RELIABILITY_SOAK_MS) || 300_000));
      const started = performance.now();
      const samples: Array<{ seconds: number; privateKiB: number; workers: number }> = [];
      let commands = 0;
      let nextSample = 0;
      while (performance.now() - started < durationMs) {
        const observed = payload(await capture());
        assert.equal(observed.ok, true);
        assert.equal(observed.window_id, target.id);
        assert.equal(host.residentWorkerPids().length, expectedWorkers);
        commands++;
        const elapsed = performance.now() - started;
        if (elapsed >= nextSample) {
          const memory = await process.getProcessMemoryInfo();
          samples.push({ seconds: Math.round(elapsed / 1000), privateKiB: memory.private, workers: expectedWorkers });
          nextSample += 15_000;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      return { commands, durationMs: Math.round(performance.now() - started), samples };
    });
    await scenario('Authorization live dispatch', async () => {
      const previousValue = await sentinel.webContents.executeJavaScript('document.querySelector("input").value');
      const target = (await host.authorizationWindows()).find((window) => window.pid === process.pid)!;
      assert.ok(target);
      await host.updateAuthorization({
        version: 1, actions: ['capture'], windows: [{ id: target.id, pid: target.pid }],
        launchTargets: [], allowElevatedInput: false, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await command({ action: 'capture', window_id: target.id, include_ocr: false });
      await assert.rejects(command({ action: 'type', window_id: target.id, text: 'DENIED' }), /computer_policy_denied/);
      assert.equal(await sentinel.webContents.executeJavaScript('document.querySelector("input").value'), previousValue);
      assert.ok(host.readFailureDiagnostics().length > 0);
    });
  } finally {
    await host.stopAllSessions();
    await host.dispose();
    sentinel.destroy();
    writeFileSync(join(directory, 'report.json'), JSON.stringify({
      createdAt: new Date().toISOString(), scope: 'dedicated fixture windows only; no user app mutation',
      results,
    }, null, 2));
  }
}
run().then(() => app.exit(results.some((result) => result.status === 'failed') ? 1 : 0)).catch((error) => {
  progress(String(error?.stack || error));
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ results: [...results, { name: 'harness', status: 'failed', error: String(error) }] }));
  app.exit(1);
});
