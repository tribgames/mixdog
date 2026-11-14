/**
 * Real-Electron check of `host/capture/fileSnapshot`: the offscreen render, not
 * a fake. A real HTML file and image are captured through the host handler and,
 * on an independent service with its own cache, through the window process's
 * direct call (`capture`, what `index.ts` ran before the host method). Both
 * render for real, so the pictures must be byte-identical; failures must carry
 * the same message.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, nativeImage } from 'electron';
import { createFileSnapshotService, renderFileSnapshot } from '../file-snapshot';
import { registerFilesHost } from '../host/files';
import { projectEntryPathIn } from '../project-entry-path';

const log = process.env.MIXDOG_BROWSER_INTEGRATION_LOG || '';
const progress = (message: string) => log && appendFileSync(log, `${message}\n`);
const profile = mkdtempSync(join(tmpdir(), 'mixdog-file-snapshot-host-'));
process.env.MIXDOG_DATA_DIR = join(profile, 'data');
app.setPath('userData', join(profile, 'user-data'));
app.disableHardwareAcceleration();

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function run(): Promise<void> {
  const root = join(profile, 'project');
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(
    join(root, 'site', 'index.html'),
    '<!doctype html><title>t</title><body style="margin:0;background:#2a6"><h1 style="color:#fff">Snapshot</h1><img src="pic.png" width="64" height="64"></body>'
  );
  writeFileSync(join(root, 'site', 'pic.png'), PIXEL_PNG);
  writeFileSync(join(root, 'notes.txt'), 'text');

  const service = () => createFileSnapshotService({ confine: projectEntryPathIn, render: renderFileSnapshot });
  const nodeSide = service();
  const hostSide = service();
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  registerFilesHost(
    {
      request: async () => ({}),
      notify: () => undefined,
      sendBinary: () => undefined,
      handleRequest: (method, handler) => void handlers.set(method, (params) => handler(params, new AbortController().signal)),
      handleNotification: () => undefined,
      servedMethods: () => [],
      onClose: () => undefined,
    },
    () => ({
      captureFileSnapshot: (r, rel, grant) => hostSide.capture(r, rel, grant),
      localPageUrl: async () => '',
      trashItem: async () => undefined,
    })
  );
  const hostCall = handlers.get('host/capture/fileSnapshot')!;
  const outcome = async (work: () => Promise<unknown>) => {
    try {
      return { ok: true as const, value: (await work()) as { dataUrl: string; mtimeMs: number; size: number } };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  };

  const steps: Array<[string, string, string, boolean]> = [
    ['html', root, 'site/index.html', false],
    ['granted-image', join(root, 'site'), 'pic.png', true],
    ['unsupported-type', root, 'notes.txt', false],
    ['missing', root, 'site/gone.html', false],
    ['outside-root', root, '../secret.html', false],
  ];
  for (const [name, r, rel, grant] of steps) {
    const fromNode = await outcome(() => nodeSide.capture(r, rel, grant));
    const fromHost = await outcome(() => hostCall({ root: r, rel, grant }));
    assert.equal(fromHost.ok, fromNode.ok, `${name}: outcome differs`);
    if (fromNode.ok && fromHost.ok) {
      assert.deepEqual(fromHost.value, fromNode.value, `${name}: host snapshot differs from the window process`);
      const [header, data] = fromNode.value.dataUrl.split(',');
      assert.match(header, /^data:image\/(png|jpeg);base64$/, `${name}: not an image data URL`);
      const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
      const { width, height } = image.getSize();
      assert.ok(width > 0 && width <= 640 && height > 0, `${name}: picture is ${width}x${height}`);
      progress(`${name}: identical ${width}x${height} (${fromNode.value.dataUrl.length} chars)`);
    } else if (!fromNode.ok && !fromHost.ok) {
      assert.equal(fromHost.error, fromNode.error, `${name}: failure message differs`);
      progress(`${name}: identical failure "${fromNode.error}"`);
    }
  }
}

// The render window is destroyed after every snapshot; the app must outlive it.
app.on('window-all-closed', () => undefined);
void app.whenReady().then(async () => {
  let failed: unknown;
  try {
    await run();
    progress('integration passed');
  } catch (error) {
    failed = error;
    progress(`failed: ${(error as Error).stack || error}`);
  }
  // The profile is under the scratch directory; Electron may still hold a file in it, so cleanup is bounded.
  await Promise.race([
    rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  app.exit(failed ? 1 : 0);
});
