/**
 * Electron side of the browser core integration harness (see core-harness.md). A mixdogd the runner script started on an
 * isolated profile is dialled with the desktop's own protocol connection, this process claims the host role with a real
 * BrowserHost in a hidden window, and a suite drives the browser through the core (`browser/command`, forwarded as
 * `host/browser/command`) or through the engine hook (`test/browserEngine/run`).
 */
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, type WebContents, webContents } from 'electron';
import { HOST_CAPABILITIES } from '../../host/connection';
import { createComputerPresence } from '../../computer/presence/mirror';
import { createDesktopHost } from '../../host';
import { createProtocolConnection, type ProtocolConnection } from '../../protocol/connection';
import { readLocalDiscovery } from '../../protocol/discovery';
import { createHostConnection } from '../../protocol/host-connection';
import { openCore } from '../../protocol/open-core';
import { readyBrowserFrame } from '../harness-frame';
import { type BrowserHost, createBrowserHost } from '../host';

/** `host` is the path the host role serves today (the Electron browser host runs the tool); `core` runs it in the core's engine. */
export type CoreHarnessEngine = 'core' | 'host';

/** The environment the runner script hands this process. */
export const HARNESS_ENV = {
  runtimeRoot: 'MIXDOG_CORE_HARNESS_RUNTIME_ROOT',
  engine: 'MIXDOG_CORE_HARNESS_ENGINE',
  log: 'MIXDOG_BROWSER_INTEGRATION_LOG',
} as const;

/** The browser session every harness command runs in. */
export const HARNESS_SESSION = 'core-harness-session';

export interface CoreHarness {
  readonly engine: CoreHarnessEngine;
  /** The desktop's protocol connection to the core (`call(method, params)`, `client()`, events). */
  readonly client: ProtocolConnection;
  /** The host role that claimed the core (`createDesktopHost` result). */
  readonly host: ReturnType<typeof createDesktopHost>;
  readonly browserHost: BrowserHost;
  /** The page the harness session shows. */
  readonly guest: WebContents;
  /** One tool run through the engine hook; rejects with "engine hook absent" while the core has no `test/browserEngine/run`. */
  runTool(threadId: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** A UI-originated browser command: `browser/command`, forwarded by the core to this host. */
  uiCommand(action: string, input?: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<void>;
}

export type CoreHarnessSuite = (harness: CoreHarness) => Promise<void>;

const ENGINE_HOOK = 'test/browserEngine/run';
const HARNESS_HOST_ID = 'core-harness-host';

export function progress(message: string): void {
  const path = process.env[HARNESS_ENV.log];
  if (path) appendFileSync(path, `${message}\n`);
}

const isMethodNotFound = (error: unknown): boolean =>
  (error as { detail?: { data?: { reason?: unknown } } } | null)?.detail?.data?.reason === 'methodNotFound';

/** Needs Electron `ready`, `MIXDOG_DATA_DIR` and the app paths already pointed at a disposable profile. */
export async function startCoreHarness({ engine }: { engine: CoreHarnessEngine }): Promise<CoreHarness> {
  const runtimeRoot = process.env[HARNESS_ENV.runtimeRoot];
  if (!runtimeRoot) throw new Error(`${HARNESS_ENV.runtimeRoot} names the runtime root of the isolated core.`);

  const protocol = createProtocolConnection({
    open: openCore({
      resolve: () => readLocalDiscovery(runtimeRoot),
      version: app.getVersion(),
      capabilities: { approvalsInbox: true, host: HOST_CAPABILITIES },
    }),
  });
  let window: BrowserWindow | null = null;
  let browserHost: BrowserHost | null = null;
  const stop = async (): Promise<void> => {
    await browserHost?.dispose().catch(() => {});
    if (window && !window.isDestroyed()) window.destroy();
    await protocol.close().catch(() => {});
  };
  try {
    window = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true },
    });
    const created = createBrowserHost(window, {
      hostId: HARNESS_HOST_ID,
      remoteSession: false,
      requestApproval: async () => true,
    });
    browserHost = created;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>Harness shell</title>')}`);
    const frame = await readyBrowserFrame(created, HARNESS_SESSION);
    const guest = webContents.fromId(frame.webContentsId);
    if (!guest) throw new Error('The browser host created no page for the harness session.');
    created.setGuestActive(HARNESS_SESSION, guest.id, true);
    created.setBridgeEnabled(true);
    progress('browser host ready');

    const host = createDesktopHost({
      connection: createHostConnection(protocol),
      hostId: HARNESS_HOST_ID,
      browser: () => created.hostRole(),
      visualize: () => {
        throw new Error('The browser harness has no visualize service.');
      },
      files: () => {
        throw new Error('The browser harness has no file service.');
      },
      onVisualizePublishFailed: () => {},
      onBrowserViewFailed: (error) => progress(`browser view failed: ${String((error as Error)?.message ?? error)}`),
      resolveProxy: async () => 'DIRECT',
      // The browser harness drives no computer: no desktop computer host, and the environment reports are never bound.
      computer: {
        mirror: createComputerPresence({ notifyPointerReleased: () => {}, now: Date.now }),
        permissions: {
          read: () => ({
            screen_capture: 'not_required_on_windows',
            accessibility: 'not_required_on_windows',
            input: 'target_integrity_dependent',
          }),
          request: () => undefined,
        },
        environment: {
          ready: new Promise<never>(() => {}),
          sources: () => {
            throw new Error('The browser harness reports no desktop transitions.');
          },
        },
        desktopHostScreen: () => null,
        desktopHostCommand: () => null,
      },
      notifications: {
        createNotification: () => {
          throw new Error('The browser harness shows no notifications.');
        },
        activate: () => {},
        isSupported: () => false,
        idleSeconds: () => 0,
      },
      onUpdaterInstallFailed: () => {},
    });
    await protocol.start();
    progress('connected to the core');
    await host.claim();
    progress('host role claimed');

    return {
      engine,
      client: protocol,
      host,
      browserHost: created,
      guest,
      async runTool(threadId, tool, args) {
        try {
          return await protocol.call(ENGINE_HOOK, { threadId, tool, args, engine });
        } catch (error) {
          if (isMethodNotFound(error)) throw new Error('engine hook absent');
          throw error;
        }
      },
      uiCommand: (action, input = {}) =>
        protocol.call('browser/command', { action, input: { session_id: HARNESS_SESSION, ...input } }),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The whole Electron process of one run: profile, harness, suite, teardown, exit code. The runner reads the progress log. */
export function runCoreHarnessSuite(suite: CoreHarnessSuite): void {
  const profile = mkdtempSync(join(tmpdir(), 'mixdog-browser-core-profile-'));
  const dataDirectory = join(profile, 'data');
  mkdirSync(dataDirectory, { recursive: true });
  process.env.MIXDOG_DATA_DIR = dataDirectory;
  app.setPath('userData', join(profile, 'user-data'));
  app.disableHardwareAcceleration();
  progress('module loaded; profile configured');
  const engine: CoreHarnessEngine = process.env[HARNESS_ENV.engine] === 'core' ? 'core' : 'host';

  const run = async (): Promise<void> => {
    const harness = await startCoreHarness({ engine });
    try {
      await suite(harness);
    } finally {
      await harness.stop();
    }
  };
  void app
    .whenReady()
    .then(run)
    .then(async () => {
      progress('integration passed');
      await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
      app.exit(0);
    })
    .catch((error: unknown) => {
      progress(`integration failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      app.exit(1);
    });
}
