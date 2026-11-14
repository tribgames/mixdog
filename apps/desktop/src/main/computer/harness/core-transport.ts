/**
 * How the Computer Use harnesses reach the product: a real `mixdogd` (started by `scripts/computer-core-runner.mjs` on an
 * isolated profile, with the test hooks on) is dialled with the desktop's own protocol connection, this Electron process claims
 * the host role the way the desktop does (the same `host/computer/*` handlers, the presence mirror the overlay draws from), and a
 * harness command is one `dev/computer/run` call. The fixtures (windows, clipboard) stay in this process; everything the helper
 * does to them is done by the core's helper pool.
 *
 * `createCommandTransport` needs nothing of Electron (it takes the protocol call), so its tests run in plain Node;
 * `openComputerCore` loads the Electron side when it is called.
 */
import type { CommandResult } from './scenario-types';

/** The runtime root of the isolated core the runner started, handed to the Electron process. */
export const COMPUTER_CORE_RUNTIME_ROOT = 'MIXDOG_COMPUTER_CORE_RUNTIME_ROOT';

/** The bridge's per-command wait the scenarios were written against. */
export const COMMAND_TIMEOUT_MS = 45_000;
/** Raw bytes per `blob/read` page: a multiple of three (so the pages' base64 joins into the blob's) under the core's 1 MiB page bound. */
const BLOB_PAGE_BYTES = 768 * 1024;
/** The wait past the core's own timeout before the harness gives up on an answer that never comes. */
const ANSWER_GRACE_MS = 10_000;

/** What `dev/computer/run` answers (`DevComputerRunResult`, the part this transport reads). */
interface RunAnswer {
  ok: boolean;
  text?: string;
  imageBlob?: { digest: string; byteLength: number; mimeType: string };
  error?: { code: string; message: string };
  helperPid?: number;
}

export type CoreCall = (method: string, params: unknown) => Promise<unknown>;

export interface CommandTransport {
  /** One command in a session: the tool's own action, a helper command or a harness control (`session_release`, `read_authorization`, ...). */
  runCommand(command: Record<string, unknown>, sessionId: string, timeoutMs?: number): Promise<CommandResult>;
  /** The process id of the session's helper as the last answer for it named it; undefined before a helper ran or after it ended. */
  helperPid(sessionId: string): number | undefined;
}

const isMethodNotFound = (error: unknown): boolean =>
  (error as { detail?: { data?: { reason?: unknown } } } | null)?.detail?.data?.reason === 'methodNotFound';

/** The failure as the bridge's `{ ok: false, error }` read: `code: message`, so the code is the prefix the scenarios classify by. */
function failureText({ code, message }: { code: string; message: string }): string {
  return message.toLowerCase().startsWith(`${code.toLowerCase()}:`) ? message : `${code}: ${message}`;
}

/** The blob's bytes as base64, a page at a time. */
async function readBlob(call: CoreCall, digest: string, byteLength: number): Promise<string> {
  let base64 = '';
  for (let offset = 0; offset < byteLength; offset += BLOB_PAGE_BYTES) {
    const page = (await call('blob/read', { digest, offset, length: Math.min(BLOB_PAGE_BYTES, byteLength - offset) })) as {
      bytesB64: string;
    };
    base64 += page.bytesB64;
  }
  return base64;
}

export function createCommandTransport(call: CoreCall): CommandTransport {
  const helperPids = new Map<string, number>();
  return {
    helperPid: (sessionId) => helperPids.get(sessionId),
    async runCommand(command, sessionId, timeoutMs = COMMAND_TIMEOUT_MS) {
      let timer: NodeJS.Timeout | undefined;
      let answer: RunAnswer;
      try {
        answer = (await Promise.race([
          call('dev/computer/run', { sessionThreadId: sessionId, command, timeoutMs }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`timeout: dev/computer/run did not answer within ${timeoutMs + ANSWER_GRACE_MS} ms`)),
              timeoutMs + ANSWER_GRACE_MS
            );
          }),
        ])) as RunAnswer;
      } catch (error) {
        if (isMethodNotFound(error)) {
          throw new Error(
            'dev/computer/run is absent: start mixdogd from a test-hooks build (cargo feature test-hooks) with MIXDOGD_TEST_HOOKS=1'
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (answer.helperPid === undefined) helperPids.delete(sessionId);
      else helperPids.set(sessionId, answer.helperPid);
      if (!answer.ok) throw new Error(failureText(answer.error ?? { code: 'computer_failed', message: 'computer command failed' }));
      const blob = answer.imageBlob;
      return {
        text: String(answer.text ?? ''),
        ...(blob ? { image: { mimeType: blob.mimeType, data: await readBlob(call, blob.digest, blob.byteLength) } } : {}),
      };
    },
  };
}

