import type { App, Shell } from 'electron';
import { posix } from 'node:path';
import { DESKTOP_IPC } from '../shared/contract';
import { requiredProjectRecoveryRequest } from '../shared/project-recovery';
import type { DesktopService } from './desktop-service-contract';
import { registerFilePreview } from './file-preview';
import { fileSnapshots } from './file-snapshot';
import { localPageUrl, revokeLocalPagesFor } from './local-page-server';
import { LocalAccessDeniedError } from './local-access-denied';
import { projectEntryPathIn } from './project-files';
import {
  requiredLspDocumentInput,
  requiredLspRequestInput,
  requiredString,
  requiredTextFileContent,
  requiredTextFileEncoding,
  requiredWorkspaceTextWrites,
} from './ipc-validation';
import type { IpcHandle as Handle } from './ipc';
import { registerServerFileIpc } from './ipc-server-files';
import type { ServerFiles } from './server-file-access';

type GrantedFile = {
  root: string;
  rel: string;
  absolute: string;
};

interface ProjectFileIpcOptions {
  app: Partial<Pick<App, 'getPath'>>;
  handle: Handle;
  host: DesktopService;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  shell: Pick<Shell, 'trashItem' | 'openPath'>;
  grantedFile: (accessToken: unknown, projectPath: unknown, relPath: unknown) => Promise<GrantedFile>;
  /** A server (ssh) window: its files are read, previewed and deleted on the
   *  server through the daemon, never through this PC's filesystem. */
  server?: ServerFiles | null;
}

export function registerProjectFileIpc({
  app,
  handle,
  host,
  invokeDesktopOperation,
  shell,
  grantedFile,
  server = null,
}: ProjectFileIpcOptions): void {
  const editorFilePath = async (projectPath: unknown, relPath: unknown, accessToken: unknown): Promise<string> => {
    if (typeof accessToken === 'string' && accessToken) {
      return (await grantedFile(accessToken, projectPath, relPath)).absolute;
    }
    const project = requiredString(projectPath, 'projectPath');
    const rel = requiredString(relPath, 'relPath', 4_096);
    return projectEntryPathIn(await host.projectDirectory(project), rel);
  };
  const editorFileTarget = async (
    projectPath: unknown,
    relPath: unknown,
    accessToken: unknown
  ): Promise<{ root: string; rel: string }> => {
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return { root: granted.root, rel: granted.rel };
    }
    return {
      root: await host.projectDirectory(requiredString(projectPath, 'projectPath')),
      rel: requiredString(relPath, 'relPath', 4_096),
    };
  };
  const context: ProjectFileContext = {
    handle,
    host,
    invokeDesktopOperation,
    shell,
    grantedFile,
    server,
    editorFilePath,
    editorFileTarget,
    editorBackupRoot: typeof app.getPath === 'function' ? app.getPath('userData') : '',
  };

  handle(DESKTOP_IPC.listProjectDir, (_event, projectPath, relDir) =>
    host.listProjectDir(requiredString(projectPath, 'projectPath'), typeof relDir === 'string' ? relDir : '')
  );
  handle(DESKTOP_IPC.readProjectFile, async (_event, projectPath, relPath, accessToken) => {
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return invokeDesktopOperation('readProjectTextFileIn', [granted.root, granted.rel]);
    }
    return host.readProjectTextFile(requiredString(projectPath, 'projectPath'), requiredString(relPath, 'relPath'));
  });
  registerLocalPageIpc(context);
  registerPreviewIpc(context);
  registerEditorFileIpc(context);
  registerEntryIpc(context);
  registerLspIpc(context);
  if (server) {
    registerServerFileIpc({
      handle,
      server,
      invokeDesktopOperation,
      fileTarget: editorFileTarget,
      projectDirectory: (project) => host.projectDirectory(project),
      shell,
    });
  }
}

type ProjectFileContext = Pick<
  ProjectFileIpcOptions,
  'handle' | 'host' | 'invokeDesktopOperation' | 'shell' | 'grantedFile'
> & {
  server: ServerFiles | null;
  editorFilePath: (projectPath: unknown, relPath: unknown, accessToken: unknown) => Promise<string>;
  editorFileTarget: (
    projectPath: unknown,
    relPath: unknown,
    accessToken: unknown
  ) => Promise<{ root: string; rel: string }>;
  editorBackupRoot: string;
};

