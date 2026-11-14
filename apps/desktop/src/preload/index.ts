// The window's desktop bridge: the HOST half of DesktopApi (Electron and OS methods, window.mixdogDesktopHost, with the
// boot values main passes on the command line) and the window's own port to its core (window.mixdogCorePort). The renderer
// composes window.mixdogDesktop from both (renderer/core-direct/install.ts): the core's methods go over the window's own
// core connection, not through main. Explicit method allow-list, no arbitrary invoke.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { type DesktopBootContext, type DesktopConnectionIdentity } from '../shared/contract';
import { ipcErrorFromEnvelope } from '../shared/coded-error';
import { createBrowserTextureBridge } from './browser-texture';
import { installCorePort } from './core-port';
import { createHostApi } from './host-api';

/** `ipcRenderer.invoke` that rebuilds a refusal main returned as an error
 *  envelope (Electron drops an Error's custom `code` in transit). */
function invokeIpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then((result: T) => {
    const failure = ipcErrorFromEnvelope(result);
    if (failure) throw failure;
    return result;
  });
}

function additionalArgument(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? '';
}

const bootId = additionalArgument('mixdog-boot-id');
const processStartedAt = Number(additionalArgument('mixdog-process-started-at'));
const bootScenario = additionalArgument('mixdog-boot-scenario');
const afterUpdate = additionalArgument('mixdog-after-update') === '1';

function bootContextValue(): DesktopBootContext | undefined {
  if (!bootId || !Number.isFinite(processStartedAt)) return undefined;
  return Object.freeze({
    bootId,
    processStartedAt,
    ...(bootScenario ? { scenario: bootScenario } : {}),
    ...(afterUpdate ? { afterUpdate: true as const } : {}),
  });
}
const bootContext = bootContextValue();

/** Which daemon this window drives; main passes it at window creation. */
function connectionValue(): DesktopConnectionIdentity | undefined {
  const id = additionalArgument('mixdog-connection-id');
  const kind = additionalArgument('mixdog-connection-kind');
  if (!id || (kind !== 'local' && kind !== 'ssh')) return undefined;
  let name = '';
  try {
    name = decodeURIComponent(additionalArgument('mixdog-connection-name'));
  } catch {
    /* a malformed name shows as empty */
  }
  return Object.freeze({ id, kind, name });
}
const connection = connectionValue();

/** Forwards every argument of `channel` to `listener`; returns the unsubscribe. */
function subscribeIpc<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
  const receive = (_event: Electron.IpcRendererEvent, ...args: Args): void => listener(...args);
  ipcRenderer.on(channel, receive);
  return () => {
    ipcRenderer.removeListener(channel, receive);
  };
}

const host = createHostApi({ invokeIpc, subscribeIpc, ipcRenderer, webUtils, browserTexture: createBrowserTextureBridge() });

contextBridge.exposeInMainWorld(
  'mixdogDesktopHost',
  Object.freeze({
    ...host,
    ...(bootContext ? { bootContext } : {}),
    ...(connection ? { connection } : {}),
  })
);
installCorePort(ipcRenderer, contextBridge);
