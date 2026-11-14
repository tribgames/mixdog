/**
 * Electron main's host role (DS §12): one object that serves every `host/*`
 * message of the protocol connection. It replaces the loopback bridges and
 * their discovery files; there is no listener, token or heartbeat here.
 */
import { screen } from 'electron';
import type { HostClaimParams } from '../../../../../packages/protocol/src/index.ts';
import type { DesktopRemoteBrowserStreamFrame } from '../../shared/contract';
import type { RemoteScreenDisplaySummary } from '../../shared/remote-webrtc';
import { createBrowserCommandHost, type BrowserCommandRunner, type BrowserInputControl } from './browser-command';
import { type BrowserEnginePorts, serveBrowserEngine } from './browser-engine';
import type { TranscriptTap } from './browser-engine/transcript';
import { type BrowserLiveControl, registerBrowserLiveControlHost } from './browser-live-control';
import { createBrowserPageReporter, type StreamedPage } from './browser-page-report';
import { type BrowserSurfaceSource, registerBrowserSurfaceReport } from './browser-surface-report';
import { type BrowserTabsControl, createBrowserTabsReporter } from './browser-tabs';
import { type BrowserViewControl, createBrowserView } from './browser-view';
import { registerWindowHost, WINDOW_HOST_METHOD, type WindowHostDeps } from '../connections/window-host';
import { HOST_METHOD, type HostConnection } from './connection';
import { type FilesControl, registerFilesHost } from './files';
import { createHostReports, type HostUpdater } from './lifecycle';
import { createVisualizeHost, type VisualizeControl } from './visualize';
import { type NotificationPresenter, registerNotificationHost } from './notification';
import { registerSystemProxyHost } from './system-proxy';
import { registerComputerHost, type ComputerHostWiring } from './register-s3';
import { registerHumanOnlyHolds } from './human-only';
import { registerScreenDisplaysHost, reportScreenDisplayChanges } from './screen-displays';

export interface DesktopHostOptions {
  connection: HostConnection;
  /** Generated once per install. */
  hostId: string;
  /** The in-app browser, resolved when first used (it is built after the connection). */
  browser: () => {
    runner: BrowserCommandRunner;
    view: BrowserViewControl &
      Pick<BrowserInputControl, 'remoteBrowserControl'> & {
        /** The streamed page's document and locked geometry (`host/browser/page`); null when not streamed. */
        streamedPage(sessionId: string): StreamedPage | null;
      };
    tabs: BrowserTabsControl;
    remote: BrowserInputControl['remote'];
    /** The streamed page's resize and video limit (`host/browser/liveControl`). */
    liveControl: BrowserLiveControl;
    /** What the engine lane (`host/browser/*` engine methods, browser-engine/index.ts) is built from. */
    engine: BrowserEnginePorts;
  };
  /** The engine lane's development transcript (browser-engine/transcript.ts); absent in a packaged build. */
  browserEngineTranscript?: TranscriptTap;
  /** The visualize service, resolved when first used. */
  visualize: () => VisualizeControl;
  /** Project-file snapshot and local-page leases, resolved when first used. */
  files: () => FilesControl;
  /** The claim-time visualize snapshot failed to reach the core: report it (diagnostics). */
  onVisualizePublishFailed: (error: unknown) => void;
  /** `host/browser/viewFrames` is a notification: a live view that failed to start is reported (diagnostics). */
  onBrowserViewFailed: (error: unknown) => void;
  resolveProxy: (url: string) => Promise<string>;
  /** Every `host/computer/*` handler's inputs (register-s3.ts): the presence mirror, the permissions, the environment reports and the
   *  desktop's own computer host while it runs. */
  computer: ComputerHostWiring;
  notifications: NotificationPresenter;
  updater?: HostUpdater;
  /** An install that failed after `host/update/command` was answered: report it (diagnostics). */
  onUpdaterInstallFailed: (error: unknown) => void;
  /** The server windows the core opens, closes and focuses (`host/window/*`); absent where a host has no server windows. */
  windows?: Omit<WindowHostDeps, 'report'>;
}

