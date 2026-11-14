// Project list and lifecycle, workspace search, and the
// shell hand-offs (open folder, media asset, external link) the renderer asks for.
import type { Shell } from 'electron';
import { isAbsolute as pathIsAbsolute } from 'node:path';
import { DESKTOP_IPC } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';
import type { FileLaunchConfirmation, LocalLinkOpened } from '../shared/local-files';
import { putBlobRef } from './core-blob-ref';
import { coreErrorForWindow } from './protocol/core-error';
import type { ProtocolConnection } from './protocol/connection';
import {
  projectDisplayName,
  requiredExternalUrl,
  requiredFileSearchLimit,
  requiredGitPaths,
  requiredString,
  requiredWorkspaceSearchOptions,
} from './ipc-validation';
import type { IpcHandle as Handle } from './ipc';

type ServiceOperation = (...args: unknown[]) => Promise<unknown>;

interface ProjectIpcOptions {
  handle: Handle;
  host: DesktopService;
  shell: Pick<Shell, 'openPath' | 'openExternal' | 'showItemInFolder'>;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  operations: Record<'githubStarStatus' | 'starGithub' | 'libreOfficeStatus' | 'installLibreOffice', ServiceOperation>;
  /** This PC's core connection: feedback and a chat file link are answered by its `feedback/upload` and `desktop/localLink/open`; without one they fail. */
  core?: Pick<ProtocolConnection, 'call'> | null;
}

/** A feedback attachment is an image, larger than one frame: its data travels as a blob (the field `blob_fields.json` lists). Data that is
 *  not canonical base64 stays as it is, and the core refuses it. */
async function feedbackWithBlobAttachments(core: Pick<ProtocolConnection, 'call'>, value: unknown): Promise<unknown> {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!input || !Array.isArray(input.attachments)) return value;
  const attachments = await Promise.all(
    input.attachments.map(async (attachment: unknown) => {
      const data = (attachment as { data?: unknown } | null)?.data;
      if (typeof data !== 'string') return attachment;
      const bytes = Buffer.from(data, 'base64');
      if (bytes.toString('base64') !== data) return attachment;
      return { ...(attachment as object), data: await putBlobRef(core, bytes, 'base64') };
    })
  );
  return { ...input, attachments };
}

export function registerProjectIpc({
  handle,
  host,
  shell,
  invokeDesktopOperation,
  operations,
  core,
}: ProjectIpcOptions): void {
  handle(DESKTOP_IPC.startProject, (_event, projectPath) =>
    host.startProject(requiredString(projectPath, 'projectPath'))
  );
  handle(DESKTOP_IPC.startProjectTask, (_event, projectPath) =>
    host.startProjectTask(requiredString(projectPath, 'projectPath'))
  );
  handle(DESKTOP_IPC.startTask, () => host.startTask());
  handle(DESKTOP_IPC.listProjects, () => host.listProjects());
  // Paired phones re-read their project list from the existing settings-changed event.
  const announceProjectsChanged = <T>(result: T): T => {
    void invokeDesktopOperation('notifySettingsChanged', ['desktop']).catch(() => {});
    return result;
  };
  handle(DESKTOP_IPC.addProject, async (_event, projectPath) =>
    announceProjectsChanged(await host.addProject(requiredString(projectPath, 'projectPath')))
  );
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
  handle(DESKTOP_IPC.submitFeedback, async (_event, input) => {
    if (!core) throw new Error('The core connection is not available.');
    try {
      // The renderer cannot select a recipient, URL or credentials: the core validates the fields and posts them to its relay.
      return await core.call('feedback/upload', { input: await feedbackWithBlobAttachments(core, input) });
    } catch (error) {
      throw coreErrorForWindow(error);
    }
  });
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
  handle(DESKTOP_IPC.githubStarStatus, () => operations.githubStarStatus());
  handle(DESKTOP_IPC.starGithub, () => operations.starGithub());
  // Extensions → Office: LibreOffice dependency probe + guided install.
  handle(DESKTOP_IPC.libreOfficeStatus, (_event, refresh) => operations.libreOfficeStatus(refresh === true));
  handle(DESKTOP_IPC.installLibreOffice, () => operations.installLibreOffice());
  handle(DESKTOP_IPC.renameProject, async (_event, projectPath, alias) =>
    announceProjectsChanged(
      await host.renameProject(requiredString(projectPath, 'projectPath'), projectDisplayName(alias))
    )
  );
  handle(DESKTOP_IPC.removeProject, async (_event, projectPath) =>
    announceProjectsChanged(await host.removeProject(requiredString(projectPath, 'projectPath')))
  );
  handle(
    DESKTOP_IPC.searchProjectFiles,
    (event, projectIdOrWorkspaceId, query, limit, includeIgnored, includeDirectories) => {
      if (typeof query !== 'string' || query.length > 1_024) {
        throw new TypeError('query is invalid.');
      }
      return host.searchProjectFiles(
        requiredString(projectIdOrWorkspaceId, 'projectIdOrWorkspaceId'),
        query,
        requiredFileSearchLimit(limit),
        includeIgnored === true,
        includeDirectories === true,
        // The @ palette (the only caller listing folders) is one search at a
        // time per window: its next keystroke supersedes the previous search.
        includeDirectories === true ? `mention:${event.sender.id}` : undefined
      );
    }
  );
  handle(DESKTOP_IPC.searchWorkspaceText, async (_event, projectPath, rawOptions) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    const options = requiredWorkspaceSearchOptions(rawOptions);
    return invokeDesktopOperation('searchWorkspaceTextIn', [root, options]);
  });
  handle(DESKTOP_IPC.replaceWorkspaceText, async (_event, projectPath, rawOptions, replacement, relPaths) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    if (typeof replacement !== 'string' || replacement.length > 1_000_000) {
      throw new TypeError('Replacement text is invalid.');
    }
    const options = requiredWorkspaceSearchOptions(rawOptions);
    const paths = relPaths === undefined ? undefined : requiredGitPaths(relPaths);
    return invokeDesktopOperation('replaceWorkspaceTextIn', [root, options, replacement, paths]);
  });
}
