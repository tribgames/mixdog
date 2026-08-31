import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { childEnvironment } from './child-environment';
import * as editorBackups from './editor-backups';
import * as folderExplorer from './folder-explorer';
import * as gh from './gh-cli';
import * as git from './git-cli';
import * as github from './github-cli';
import { LanguageServerManager } from './language-server-manager';
import * as libreoffice from './libreoffice';
import * as projectFiles from './project-files';
import { listShellProfiles, resolveShellProfileSpawn } from './shell-profiles';
import { DesktopSettingsStore } from './settings-store';
import type { MixdogConfigModule } from './settings-store';
import { TerminalManager } from './terminal-manager';
import * as workspaceConfig from './workspace-config';
import * as workspaceSearch from './workspace-search';
import { createCommitMessageGenerator } from './commit-message';
import type { CommitCompletionModule } from './commit-message';
import { createDocumentPreviewOperations } from './document-preview';
import type { DocumentPreviewModule } from './document-preview';

export interface DesktopOperationEvent {
  name: 'folder-changed' | 'lsp-diagnostics' | 'lsp-status' | 'terminal-data';
  value: unknown;
}

interface DesktopOperationsOptions {
  userDataPath: string;
  packaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  loadConfig?: () => Promise<MixdogConfigModule>;
  loadCommitCompletion?: () => Promise<CommitCompletionModule>;
  loadDocumentPreview?: () => Promise<DocumentPreviewModule>;
  emit(event: DesktopOperationEvent): void;
}

const GITHUB_REPO_SLUG = 'tribgames/mixdog';

function runGh(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((done) => {
    execFile('gh', args, {
      timeout: 8_000,
      windowsHide: true,
      env: childEnvironment(),
    }, (error, _stdout, stderr) => {
      done({ ok: !error, stderr: String(stderr || '') });
    });
  });
}

async function githubStarStatus(): Promise<{ available: boolean; starred: boolean }> {
  const probe = await runGh(['api', `user/starred/${GITHUB_REPO_SLUG}`, '--silent']);
  if (probe.ok) return { available: true, starred: true };
  if (/HTTP 404/i.test(probe.stderr)) return { available: true, starred: false };
  return { available: false, starred: false };
}

async function starGithub(): Promise<{ starred: boolean }> {
  const result = await runGh(['api', '-X', 'PUT', `user/starred/${GITHUB_REPO_SLUG}`, '--silent']);
  if (!result.ok) throw new Error(result.stderr.trim() || 'gh could not star the repository.');
  return { starred: true };
}