function registerLocalPageIpc({ handle, host, grantedFile }: ProjectFileContext): void {
  const previewOwners = new WeakSet<object>();
  handle(DESKTOP_IPC.localPageUrl, async (event, projectPath, relPath, accessToken) => {
    const project = requiredString(projectPath, 'projectPath');
    const rel = requiredString(relPath, 'relPath', 4_096);
    const owner = event.sender;
    const requireOwner = (): void => {
      if (owner.isDestroyed()) throw new LocalAccessDeniedError('The preview owner is closed.');
    };
    requireOwner();
    if (!previewOwners.has(owner)) {
      previewOwners.add(owner);
      owner.once('destroyed', () => revokeLocalPagesFor(owner));
    }
    // A supplied grant remains file-only even when its parent is also a
    // registered project. Invalid/expired tokens never fall back to project.
    if (accessToken !== undefined && accessToken !== '') {
      const token = requiredString(accessToken, 'file access token', 128);
      const granted = await grantedFile(token, project, rel);
      return localPageUrl(granted.root, granted.rel, {
        scope: 'file',
        owner,
        async authorize() {
          requireOwner();
          const current = await grantedFile(token, project, rel);
          requireOwner();
          if (current.absolute !== granted.absolute)
            throw new LocalAccessDeniedError('The selected-file permission changed.');
        },
      });
    }
    const root = await host.projectDirectory(project);
    return localPageUrl(root, rel, {
      scope: 'project',
      owner,
      async authorize() {
        requireOwner();
        const current = await host.projectDirectory(project);
        requireOwner();
        if (current !== root) throw new LocalAccessDeniedError('The project permission changed.');
      },
    });
  });
}

function registerPreviewIpc({
  handle,
  host,
  invokeDesktopOperation,
  grantedFile,
  server,
  editorFileTarget,
}: ProjectFileContext): void {
  handle(DESKTOP_IPC.previewProjectFile, async (_event, projectPath, relPath, accessToken) => {
    if (server) {
      const target = await editorFileTarget(projectPath, relPath, accessToken);
      const info = await invokeDesktopOperation<{ mtimeMs: number; size: number }>('statProjectFileIn', [
        target.root,
        target.rel,
      ]);
      const preview = server.previews.register(target.root, target.rel, `${info.mtimeMs}:${info.size}`);
      if (!preview) throw new Error('This file type does not support an in-app preview.');
      return { ...preview, ...info };
    }
    let file: string;
    let info: { mtimeMs: number; size: number };
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      file = granted.absolute;
      info = await invokeDesktopOperation('statProjectFileIn', [granted.root, granted.rel]);
    } else {
      const cleanProject = requiredString(projectPath, 'projectPath');
      const cleanRel = requiredString(relPath, 'relPath');
      const root = await host.projectDirectory(cleanProject);
      file = projectEntryPathIn(root, cleanRel);
      info = await invokeDesktopOperation('statProjectFileIn', [root, cleanRel]);
    }
    const preview = registerFilePreview(file, `${info.mtimeMs}:${info.size}`);
    if (!preview) throw new Error('This file type does not support an in-app preview.');
    return { ...preview, ...info };
  });
  handle(DESKTOP_IPC.captureFileSnapshot, async (_event, projectPath, relPath, accessToken) => {
    // A server window's files live on the server, out of this PC's reach.
    if (server) throw new Error('Snapshots are not available for server files.');
    const target = await editorFileTarget(projectPath, relPath, accessToken);
    return fileSnapshots.capture(target.root, target.rel, typeof accessToken === 'string' && accessToken !== '');
  });
  handle(DESKTOP_IPC.previewDocumentFile, async (_event, projectPath, relPath, accessToken) => {
    const target = await editorFileTarget(projectPath, relPath, accessToken);
    const converted = (await invokeDesktopOperation('documentPreviewIn', [target.root, target.rel])) as {
      path: string;
      format: string;
      mtimeMs: number;
      size: number;
    };
    // On a server the converted PDF sits in the daemon's cache there.
    const preview = server
      ? server.previews.register(
          posix.dirname(converted.path),
          posix.basename(converted.path),
          `${converted.mtimeMs}:${converted.size}`
        )
      : registerFilePreview(converted.path, `${converted.mtimeMs}:${converted.size}`);
    if (!preview) throw new Error('The converted document preview is unavailable.');
    return {
      url: preview.url,
      kind: 'pdf' as const,
      mime: preview.mime,
      format: converted.format,
      mtimeMs: converted.mtimeMs,
      size: converted.size,
    };
  });
  handle(DESKTOP_IPC.previewDocumentPages, async (_event, projectPath, relPath, accessToken, options) => {
    const target = await editorFileTarget(projectPath, relPath, accessToken);
    return invokeDesktopOperation('documentPreviewPagesIn', [target.root, target.rel, options ?? {}]);
  });
}

