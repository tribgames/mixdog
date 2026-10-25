// Project list and lifecycle, workspace search, and the
// shell hand-offs (open folder, media asset, external link) the renderer asks for.
import type { Shell } from 'electron';
import { isAbsolute as pathIsAbsolute } from 'node:path';
import { DESKTOP_IPC } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';
import { openLocalFileLink } from './local-file-links';
import { submitFeedback } from './feedback-client';
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
}

export function registerProjectIpc({
  handle,
  host,
  shell,
  invokeDesktopOperation,
  operations,
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
  handle(DESKTOP_IPC.submitFeedback, (_event, input) => submitFeedback(input));
  handle(DESKTOP_IPC.openLocalFileLink, (_event, projectPath, href, confirmedPath) =>
    openLocalFileLink(projectPath, href, (file) => shell.openPath(file), confirmedPath)
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
