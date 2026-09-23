import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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
/** The desktop cannot host the scenario (for example an elevated window holds
 *  the foreground no lower process may take), which is not a product failure. */
class ScenarioPrecondition extends Error {}
// Compiled once per run: a second compile over an executable a finished
// scenario still holds fails, so every scenario launches the same build.
let compiledNativeFixture = '';
const nativeFixturePath = () => (compiledNativeFixture ||= compileNativeTextFixture(directory));
const exited = (child: ChildProcess) =>
  new Promise<void>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
    child.once('exit', () => resolveExit());
  });

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
  const discovery = await readDiscovery(join(process.env.MIXDOG_DATA_DIR!, 'computer-bridge.json'), 45_000);
  const command = async (input: Record<string, unknown>, session = 'reliability') => {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
      method: 'POST',
      headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, session_id: session }),
      signal: AbortSignal.timeout(45_000),
    });
    const result = (await response.json()) as any;
    if (!result.ok) throw new Error(result.error);
    return result.value as { text: string };
  };
  const ownedWindow = async (pid: number) =>
    await eventually(
      () => host.authorizationWindows(),
      (windows) => windows.some((window) => window.pid === pid)
    ).then((windows) => windows.find((window) => window.pid === pid)!);
  const edit = async (id: string, name: string, value: string) => {
    const capture = payload(await command({ action: 'capture', window_id: id, max_elements: 100, include_ocr: false }));
    id = capture.window_id;
    const target = capture.elements?.find((element: any) => element.name === name && element.ref);
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
      throw new ScenarioPrecondition(`the user window could not take the foreground; it is held by: ${line || 'no listed window'}`);
    }
  };
  const scenario = async (name: string, operation: () => Promise<void | Record<string, unknown>>) => {
    const only = process.env.MIXDOG_RELIABILITY_ONLY?.split('|');
    if (only?.length && !only.includes(name)) return;
    progress(`START ${name}`);
    const start = performance.now();
    try {
      const details = await operation();
      results.push({ name, status: 'passed', ms: Math.round(performance.now() - start), ...details });
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
  try {
    await scenario('Electron background edit', async () => {
      const id = `hwnd:0x${sentinel.getNativeWindowHandle().readBigUInt64LE().toString(16)}`;
      await edit(id, 'Fixture editor', 'ELECTRON42');
      assert.equal(await sentinel.webContents.executeJavaScript('document.querySelector("input").value'), 'ELECTRON42');
    });
    await scenario('Win32 native background edit', async () => {
      const child = spawn(nativeFixturePath(), [], { windowsHide: false });
      try {
        const target = await ownedWindow(child.pid!);
        const result = await edit(target.id, 'Native text editor', 'WIN3242');
        assert.ok(result.capture_after?.elements?.some((element: any) => element.value === 'WIN3242'));
        await command({ action: 'close_window', window_id: target.id });
        await exited(child);
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await exited(child);
        }
      }
    });
    await scenario('WPF background edit', async () => {
      const fixture = startManagedFixture('wpf', directory);
      try {
        const target = await ownedWindow(fixture.child.pid!);
        await edit(target.id, 'Fixture editor', 'WPF42');
        await eventually(
          async () => fixture.state(),
          (value) => value === 'WPF42'
        );
      } finally {
        fixture.stop();
        await exited(fixture.child);
      }
    });
    await scenario('WPF text surface read', async () => {
      const fixture = startManagedFixture('wpf-document', directory);
      try {
        const target = await ownedWindow(fixture.child.pid!);
        const capture = payload(await command({ action: 'capture', window_id: target.id, max_elements: 40 }));
        const document = capture.elements?.find((element: any) => element.name === 'Fixture document');
        assert.match(String(document?.value ?? ''), /DOCUMENT_LINE_ONE\s+DOCUMENT_LINE_TWO/, summary(capture));
        const verified = payload(
          await command({
            action: 'verify',
            window_id: target.id,
            expect: [{ present: 'DOCUMENT_LINE_TWO' }, { absent: 'DOCUMENT_LINE_THREE' }],
            timeout_ms: 3_000,
          })
        );
        assert.equal(verified.decision, 'satisfied', summary(verified));
      } finally {
        fixture.stop();
        await exited(fixture.child);
      }
    });
    const winuiPath = process.env.MIXDOG_WINUI3_FIXTURE;
    if (!winuiPath)
      results.push({
        name: 'WinUI3 background edit',
        status: 'skipped',
        reason: 'MIXDOG_WINUI3_FIXTURE is not configured; requires the dedicated WinUI3 fixture executable',
      });
    else
      await scenario('WinUI3 background edit', async () => {
        assert.ok(isAbsolute(winuiPath) && /\.exe$/i.test(winuiPath));
        const child = spawn(winuiPath, [], { windowsHide: false });
        try {
          const target = await ownedWindow(child.pid!);
          const result = await edit(target.id, 'Fixture editor', 'WINUI42');
          assert.ok(result.capture_after?.elements?.some((element: any) => element.value === 'WINUI42'));
        } finally {
          if (child.exitCode === null) {
            child.kill();
            await exited(child);
          }
        }
      });
    await scenario('Office Excel isolated workbook input', async () => {
      const fixture = startManagedFixture('excel', directory);
      try {
        const id = await eventually(
          async () => fixture.windowId(),
          (value) => /^hwnd:0x/.test(value)
        );
        const capture = payload(
          await command({ action: 'capture', window_id: id, include_ocr: false, max_elements: 400 })
        );
        const observedId = capture.window_id;
        // Excel echoes a UIA value write to a cell on every later read while
        // the sheet keeps its value, so the cell must not offer set_value and a
        // write must be refused rather than confirmed.
        const cell = capture.elements?.find((element: any) => element.role === 'DataItem' && element.value === 'fixture');
        assert.ok(cell?.ref, summary(capture));
        assert.equal(cell.actions?.includes('set_value'), false, summary(capture));
        const refused = payload(
          await command({
            action: 'set_value',
            window_id: observedId,
            ref: cell.ref,
            text: 'OFFICE42',
            delivery: 'background',
          })
        );
        assert.equal(refused.code, 'value_write_ignored', summary(refused));
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        assert.equal(fixture.state(), 'fixture');
      } finally {
        fixture.stop();
        await exited(fixture.child);
      }
    });
    await scenario('Native observation soak', async () => {
      const target = (await host.authorizationWindows()).find((window) => window.pid === process.pid)!;
      assert.ok(target);
      const capture = () => command({ action: 'capture', window_id: target.id, include_ocr: false, max_elements: 40 });
      await capture();
      await capture();
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
        // A leak grows the pool; a worker this loop never uses may still be
        // reclaimed once it has idled past the reclaim interval.
        const workers = host.residentWorkerPids().length;
        assert.ok(workers <= expectedWorkers, `resident workers grew from ${expectedWorkers} to ${workers}`);
        commands++;
        const elapsed = performance.now() - started;
        if (elapsed >= nextSample) {
          const memory = await process.getProcessMemoryInfo();
          samples.push({ seconds: Math.round(elapsed / 1000), privateKiB: memory.private, workers });
          nextSample += 15_000;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      return { commands, durationMs: Math.round(performance.now() - started), samples };
    });
    await scenario('WinUI background invoke keeps the foreground', async () => {
      // Paint is a packaged WinUI 3 app that raises itself when its controls
      // are invoked; the sentinel stands in for the window the user works in.
      // The user's window must belong to another process: Windows lets an app
      // raise itself over this host's own windows less readily than over the
      // app the user actually works in, which hid the steal from an in-process
      // sentinel.
      const user = spawn(nativeFixturePath(), [], { windowsHide: false });
      const userWindow = await ownedWindow(user.pid!);
      const launched = payload(await command({ action: 'launch', app: 'mspaint.exe' }, 'winui-foreground'));
      const paintId = String(launched.window_transition?.next_target?.id || '');
      if (!paintId) {
        user.kill();
        return { note: 'Paint is not installed; nothing to measure' };
      }
      const focusedWindow = async () =>
        String(
          (await command({ action: 'list_windows' }, 'winui-foreground')).text
            .split(/\r?\n/)
            .find((line) => / focused(\s|$)/.test(line))
            ?.match(/^(hwnd:0x[0-9a-f]+)/i)?.[1] || ''
        ).toLowerCase();
      try {
        await holdForeground(userWindow.id, 'winui-user');
        // A posted click never reaches a WinUI island, so a frame point is
        // refused before anything is sent instead of reporting delivery.
        const framed = payload(
          await command({ action: 'capture', window_id: paintId, mode: 'state', max_elements: 200 }, 'winui-foreground')
        );
        const framedSwatch = framed.elements?.filter(
          (element: any) => element.role === 'ListItem' && element.actions?.includes('invoke')
        )[3];
        assert.ok(framedSwatch?.bounds, summary(framed));
        const [left, top, width, height] = framedSwatch.bounds as number[];
        const refused = payload(
          await command(
            {
              action: 'click',
              window_id: paintId,
              frame_id: framed.frame_id,
              x: Math.round(left + width / 2),
              y: Math.round(top + height / 2),
              delivery: 'background',
            },
            'winui-foreground'
          )
        );
        assert.equal(refused.code, 'background_unsupported', summary(refused));
        const capture = payload(
          await command({ action: 'capture', window_id: paintId, mode: 'ax', max_elements: 200 }, 'winui-foreground')
        );
        // Locale-free: a palette swatch, which Paint invokes by raising itself.
        // The fourth one is never the current colour of a fresh canvas.
        const swatch = capture.elements?.filter(
          (element: any) => element.role === 'ListItem' && element.actions?.includes('invoke')
        )[3];
        assert.ok(swatch?.ref, summary(capture));
        const acted = payload(
          await command(
            { action: 'click', window_id: paintId, ref: swatch.ref, delivery: 'background', capture_after: true },
            'winui-foreground'
          )
        );
        assert.equal(acted.ok, true, summary(acted));
        // The current colour is a radio button named after its colour.
        const radios = (value: any) =>
          (value.elements || [])
            .filter((element: any) => element.role === 'RadioButton')
            .map((element: any) => element.name)
            .join('|');
        const recaptured = payload(
          await command({ action: 'capture', window_id: paintId, mode: 'ax', max_elements: 200 }, 'winui-foreground')
        );
        assert.notEqual(radios(recaptured), radios(capture), `the swatch changed nothing; ${summary(acted)}`);
        // A late self-activation lands within tens of milliseconds; give it time.
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        assert.equal(await focusedWindow(), userWindow.id.toLowerCase(), 'the background toggle took the foreground');
      } finally {
        // Nothing was drawn, so the untouched canvas closes without a prompt.
        await command({ action: 'close_window', window_id: paintId }, 'winui-foreground').catch(() => {});
        user.kill();
        await exited(user);
      }
    });
    await scenario('Explorer rename touches only its own item', async () => {
      // Explorer writes a name cell to every selected item: with two files
      // selected, renaming one once renamed both.
      const folder = join(directory, `explorer-rename-${Date.now()}`);
      mkdirSync(folder);
      writeFileSync(join(folder, 'alpha.txt'), 'alpha');
      writeFileSync(join(folder, 'beta.txt'), 'beta');
      const user = spawn(nativeFixturePath(), [], { windowsHide: false });
      const userWindow = await ownedWindow(user.pid!);
      spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' }).unref();
      const leaf = folder.split(/[\\/]/).pop()!;
      const explorerId = await eventually(
        async () =>
          (await command({ action: 'list_windows' }, 'explorer-rename')).text
            .split(/\r?\n/)
            .find((line) => line.includes(`"${leaf}`))
            ?.match(/^(hwnd:0x[0-9a-f]+)/i)?.[1] || '',
        Boolean
      );
      try {
        const listed = payload(
          await command({ action: 'capture', window_id: explorerId, mode: 'ax', query: '.txt', max_elements: 20 }, 'explorer-rename')
        );
        const items = (listed.elements || []).filter((element: any) => element.role === 'ListItem');
        assert.equal(items.length, 2, summary(listed));
        // Select both, as a person's ctrl-click would, then rename only beta.
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            [
              'Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes',
              '$AE = [System.Windows.Automation.AutomationElement]',
              `$root = $AE::FromHandle([IntPtr]::new(${Number.parseInt(explorerId.replace(/^hwnd:0x/i, ''), 16)}))`,
              '$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)',
              "foreach ($item in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) { if ($item.Current.Name -like '*.txt') { $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).AddToSelection() } }",
            ].join('; '),
          ],
          { windowsHide: true, timeout: 20_000 }
        );
        await holdForeground(userWindow.id, 'explorer-user');
        const fresh = payload(
          await command({ action: 'capture', window_id: explorerId, mode: 'ax', query: 'beta', max_elements: 10 }, 'explorer-rename')
        );
        const nameCell = (fresh.elements || []).find(
          (element: any) => element.role === 'Edit' && String(element.value) === 'beta.txt'
        );
        assert.ok(nameCell?.ref, summary(fresh));
        await command(
          { action: 'set_value', window_id: explorerId, ref: nameCell.ref, text: 'beta-renamed.txt', delivery: 'background' },
          'explorer-rename'
        );
        await eventually(
          async () => readdirSync(folder).sort().join(','),
          (names) => names === 'alpha.txt,beta-renamed.txt'
        );
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        const focused = (await command({ action: 'list_windows' }, 'explorer-user')).text
          .split(/\r?\n/)
          .find((line) => / focused(\s|$)/.test(line));
        // Explorer raises itself as the rename starts; the user's window is restored.
        assert.ok(focused?.startsWith(userWindow.id), `the rename took the foreground: ${focused}`);
      } finally {
        await command({ action: 'close_window', window_id: explorerId }, 'explorer-rename').catch(() => {});
        user.kill();
        await exited(user);
      }
    });
    await scenario('Authorization live dispatch', async () => {
      const previousValue = await sentinel.webContents.executeJavaScript('document.querySelector("input").value');
      const target = (await host.authorizationWindows()).find((window) => window.pid === process.pid)!;
      assert.ok(target);
      await host.updateAuthorization({
        version: 1,
        actions: ['capture'],
        windows: [{ id: target.id, pid: target.pid }],
        launchTargets: [],
        allowElevatedInput: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await command({ action: 'capture', window_id: target.id, include_ocr: false });
      await assert.rejects(command({ action: 'type', window_id: target.id, text: 'DENIED' }), /computer_policy_denied/);
      assert.equal(
        await sentinel.webContents.executeJavaScript('document.querySelector("input").value'),
        previousValue
      );
      assert.ok(host.readFailureDiagnostics().length > 0);
    });
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
