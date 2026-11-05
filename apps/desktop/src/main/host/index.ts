/**
 * Electron main's host role (DS §12): one object that serves every `host/*`
 * message of the protocol connection. It replaces the loopback bridges and
 * their discovery files; there is no listener, token or heartbeat here.
 */
import type { HostClaimParams } from '../../../../../packages/protocol/src/index.ts';
import type { DesktopRemoteBrowserStreamFrame } from '../../shared/contract';
import { createBrowserCommandHost, type BrowserCommandRunner, type BrowserInputControl } from './browser-command';
import { type BrowserTabsControl, createBrowserTabsReporter } from './browser-tabs';
import { type BrowserViewControl, createBrowserView } from './browser-view';
import { HOST_METHOD, type HostConnection } from './connection';
import { type FilesControl, registerFilesHost } from './files';
import { createHostReports, type HostUpdater } from './lifecycle';
import { createVisualizeHost, type VisualizeControl } from './visualize';
import { type NotificationPresenter, registerNotificationHost } from './notification';
import { registerSystemProxyHost } from './system-proxy';

export interface DesktopHostOptions {
  connection: HostConnection;
  /** Generated once per install. */
  hostId: string;
  /** The in-app browser, resolved when first used (it is built after the connection). */
  browser: () => {
    runner: BrowserCommandRunner;
    view: BrowserViewControl & Pick<BrowserInputControl, 'remoteBrowserControl'>;
    tabs: BrowserTabsControl;
    remote: BrowserInputControl['remote'];
  };
  /** The visualize service, resolved when first used. */
  visualize: () => VisualizeControl;
  /** Project-file snapshot and local-page leases, resolved when first used. */
  files: () => FilesControl;
  /** The claim-time visualize snapshot failed to reach the core: report it (diagnostics). */
  onVisualizePublishFailed: (error: unknown) => void;
  /** `host/browser/viewFrames` is a notification: a live view that failed to start is reported (diagnostics). */
  onBrowserViewFailed: (error: unknown) => void;
  resolveProxy: (url: string) => Promise<string>;
  notifications: NotificationPresenter;
  updater?: HostUpdater;
  /** An install that failed after `host/update/command` was answered: report it (diagnostics). */
  onUpdaterInstallFailed: (error: unknown) => void;
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
  const commands = createBrowserCommandHost(connection, runner, {
    remoteBrowserControl: (sessionId, control) => options.browser().view.remoteBrowserControl(sessionId, control),
    remote: (method, args) => options.browser().remote(method, args),
  });
  const view = createBrowserView(
    connection,
    {
      remoteBrowserStream: (sessionId, streamOptions) =>
        options.browser().view.remoteBrowserStream(sessionId, streamOptions),
    },
    options.onBrowserViewFailed
  );
  const tabs = createBrowserTabsReporter(connection, () => options.browser().tabs);
  const visualize = createVisualizeHost(connection, options.visualize, options.onVisualizePublishFailed);
  registerFilesHost(connection, options.files);
  registerSystemProxyHost(connection, options.resolveProxy);
  registerNotificationHost(connection, options.notifications);
  const reports = createHostReports(connection, options.updater, options.onUpdaterInstallFailed);
  let claimed = false;
  connection.onClose(() => {
    if (!claimed) return;
    claimed = false;
    tabs.stop();
    commands.stop();
  });

  return {
    reports,
    /** Claims the host role; commands are served from here on. */
    async claim(): Promise<void> {
      await connection.request(HOST_METHOD.claim, { hostId: options.hostId } satisfies HostClaimParams);
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
  };
}
