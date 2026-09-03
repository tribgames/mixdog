import type { App, IpcMainInvokeEvent, Shell } from 'electron';
import { DESKTOP_IPC } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';
import { registerFilePreview } from './file-preview';
import { projectEntryPathIn } from './project-files';
import {
  requiredLspDocumentInput,
  requiredLspRequestInput,
  requiredString,
  requiredTextFileContent,
  requiredTextFileEncoding,
  requiredWorkspaceTextWrites,
} from './ipc-validation';

type Handle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) => void;

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
  shell: Pick<Shell, 'trashItem'>;
  grantedFile: (
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown,
  ) => Promise<GrantedFile>;
}

export function registerProjectFileIpc({
  app,
  handle,
  host,
  invokeDesktopOperation,
  shell,
  grantedFile,
}: ProjectFileIpcOptions): void {
  const editorFilePath = async (
    projectPath: unknown,
    relPath: unknown,
    accessToken: unknown,
  ): Promise<string> => {
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
    accessToken: unknown,
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
  const editorBackupRoot = typeof app.getPath === 'function'
    ? app.getPath('userData')
    : '';

  handle(DESKTOP_IPC.listProjectDir, (_event, projectPath, relDir) =>
    host.listProjectDir(
      requiredString(projectPath, 'projectPath'),
      typeof relDir === 'string' ? relDir : '',
    ));
  handle(DESKTOP_IPC.readProjectFile, async (_event, projectPath, relPath, accessToken) => {
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return invokeDesktopOperation(
        'readProjectTextFileIn',
        [granted.root, granted.rel],
      );
    }
    return host.readProjectTextFile(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    );
  });
  handle(DESKTOP_IPC.previewProjectFile, async (_event, projectPath, relPath, accessToken) => {
    let file: string;
    let info: { mtimeMs: number; size: number };
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      file = granted.absolute;
      info = await invokeDesktopOperation(
        'statProjectFileIn',
        [granted.root, granted.rel],
      );
    } else {
      const cleanProject = requiredString(projectPath, 'projectPath');
      const cleanRel = requiredString(relPath, 'relPath');
      const root = await host.projectDirectory(cleanProject);
      file = projectEntryPathIn(root, cleanRel);
      info = await invokeDesktopOperation(
        'statProjectFileIn',
        [root, cleanRel],
      );
    }
    const preview = registerFilePreview(file, `${info.mtimeMs}:${info.size}`);
    if (!preview) throw new Error('This file type does not support an in-app preview.');
    return { ...preview, ...info };
  });
  handle(DESKTOP_IPC.previewDocumentFile, async (_event, projectPath, relPath, accessToken) => {
    const target = await editorFileTarget(projectPath, relPath, accessToken);
    const converted = await invokeDesktopOperation(
      'documentPreviewIn',
      [target.root, target.rel],
    ) as { path: string; format: string; mtimeMs: number; size: number };
    const preview = registerFilePreview(converted.path, `${converted.mtimeMs}:${converted.size}`);
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
  handle(DESKTOP_IPC.previewDocumentPages, async (
    _event,
    projectPath,
    relPath,
    accessToken,
    options,
  ) => {
    const target = await editorFileTarget(projectPath, relPath, accessToken);
    return invokeDesktopOperation(
      'documentPreviewPagesIn',
      [target.root, target.rel, options ?? {}],
    );
  });
  handle(DESKTOP_IPC.writeProjectFile, async (
    _event,
    projectPath,
    relPath,
    content,
    expectedContent,
    accessToken,
    encoding,
  ) => {
    const text = requiredTextFileContent(content, 'file content');
    const expected = requiredTextFileContent(expectedContent, 'expected file content');
    const fileEncoding = requiredTextFileEncoding(encoding);
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return invokeDesktopOperation(
        'writeProjectTextFileIn',
        [granted.root, granted.rel, text, expected, fileEncoding],
      );
    }
    return host.writeProjectTextFile(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      text,
      expected,
      fileEncoding,
    );
  });
  handle(DESKTOP_IPC.readEditorBackup, async (_event, projectPath, relPath, accessToken) => {
    if (!editorBackupRoot) return null;
    return invokeDesktopOperation(
      'readEditorBackup',
      [editorBackupRoot, await editorFilePath(projectPath, relPath, accessToken)],
    );
  });
  handle(DESKTOP_IPC.writeEditorBackup, async (
    _event,
    projectPath,
    relPath,
    content,
    expectedContent,
    accessToken,
  ) => {
    if (!editorBackupRoot) throw new Error('Editor backup storage is unavailable.');
    return invokeDesktopOperation(
      'writeEditorBackup',
      [
        editorBackupRoot,
        await editorFilePath(projectPath, relPath, accessToken),
        content,
        expectedContent,
      ],
    );
  });
  handle(DESKTOP_IPC.deleteEditorBackup, async (_event, projectPath, relPath, accessToken) => {
    if (!editorBackupRoot) return;
    await invokeDesktopOperation(
      'deleteEditorBackup',
      [editorBackupRoot, await editorFilePath(projectPath, relPath, accessToken)],
    );
  });
  handle(DESKTOP_IPC.statProjectFile, async (_event, projectPath, relPath, accessToken) => {
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return invokeDesktopOperation(
        'statProjectFileIn',
        [granted.root, granted.rel],
      );
    }
    return host.statProjectFile(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    );
  });
  handle(DESKTOP_IPC.createProjectEntry, (_event, projectPath, relDir, name, dir) =>
    host.createProjectEntry(
      requiredString(projectPath, 'projectPath'),
      typeof relDir === 'string' ? relDir : '',
      requiredString(name, 'name'),
      dir === true,
    ));
  handle(DESKTOP_IPC.renameProjectEntry, (_event, projectPath, relPath, newName) =>
    host.renameProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      requiredString(newName, 'newName'),
    ));
  handle(DESKTOP_IPC.moveProjectEntry, (_event, projectPath, relPath, targetDirRel) =>
    host.moveProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      typeof targetDirRel === 'string' ? targetDirRel : '',
    ));
  handle(DESKTOP_IPC.copyProjectEntry, (_event, projectPath, relPath, targetDirRel) =>
    host.copyProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      typeof targetDirRel === 'string' ? targetDirRel : '',
    ));
  handle(DESKTOP_IPC.trashProjectEntry, async (_event, projectPath, relPath) => {
    const target = await host.projectEntryPath(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    );
    await shell.trashItem(target);
  });
  handle(DESKTOP_IPC.codeGraphQuery, (_event, projectPath, mode, symbol) => {
    if (mode !== 'find_symbol' && mode !== 'references' && mode !== 'symbols') {
      throw new TypeError('mode is invalid.');
    }
    return host.codeGraphQuery(
      requiredString(projectPath, 'projectPath'),
      mode,
      requiredString(symbol, 'symbol'),
    );
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
    return invokeDesktopOperation(
      'writeProjectTextFilesIn',
      [root, requiredWorkspaceTextWrites(rawWrites)],
    );
  });
}