/** The connection of one harness process to the isolated core, with the host role claimed. */
export interface ComputerCore extends CommandTransport {
  /** Any protocol request (`config/set`, `computer/userControl`, ...). */
  call: CoreCall;
  /** The presence the overlay draws from: the core's `computer` section and the helper's pointer progress. */
  mirror: import('../../host/computer-pill').ComputerPillSource;
  dispose(): Promise<void>;
}

/** Needs Electron `ready`, `MIXDOG_DATA_DIR` and the app paths already pointed at a disposable profile. */
export async function openComputerCore(): Promise<ComputerCore> {
  const runtimeRoot = process.env[COMPUTER_CORE_RUNTIME_ROOT];
  if (!runtimeRoot) throw new Error(`${COMPUTER_CORE_RUNTIME_ROOT} names the runtime root of the isolated core.`);
  const { dirname } = await import('node:path');
  const { app, BrowserWindow, powerMonitor, screen } = await import('electron');
  const { HOST_CAPABILITIES } = await import('../../host/connection');
  const { createDesktopHost } = await import('../../host');
  const { createComputerPillSource } = await import('../../host/computer-pill');
  const { createProtocolConnection } = await import('../../protocol/connection');
  const { readLocalDiscovery } = await import('../../protocol/discovery');
  const { createHostConnection } = await import('../../protocol/host-connection');
  const { openCore } = await import('../../protocol/open-core');
  const { createBrowserHost } = await import('../../browser/host');
  const { bindPointerPresence } = await import('../host/pointer-cursor');
  const { setForegroundLeaseLibrary } = await import('../backend/foreground-lock-host');
  const { micaLibraryPath } = await import('../../window-mica');

  // The foreground lease the helper asks for is served by the process lock, which needs the native library of the app the
  // harness runner names (the bundle runs outside the app).
  const modulesFrom = process.env.MIXDOG_HARNESS_MODULES_FROM;
  if (!modulesFrom) throw new Error('MIXDOG_HARNESS_MODULES_FROM is required');
  setForegroundLeaseLibrary(micaLibraryPath({ isPackaged: false, resourcesPath: '', appPath: dirname(modulesFrom) }));

  const protocol = createProtocolConnection({
    open: openCore({
      resolve: () => readLocalDiscovery(runtimeRoot),
      version: app.getVersion(),
      capabilities: { approvalsInbox: true, host: HOST_CAPABILITIES },
    }),
  });
  const mirror = createComputerPillSource(Date.now, {
    notifyPointerReleased: (sessionThreadId) => protocol.notify('computer/pointerReleased', { sessionThreadId }),
  });
  const unbindPointer = bindPointerPresence(mirror);
  protocol.watchSection('computer', (entry) => {
    mirror.apply(
      (entry?.value as Parameters<typeof mirror.apply>[0] | null | undefined) ?? {
        active: false,
        observeOnly: false,
        controller: null,
        sessionThreadId: null,
        sessions: [],
      }
    );
  });

  // The claim starts the browser reports, so a browser host stands behind a hidden window (the harness drives no browser).
  const hostId = 'computer-core-harness-host';
  let window: InstanceType<typeof BrowserWindow> | null = null;
  let browserHost: ReturnType<typeof createBrowserHost> | null = null;
  const dispose = async (): Promise<void> => {
    unbindPointer();
    await browserHost?.dispose().catch(() => {});
    if (window && !window.isDestroyed()) window.destroy();
    await protocol.close().catch(() => {});
  };
  try {
    window = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true },
    });
    const created = createBrowserHost(window, { hostId, remoteSession: false, requestApproval: async () => true });
    browserHost = created;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>Harness shell</title>')}`);
    const host = createDesktopHost({
      connection: createHostConnection(protocol),
      hostId,
      browser: () => created.hostRole(),
      visualize: () => {
        throw new Error('The computer harness has no visualize service.');
      },
      files: () => {
        throw new Error('The computer harness has no file service.');
      },
      onVisualizePublishFailed: () => {},
      onBrowserViewFailed: () => {},
      resolveProxy: async () => 'DIRECT',
      // The screen reads and the whole-command relay belong to the desktop's own host, which the harness does not run: the core's
      // helper reads the screen itself. The arrow of app input is drawn through the harness mirror (host/register-s3.ts).
      computer: {
        mirror,
        permissions: {
          read: () => ({
            screen_capture: 'not_required_on_windows',
            accessibility: 'not_required_on_windows',
            input: 'target_integrity_dependent',
          }),
          request: () => undefined,
        },
        environment: { ready: app.whenReady(), sources: () => ({ power: powerMonitor, screen }) },
        desktopHostScreen: () => null,
        desktopHostCommand: () => null,
      },
      notifications: {
        createNotification: () => {
          throw new Error('The computer harness shows no notifications.');
        },
        activate: () => {},
        isSupported: () => false,
        idleSeconds: () => 0,
      },
      onUpdaterInstallFailed: () => {},
    });
    await protocol.start();
    await host.claim();
    const call: CoreCall = (method, params) => protocol.call(method, params);
    return { ...createCommandTransport(call), call, mirror, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