const STATIC_OPERATIONS = {
  copyFolderEntriesAbs: folderExplorer.copyFolderEntriesAbs,
  createFolderEntryAbs: folderExplorer.createFolderEntryAbs,
  deleteEditorBackup: editorBackups.deleteEditorBackup,
  ghPrCheckout: gh.ghPrCheckout,
  ghPrCreate: gh.ghPrCreate,
  ghPrDefaultBranch: gh.ghPrDefaultBranch,
  ghPrDiff: gh.ghPrDiff,
  ghPrList: gh.ghPrList,
  ghPrMerge: gh.ghPrMerge,
  ghPrView: gh.ghPrView,
  cancelGithubCliLogin: github.cancelGithubCliLogin,
  githubCliAccount: github.githubCliAccount,
  githubCliLoginStart: github.githubCliLoginStart,
  githubCliLoginStatus: github.githubCliLoginStatus,
  githubCliLogout: github.githubCliLogout,
  githubCliStatus: github.githubCliStatus,
  gitCliStatus: github.gitCliStatus,
  gitGlobalConfig: github.gitGlobalConfig,
  installGitCli: github.installGitCli,
  installGithubCli: github.installGithubCli,
  setGitGlobalConfig: github.setGitGlobalConfig,
  installLibreOffice: libreoffice.installLibreOffice,
  libreOfficeStatus: libreoffice.libreOfficeStatus,
  gitAbortOperation: git.gitAbortOperation,
  gitAmend: git.gitAmend,
  gitApplyPatch: git.gitApplyPatch,
  gitBranches: git.gitBranches,
  gitCheckoutBranch: git.gitCheckoutBranch,
  gitCheckoutCommit: git.gitCheckoutCommit,
  gitCherryPickCommit: git.gitCherryPickCommit,
  gitCommit: git.gitCommit,
  gitCommitPaths: git.gitCommitPaths,
  gitContinue: git.gitContinue,
  gitCreateBranch: git.gitCreateBranch,
  gitCreateBranchAtCommit: git.gitCreateBranchAtCommit,
  gitCreateTag: git.gitCreateTag,
  gitDeleteBranch: git.gitDeleteBranch,
  gitDeleteTag: git.gitDeleteTag,
  gitDiff: git.gitDiff,
  gitFetch: git.gitFetch,
  gitIgnore: git.gitIgnore,
  gitLog: git.gitLog,
  gitMergeBranch: git.gitMergeBranch,
  gitPull: git.gitPull,
  gitPush: git.gitPush,
  gitRenameBranch: git.gitRenameBranch,
  gitResetToCommit: git.gitResetToCommit,
  gitRevertCommit: git.gitRevertCommit,
  gitRevertFile: git.gitRevertFile,
  gitReview: git.gitReview,
  gitReviewDiff: git.gitReviewDiff,
  gitShow: git.gitShow,
  gitShowDiff: git.gitShowDiff,
  gitShowFile: git.gitShowFile,
  gitStage: git.gitStage,
  gitStash: git.gitStash,
  gitStashApply: git.gitStashApply,
  gitStashDrop: git.gitStashDrop,
  gitStashList: git.gitStashList,
  gitStashPop: git.gitStashPop,
  gitStatus: git.gitStatus,
  gitSync: git.gitSync,
  gitUndoLastCommit: git.gitUndoLastCommit,
  gitUnstage: git.gitUnstage,
  listFolderDirAbs: folderExplorer.listFolderDirAbs,
  listFolderPlaces: folderExplorer.listFolderPlaces,
  moveFolderEntriesAbs: folderExplorer.moveFolderEntriesAbs,
  readEditorBackup: editorBackups.readEditorBackup,
  readLocalFileAbs: folderExplorer.readLocalFileAbs,
  statLocalEntryAbs: folderExplorer.statLocalEntryAbs,
  readProjectTextFileIn: projectFiles.readProjectTextFileIn,
  readScopedEditorSettings: workspaceConfig.readScopedEditorSettings,
  readWorkspaceFile: workspaceConfig.readWorkspaceFile,
  renameFolderEntryAbs: folderExplorer.renameFolderEntryAbs,
  replaceWorkspaceTextIn: workspaceSearch.replaceWorkspaceTextIn,
  searchWorkspaceTextIn: workspaceSearch.searchWorkspaceTextIn,
  statProjectFileIn: projectFiles.statProjectFileIn,
  writeEditorBackup: editorBackups.writeEditorBackup,
  writeProjectTextFileIn: projectFiles.writeProjectTextFileIn,
  writeProjectTextFilesIn: projectFiles.writeProjectTextFilesIn,
  writeWorkspaceFile: workspaceConfig.writeWorkspaceFile,
} satisfies Record<string, (...args: any[]) => unknown>;