export function createDesktopHost(options: DesktopHostOptions) {
  const { connection } = options;
  const runner: BrowserCommandRunner = {
    execute: (command, signal) => options.browser().runner.execute(command, signal),
    begin: () => options.browser().runner.begin(),
    ready: () => options.browser().runner.ready(),
    inactive: () => options.browser().runner.inactive(),
    end: () => options.browser().runner.end(),
  };
  // The engine methods are registered at construction (the connection's method table is fixed and `serves` is read at
  // claim); the browser is resolved when the core first calls one, and from then on the lane is on for this connection.
  const engine = serveBrowserEngine(connection, () => options.browser().engine, {
    transcript: options.browserEngineTranscript,
  });
  const commands = createBrowserCommandHost(
    connection,
    runner,
    {
      remoteBrowserControl: (sessionId, control) => options.browser().view.remoteBrowserControl(sessionId, control),
      remote: (method, args) => options.browser().remote(method, args),
    },
    engine.engineMode
  );
  const view = createBrowserView(
    connection,
    {
      remoteBrowserStream: (sessionId, streamOptions) =>
        options.browser().view.remoteBrowserStream(sessionId, streamOptions),
    },
    options.onBrowserViewFailed
  );
  const tabs = createBrowserTabsReporter(connection, () => options.browser().tabs);
  // Resolved per request: the browser is built after the host connection.
  registerBrowserLiveControlHost(connection, () => options.browser().liveControl);
  const pageReport = createBrowserPageReporter(connection, (sessionId) => {
    try {
      return options.browser().view.streamedPage(sessionId);
    } catch {
      // The browser is gone (its window closed): no page is streamed.
      return null;
    }
  });
  const visualize = createVisualizeHost(connection, options.visualize, options.onVisualizePublishFailed);
  registerFilesHost(connection, options.files);
  registerSystemProxyHost(connection, options.resolveProxy);
  const stopComputer = registerComputerHost(connection, options.computer);
  // The browser host's own screen-displays path (the screen sources' displays, or "Remote screen is unavailable.").
  registerScreenDisplaysHost(connection, () => ({
    list: () => options.browser().remote('screenDisplays', []) as Promise<RemoteScreenDisplaySummary[]>,
  }));
  // A display added, removed or rescaled is told to the core (host/screen/displaysChanged).
  const stopDisplayReports = typeof screen?.on === 'function' ? reportScreenDisplayChanges(connection, screen) : () => {};
  const humanOnly = registerHumanOnlyHolds(connection);
  registerNotificationHost(connection, options.notifications);
  // host/state/set is a request, host/window/closed a notification.
  const windowHost =
    options.windows
      ? registerWindowHost(connection, {
          ...options.windows,
          report: (method, params) => {
            if (method === WINDOW_HOST_METHOD.stateSet) void connection.request(method, params).catch(() => {});
            else connection.notify(method, params);
          },
        })
      : null;
  const reports = createHostReports(connection, options.updater, options.onUpdaterInstallFailed);
  let claimed = false;
  connection.onClose(() => {
    stopDisplayReports();
    if (!claimed) return;
    claimed = false;
    tabs.stop();
    stopComputer();
    commands.stop();
    pageReport.stop();
  });

  return {
    reports,
    /** `host/window/closed` (only for windows the core asked for) and the windowFocus report; null without `windows`. */
    windowHost,
    /** Claims the host role; commands are served from here on. */
    async claim(): Promise<void> {
      // Each reconnect claims again: a human-only dialog still open holds the core again first (a hold does not
      // need the claim, so it holds even when the claim is refused).
      humanOnly.redeclare();
      // `serves`: the host/* methods this desktop answers, so the core routes only those here.
      await connection.request(HOST_METHOD.claim, {
        hostId: options.hostId,
        serves: connection.servedMethods(),
      } satisfies HostClaimParams);
      claimed = true;
      commands.start();
      tabs.start();
      reports.resend();
      visualize.start();
    },
    /** The browser host's `publishRemoteTabs`. */
    publishRemoteTabs: tabs.publish,
    /** The visualize service's `publishRemote` (`hostState.visualize`). */
    publishVisualize: visualize.publish,
    /** The browser host's `publishRemoteFrame`. */
    publishRemoteFrame: (frame: DesktopRemoteBrowserStreamFrame): Promise<void> => view.publishFrame(frame),
    /** The browser host's `onStreamedPageChanged`: sends `host/browser/page` when the page or its geometry changed. */
    streamedPageChanged: (sessionId: string): void => pageReport.changed(sessionId),
    /** Reports a browser host's surface reveals and hides as `host/browser/surface`; returns the detach (its window
     *  closed). Attached per browser host, since one is built for each window of this PC. */
    reportBrowserSurfaces: (source: BrowserSurfaceSource): (() => void) => registerBrowserSurfaceReport(connection, source),
  };
}