function registerEditorFileIpc({
  handle,
  host,
  invokeDesktopOperation,
  grantedFile,
  editorFilePath,
  editorBackupRoot,
}: ProjectFileContext): void {
  handle(
    DESKTOP_IPC.writeProjectFile,
    async (_event, projectPath, relPath, content, expectedContent, accessToken, encoding) => {
      const text = requiredTextFileContent(content, 'file content');
      const expected = requiredTextFileContent(expectedContent, 'expected file content');
      const fileEncoding = requiredTextFileEncoding(encoding);
      if (typeof accessToken === 'string' && accessToken) {
        const granted = await grantedFile(accessToken, projectPath, relPath);
        return invokeDesktopOperation('writeProjectTextFileIn', [
          granted.root,
          granted.rel,
          text,
          expected,
          fileEncoding,
        ]);
      }
      return host.writeProjectTextFile(
        requiredString(projectPath, 'projectPath'),
        requiredString(relPath, 'relPath'),
        text,
        expected,
        fileEncoding
      );
    }
  );
  handle(DESKTOP_IPC.readEditorBackup, async (_event, projectPath, relPath, accessToken) => {
    if (!editorBackupRoot) return null;
    return invokeDesktopOperation('readEditorBackup', [
      editorBackupRoot,
      await editorFilePath(projectPath, relPath, accessToken),
    ]);
  });
  handle(DESKTOP_IPC.writeEditorBackup, async (_event, projectPath, relPath, content, expectedContent, accessToken) => {
    if (!editorBackupRoot) throw new Error('Editor backup storage is unavailable.');
    return invokeDesktopOperation('writeEditorBackup', [
      editorBackupRoot,
      await editorFilePath(projectPath, relPath, accessToken),
      content,
      expectedContent,
    ]);
  });
  handle(DESKTOP_IPC.deleteEditorBackup, async (_event, projectPath, relPath, accessToken) => {
    if (!editorBackupRoot) return;
    await invokeDesktopOperation('deleteEditorBackup', [
      editorBackupRoot,
      await editorFilePath(projectPath, relPath, accessToken),
    ]);
  });
  handle(DESKTOP_IPC.statProjectFile, async (_event, projectPath, relPath, accessToken) => {
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return invokeDesktopOperation('statProjectFileIn', [granted.root, granted.rel]);
    }
    return host.statProjectFile(requiredString(projectPath, 'projectPath'), requiredString(relPath, 'relPath'));
  });
}

function registerEntryIpc({ handle, host, invokeDesktopOperation, shell, server }: ProjectFileContext): void {
  handle(DESKTOP_IPC.createProjectEntry, (_event, projectPath, relDir, name, dir) =>
    host.createProjectEntry(
      requiredString(projectPath, 'projectPath'),
      typeof relDir === 'string' ? relDir : '',
      requiredString(name, 'name'),
      dir === true
    )
  );
  handle(DESKTOP_IPC.renameProjectEntry, (_event, projectPath, relPath, newName) =>
    host.renameProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      requiredString(newName, 'newName')
    )
  );
  handle(DESKTOP_IPC.moveProjectEntry, (_event, projectPath, relPath, targetDirRel) =>
    host.moveProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      typeof targetDirRel === 'string' ? targetDirRel : ''
    )
  );
  handle(DESKTOP_IPC.copyProjectEntry, (_event, projectPath, relPath, targetDirRel) =>
    host.copyProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      typeof targetDirRel === 'string' ? targetDirRel : ''
    )
  );
  handle(DESKTOP_IPC.trashProjectEntry, async (_event, projectPath, relPath, options) => {
    if (server) {
      // The server's trash, or — only when the renderer asked for it after
      // saying so — a permanent delete. This PC's recycle bin is never used.
      const permanent = (options as { permanent?: unknown } | undefined)?.permanent === true;
      const root = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
      await invokeDesktopOperation('serverTrashEntry', [root, requiredString(relPath, 'relPath', 4_096), permanent]);
      return;
    }
    const target = await host.projectEntryPath(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath')
    );
    await shell.trashItem(target);
  });
}

function registerLspIpc({ handle, host, invokeDesktopOperation }: ProjectFileContext): void {
  handle(DESKTOP_IPC.projectRecovery, async (_event, projectPath, input) => {
    const request = requiredProjectRecoveryRequest(input);
    const root = await (host.projectRecoveryDirectory?.bind(host) ?? host.projectDirectory.bind(host))(requiredString(projectPath, 'projectPath'));
    return invokeDesktopOperation('projectRecoveryIn', [root, request]);
  });
  handle(DESKTOP_IPC.codeGraphQuery, (_event, projectPath, mode, symbol) => {
    if (mode !== 'find_symbol' && mode !== 'references' && mode !== 'symbols') {
      throw new TypeError('mode is invalid.');
    }
    return host.codeGraphQuery(requiredString(projectPath, 'projectPath'), mode, requiredString(symbol, 'symbol'));
  });
  handle(DESKTOP_IPC.lspDocument, async (_event, rawInput) => {
    const input = requiredLspDocumentInput(rawInput);
    const root = await host.projectDirectory(input.projectPath);
    return invokeDesktopOperation('lspDocument', [input.projectPath, root, input]);
  });
  handle(DESKTOP_IPC.lspRequest, async (_event, rawInput) => {
    const input = requiredLspRequestInput(rawInput);
    const root = await host.projectDirectory(input.projectPath);
    return invokeDesktopOperation('lspRequest', [
      input.projectPath,
      root,
      input.relPath,
      input.languageId,
      input.method,
      input.params ?? {},
    ]);
  });
  handle(DESKTOP_IPC.lspApplyWorkspaceEdit, async (_event, projectPath, rawWrites) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    return invokeDesktopOperation('writeProjectTextFilesIn', [root, requiredWorkspaceTextWrites(rawWrites)]);
  });
}
