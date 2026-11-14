// The shell hand-offs of a project (open its folder, a media asset, an external link, a chat file link) that stay in main: handing
// something to the operating system is Electron's. The project list and its lifecycle, workspace search, feedback and the
// dependency probes are requests of the window's own core connection.
import type { Shell } from 'electron';
import { isAbsolute as pathIsAbsolute } from 'node:path';
import { DESKTOP_IPC } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';
import type { FileLaunchConfirmation, LocalLinkOpened } from '../shared/local-files';
import { coreErrorForWindow } from './protocol/core-error';
import type { ProtocolConnection } from './protocol/connection';
import { requiredExternalUrl, requiredString } from './ipc-validation';
import type { IpcHandle as Handle } from './ipc';

interface ProjectIpcOptions {
  handle: Handle;
  host: Pick<DesktopService, 'projectDirectory' | 'invokeCapability'>;
  shell: Pick<Shell, 'openPath' | 'openExternal' | 'showItemInFolder'>;
  /** This PC's core connection: a chat file link is answered by its `desktop/localLink/open`; without one it fails. */
  core?: Pick<ProtocolConnection, 'call'> | null;
}

export function registerProjectIpc({ handle, host, shell, core }: ProjectIpcOptions): void {
  handle(DESKTOP_IPC.openProjectInExplorer, async (_event, projectPath) => {
    const directory = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
    const failure = await shell.openPath(directory);
    if (failure) throw new Error(`Unable to open project folder: ${failure}`);
  });
  const resolvedMediaAssetPath = async (assetId: unknown): Promise<string> => {
    const id = requiredString(assetId, 'assetId', 512);
    const result = await host.invokeCapability<{ available?: unknown; path?: unknown }>('resolveMediaFile', [
      id,
      { variant: 'original' },
    ]);
    const file = result.value;
    if (file?.available !== true || typeof file.path !== 'string' || !pathIsAbsolute(file.path)) {
      throw new Error('Media asset is unavailable.');
    }
    return file.path;
  };
  handle(DESKTOP_IPC.openMediaAsset, async (_event, assetId) => {
    const failure = await shell.openPath(await resolvedMediaAssetPath(assetId));
    if (failure) throw new Error(`Unable to open media asset: ${failure}`);
  });
  handle(DESKTOP_IPC.openMediaFolder, async (_event, assetId) => {
    shell.showItemInFolder(await resolvedMediaAssetPath(assetId));
  });
  handle(DESKTOP_IPC.openExternal, (_event, url) => shell.openExternal(requiredExternalUrl(url)));
  // The core decides the link (validated, inside the project by path and by real path, an executable target asks for confirmation);
  // handing a file or folder to the operating system is Electron's `shell.openPath`.
  handle(
    DESKTOP_IPC.openLocalFileLink,
    async (_event, projectPath, href, confirmedPath): Promise<LocalLinkOpened | FileLaunchConfirmation> => {
      if (!core) throw new Error('The core connection is not available.');
      let answer: { result?: LocalLinkOpened; path?: string; confirmationPath?: string };
      try {
        answer = (await core.call('desktop/localLink/open', {
          projectPath,
          href,
          ...(confirmedPath === undefined ? {} : { confirmedPath }),
        })) as typeof answer;
      } catch (error) {
        throw coreErrorForWindow(error);
      }
      if (typeof answer.confirmationPath === 'string') return { confirmationPath: answer.confirmationPath };
      if (answer.result === 'editor') return 'editor';
      const failure = await shell.openPath(answer.path as string);
      if (failure) throw new Error(`Unable to open file: ${failure}`);
      return answer.result as 'file' | 'folder';
    }
  );
}