export function createDesktopOperations({
  userDataPath,
  packaged,
  resourcesPath,
  appPath,
  loadConfig,
  loadCommitCompletion,
  loadDocumentPreview,
  emit,
}: DesktopOperationsOptions) {
  const languageServers = new LanguageServerManager();
  const terminals = new TerminalManager();
  const settingsStore = new DesktopSettingsStore({
    packaged,
    resourcesPath,
    appPath,
    loadConfig,
  });
  const generateCommitMessage = createCommitMessageGenerator({
    packaged,
    resourcesPath,
    appPath,
    loadModule: loadCommitCompletion,
  });
  // Converted documents are a cache, not user data: they live under the app's
  // own directory and are evicted, never synced or backed up.
  const documentPreviews = createDocumentPreviewOperations({
    cacheRoot: userDataPath,
    loadDocumentPreview,
  });
  const folderWatchers = new Map<string, {
    watcher: FSWatcher;
    count: number;
    timer: NodeJS.Timeout | null;
  }>();
  const watchKey = (path: string) =>
    process.platform === 'win32' ? path.toLocaleLowerCase() : path;
  const unsubscribeDiagnostics = languageServers.subscribeDiagnostics((value) => {
    emit({ name: 'lsp-diagnostics', value });
  });
  const unsubscribeStatus = languageServers.subscribeStatus((value) => {
    emit({ name: 'lsp-status', value });
  });
  // PTY output is bursty: node-pty emits one chunk per read, and each chunk
  // used to become its own daemon frame, SSE write, and renderer IPC message.
  // Joining the chunks that land inside one coalescing window collapses that
  // traffic without holding the first byte longer than a frame.
  const TERMINAL_COALESCE_MS = 8;
  const terminalChunks = new Map<string, string[]>();
  const terminalTimers = new Map<string, NodeJS.Timeout>();
  const dropTerminalBuffer = (id: string): void => {
    const timer = terminalTimers.get(id);
    if (timer) clearTimeout(timer);
    terminalTimers.delete(id);
    terminalChunks.delete(id);
  };
  const flushTerminal = (id: string): void => {
    const chunks = terminalChunks.get(id);
    dropTerminalBuffer(id);
    if (!chunks || chunks.length === 0) return;
    emit({ name: 'terminal-data', value: { id, data: chunks.join('') } });
  };
  const unsubscribeTerminals = terminals.subscribe((value) => {
    const id = String(value?.id || '');
    const data = String(value?.data || '');
    if (!id || !data) return;
    const chunks = terminalChunks.get(id);
    if (chunks) { chunks.push(data); return; }
    terminalChunks.set(id, [data]);
    const timer = setTimeout(() => flushTerminal(id), TERMINAL_COALESCE_MS);
    timer.unref();
    terminalTimers.set(id, timer);
  });

  async function invoke(name: string, args: unknown[] = []): Promise<unknown> {
    const staticOperation = STATIC_OPERATIONS[name as keyof typeof STATIC_OPERATIONS] as
      | ((...values: unknown[]) => unknown)
      | undefined;
    if (staticOperation) return await staticOperation(...args);
    if (name === 'documentPreviewIn') {
      return documentPreviews.documentPreviewIn(String(args[0] || ''), String(args[1] || ''));
    }
    if (name === 'documentPreviewPagesIn') {
      return documentPreviews.documentPreviewPagesIn(
        String(args[0] || ''),
        String(args[1] || ''),
        (args[2] ?? {}) as { pages?: unknown; maxWidth?: unknown },
      );
    }
    if (name === 'readSettings') return settingsStore.read();
    if (name === 'updateSetting') {
      return settingsStore.update(
        args[0] as Parameters<DesktopSettingsStore['update']>[0],
        args[1] === true,
      );
    }
    if (name === 'readGitPreferences') return settingsStore.readGitPreferences();
    if (name === 'updateGitPreferences') {
      return settingsStore.updateGitPreferences(
        (args[0] ?? {}) as Parameters<DesktopSettingsStore['updateGitPreferences']>[0],
      );
    }
    if (name === 'readZoom') return settingsStore.readZoom();
    if (name === 'updateZoom') return settingsStore.updateZoom(Number(args[0]));
    if (name === 'githubStarStatus') return githubStarStatus();
    if (name === 'starGithub') return starGithub();
    if (name === 'gitGenerateCommitMessage') {
      return generateCommitMessage(
        String(args[0] || ''),
        args[1] as Parameters<typeof generateCommitMessage>[1],
        args[2] as Parameters<typeof generateCommitMessage>[2],
      );
    }
    if (name === 'readInstructions') {
      const [file, legacyFile] = args.map((value) => String(value || ''));
      try {
        return await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      if (legacyFile) {
        try { return await readFile(legacyFile, 'utf8'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
      }
      return '';
    }
    if (name === 'writeInstructions') {
      const [file, content] = args;
      const path = resolve(String(file || ''));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, String(content ?? ''), 'utf8');
      return null;
    }
    if (name === 'lspDocument') {
      return languageServers.document(
        String(args[0] || ''),
        String(args[1] || ''),
        args[2] as Parameters<LanguageServerManager['document']>[2],
      );
    }
    if (name === 'lspRequest') {
      return languageServers.request(
        String(args[0] || ''),
        String(args[1] || ''),
        String(args[2] || ''),
        String(args[3] || ''),
        args[4] as Parameters<LanguageServerManager['request']>[4],
        args[5] as Parameters<LanguageServerManager['request']>[5],
      );
    }
    if (name === 'termEnsure') {
      const requestedProfile = args[2];
      const profile = requestedProfile && typeof requestedProfile === 'object'
        ? requestedProfile as Parameters<TerminalManager['ensure']>[2]
        : await resolveShellProfileSpawn(requestedProfile);
      return terminals.ensure(
        typeof args[0] === 'string' && args[0] ? args[0] : null,
        typeof args[1] === 'string' && args[1] ? args[1] : null,
        profile,
      );
    }
    if (name === 'termProfiles') return listShellProfiles();
    if (name === 'termWrite') {
      terminals.write(String(args[0] || ''), String(args[1] ?? ''));
      return null;
    }
    if (name === 'termResize') {
      terminals.resize(String(args[0] || ''), Number(args[1]), Number(args[2]));
      return null;
    }
    if (name === 'termPause') {
      terminals.pauseOutput(String(args[0] || ''));
      return null;
    }
    if (name === 'termResume') {
      terminals.resumeOutput(String(args[0] || ''));
      return null;
    }
    if (name === 'termDispose') {
      const terminalId = String(args[0] || '');
      dropTerminalBuffer(terminalId);
      terminals.dispose(terminalId);
      return null;
    }
    if (name === 'folderWatch') {
      const dir = folderExplorer.browsableFolderPath(args[0]);
      const recursive = args[1] === true;
      const key = `${watchKey(dir)}\0${recursive ? 'recursive' : 'direct'}`;
      const existing = folderWatchers.get(key);
      if (existing) {
        existing.count += 1;
        return null;
      }
      const watcher = watch(dir, { persistent: false, recursive }, () => {
        const state = folderWatchers.get(key);
        if (!state || state.timer) return;
        state.timer = setTimeout(() => {
          state.timer = null;
          emit({ name: 'folder-changed', value: dir });
        }, 250);
      });
      watcher.on('error', () => {
        const state = folderWatchers.get(key);
        if (state?.timer) clearTimeout(state.timer);
        folderWatchers.delete(key);
      });
      folderWatchers.set(key, { watcher, count: 1, timer: null });
      return null;
    }
    if (name === 'folderUnwatch') {
      const dir = folderExplorer.browsableFolderPath(args[0]);
      const recursive = args[1] === true;
      const key = `${watchKey(dir)}\0${recursive ? 'recursive' : 'direct'}`;
      const state = folderWatchers.get(key);
      if (!state) return null;
      state.count -= 1;
      if (state.count <= 0) {
        if (state.timer) clearTimeout(state.timer);
        try { state.watcher.close(); } catch {}
        folderWatchers.delete(key);
      }
      return null;
    }
    throw new TypeError('Mixdog desktop service operation is unavailable.');
  }

  async function dispose(): Promise<void> {
    unsubscribeDiagnostics();
    unsubscribeStatus();
    unsubscribeTerminals();
    for (const timer of terminalTimers.values()) clearTimeout(timer);
    terminalTimers.clear();
    terminalChunks.clear();
    for (const state of folderWatchers.values()) {
      if (state.timer) clearTimeout(state.timer);
      try { state.watcher.close(); } catch {}
    }
    folderWatchers.clear();
    terminals.disposeAll();
    await languageServers.dispose();
  }

  const remoteTerminals = {
    ensure(
      id: string | null,
      cwd: string | null,
      profile?: import('./terminal-contract').TerminalSpawnProfile | string | null,
    ) {
      return invoke('termEnsure', [id, cwd, profile ?? null]) as Promise<{ id: string; replay: string }>;
    },
    write(id: string, data: string): void {
      void invoke('termWrite', [id, data]).catch(() => {});
    },
    resize(id: string, cols: number, rows: number): void {
      void invoke('termResize', [id, cols, rows]).catch(() => {});
    },
  };

  return {
    invoke,
    dispose,
    userDataPath,
    terminals: remoteTerminals,
    settingsStore,
    subscribeTerminalData: (listener: (event: { id: string; data: string }) => void) =>
      terminals.subscribe(listener),
  };
}
