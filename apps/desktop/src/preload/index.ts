// Typed IPC bridge: explicit method allow-list, no arbitrary invoke.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

import {
  DESKTOP_IPC,
  type DesktopAgentPoolRow,
  type DesktopApi,
  type DesktopSessionSummary,
  type DesktopSessionStateUpdate,
  type DesktopSessionStateWireUpdate,
  type DesktopLspDiagnosticEvent,
  type DesktopLspStatusEvent,
  type DesktopStateFieldsPatch,
  type DesktopStateItemsPatch,
  type DesktopStateStreamingTailPatch,
  type DesktopStateWire,
  type DesktopTranscriptItem,
  type EngineSnapshot,
  type DesktopUpdaterState,
} from '../shared/contract';
import { createSnapshotDeltaDecoder } from '../main/state-delta';

function additionalArgument(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? '';
}

const bootId = additionalArgument('mixdog-boot-id');
const processStartedAt = Number(additionalArgument('mixdog-process-started-at'));
const bootScenario = additionalArgument('mixdog-boot-scenario');

const api: DesktopApi = {
  ...(bootId && Number.isFinite(processStartedAt)
    ? {
      bootContext: Object.freeze({
        bootId,
        processStartedAt,
        ...(bootScenario ? { scenario: bootScenario } : {}),
      }),
    }
    : {}),
  chooseProject: () => ipcRenderer.invoke(DESKTOP_IPC.chooseProject),
  chooseFile: (defaultPath) => ipcRenderer.invoke(DESKTOP_IPC.chooseFile, defaultPath),
  chooseWorkspace: () => ipcRenderer.invoke(DESKTOP_IPC.chooseWorkspace),
  saveWorkspace: (workspaceFile, folders) =>
    ipcRenderer.invoke(DESKTOP_IPC.saveWorkspace, workspaceFile, folders),
  readEditorSettings: (projectPath, relPath, workspaceFile) =>
    ipcRenderer.invoke(
      DESKTOP_IPC.readEditorSettings,
      projectPath,
      relPath,
      workspaceFile,
    ),
  startProject: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.startProject, projectPath),
  startProjectTask: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.startProjectTask, projectPath),
  startTask: () => ipcRenderer.invoke(DESKTOP_IPC.startTask),
  listProjects: () => ipcRenderer.invoke(DESKTOP_IPC.listProjects),
  addProject: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.addProject, projectPath),
  openProjectInExplorer: (projectPath) =>
    ipcRenderer.invoke(DESKTOP_IPC.openProjectInExplorer, projectPath),
  openExternal: (url) => ipcRenderer.invoke(DESKTOP_IPC.openExternal, url),
  githubStarStatus: () => ipcRenderer.invoke(DESKTOP_IPC.githubStarStatus),
  starGithub: () => ipcRenderer.invoke(DESKTOP_IPC.starGithub),
  githubCliStatus: () => ipcRenderer.invoke(DESKTOP_IPC.githubCliStatus),
  installGithubCli: () => ipcRenderer.invoke(DESKTOP_IPC.installGithubCli),
  githubCliLoginStart: () => ipcRenderer.invoke(DESKTOP_IPC.githubCliLoginStart),
  githubCliLoginStatus: (flowId) => ipcRenderer.invoke(DESKTOP_IPC.githubCliLoginStatus, flowId),
  githubCliLoginCancel: (flowId) => ipcRenderer.invoke(DESKTOP_IPC.githubCliLoginCancel, flowId),
  githubCliLogout: () => ipcRenderer.invoke(DESKTOP_IPC.githubCliLogout),
  githubCliAccount: () => ipcRenderer.invoke(DESKTOP_IPC.githubCliAccount),
  gitGlobalConfig: () => ipcRenderer.invoke(DESKTOP_IPC.gitGlobalConfig),
  setGitGlobalConfig: (key, value) =>
    ipcRenderer.invoke(DESKTOP_IPC.setGitGlobalConfig, key, value),
  readGitPreferences: () => ipcRenderer.invoke(DESKTOP_IPC.readGitPreferences),
  updateGitPreferences: (preferences) =>
    ipcRenderer.invoke(DESKTOP_IPC.updateGitPreferences, preferences),
  renameProject: (projectPath, alias) =>
    ipcRenderer.invoke(DESKTOP_IPC.renameProject, projectPath, alias),
  removeProject: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.removeProject, projectPath),
  readInstructions: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.readInstructions, projectPath),
  writeInstructions: (projectPath, content) =>
    ipcRenderer.invoke(DESKTOP_IPC.writeInstructions, projectPath, content),
  listProjectDir: (projectPath, relDir) =>
    ipcRenderer.invoke(DESKTOP_IPC.listProjectDir, projectPath, relDir),
  chooseFolder: () => ipcRenderer.invoke(DESKTOP_IPC.chooseFolder),
  listFolderDir: (dir) => ipcRenderer.invoke(DESKTOP_IPC.listFolderDir, dir),
  createFolderEntry: (dir, name, isDir) =>
    ipcRenderer.invoke(DESKTOP_IPC.createFolderEntry, dir, name, isDir),
  renameFolderEntry: (path, newName) =>
    ipcRenderer.invoke(DESKTOP_IPC.renameFolderEntry, path, newName),
  moveFolderEntry: (paths, targetDir, strategy) =>
    ipcRenderer.invoke(DESKTOP_IPC.moveFolderEntry, paths, targetDir, strategy),
  copyFolderEntry: (paths, targetDir) =>
    ipcRenderer.invoke(DESKTOP_IPC.copyFolderEntry, paths, targetDir),
  trashFolderEntry: (path) => ipcRenderer.invoke(DESKTOP_IPC.trashFolderEntry, path),
  openFolderEntry: (path) => ipcRenderer.invoke(DESKTOP_IPC.openFolderEntry, path),
  revealFolderEntry: (path) => ipcRenderer.invoke(DESKTOP_IPC.revealFolderEntry, path),
  folderPlaces: () => ipcRenderer.invoke(DESKTOP_IPC.folderPlaces),
  folderEntryIcon: (path, thumbnail, size) =>
    ipcRenderer.invoke(DESKTOP_IPC.folderEntryIcon, path, thumbnail === true, size),
  // Explorer pane: absolute path for an OS-native file drop (File.path was
  // removed in modern Electron; webUtils must resolve it in the preload).
  folderPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  folderWatch: (dir) => ipcRenderer.invoke(DESKTOP_IPC.folderWatch, dir),
  folderUnwatch: (dir) => ipcRenderer.invoke(DESKTOP_IPC.folderUnwatch, dir),
  subscribeFolderChanges: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, dir: string): void => {
      listener(String(dir || ''));
    };
    ipcRenderer.on(DESKTOP_IPC.folderChanged, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.folderChanged, receive);
  },
  readProjectFile: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.readProjectFile, projectPath, relPath, accessToken),
  previewProjectFile: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.previewProjectFile, projectPath, relPath, accessToken),
  writeProjectFile: (projectPath, relPath, content, expectedContent, accessToken, encoding) =>
    ipcRenderer.invoke(
      DESKTOP_IPC.writeProjectFile,
      projectPath,
      relPath,
      content,
      expectedContent,
      accessToken,
      encoding,
    ),
  readEditorBackup: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.readEditorBackup, projectPath, relPath, accessToken),
  writeEditorBackup: (projectPath, relPath, content, expectedContent, accessToken) =>
    ipcRenderer.invoke(
      DESKTOP_IPC.writeEditorBackup,
      projectPath,
      relPath,
      content,
      expectedContent,
      accessToken,
    ),
  deleteEditorBackup: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.deleteEditorBackup, projectPath, relPath, accessToken),
  statProjectFile: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.statProjectFile, projectPath, relPath, accessToken),
  createProjectEntry: (projectPath, relDir, name, dir) =>
    ipcRenderer.invoke(DESKTOP_IPC.createProjectEntry, projectPath, relDir, name, dir),
  renameProjectEntry: (projectPath, relPath, newName) =>
    ipcRenderer.invoke(DESKTOP_IPC.renameProjectEntry, projectPath, relPath, newName),
  trashProjectEntry: (projectPath, relPath) =>
    ipcRenderer.invoke(DESKTOP_IPC.trashProjectEntry, projectPath, relPath),
  moveProjectEntry: (projectPath, relPath, targetDirRel) =>
    ipcRenderer.invoke(DESKTOP_IPC.moveProjectEntry, projectPath, relPath, targetDirRel),
  copyProjectEntry: (projectPath, relPath, targetDirRel) =>
    ipcRenderer.invoke(DESKTOP_IPC.copyProjectEntry, projectPath, relPath, targetDirRel),
  codeGraphQuery: (projectPath, mode, symbol) =>
    ipcRenderer.invoke(DESKTOP_IPC.codeGraphQuery, projectPath, mode, symbol),
  lspDocument: (input) => ipcRenderer.invoke(DESKTOP_IPC.lspDocument, input),
  lspRequest: (input) => ipcRenderer.invoke(DESKTOP_IPC.lspRequest, input),
  lspApplyWorkspaceEdit: (projectPath, writes) =>
    ipcRenderer.invoke(DESKTOP_IPC.lspApplyWorkspaceEdit, projectPath, writes),
  subscribeLspDiagnostics: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      payload: DesktopLspDiagnosticEvent,
    ): void => listener(payload);
    ipcRenderer.on(DESKTOP_IPC.lspDiagnostics, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.lspDiagnostics, receive);
  },
  subscribeLspStatus: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      payload: DesktopLspStatusEvent,
    ): void => listener(payload);
    ipcRenderer.on(DESKTOP_IPC.lspStatus, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.lspStatus, receive);
  },
  listSessions: () => ipcRenderer.invoke(DESKTOP_IPC.listSessions),
  subscribeSessions: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, sessions: DesktopSessionSummary[]): void => {
      listener(sessions);
    };
    ipcRenderer.on(DESKTOP_IPC.sessionsChanged, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.sessionsChanged, receive);
  },
  listAgentPool: () => ipcRenderer.invoke(DESKTOP_IPC.listAgentPool),
  subscribeAgentPool: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, agents: DesktopAgentPoolRow[]): void => {
      listener(agents);
    };
    ipcRenderer.on(DESKTOP_IPC.agentPoolChanged, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.agentPoolChanged, receive);
  },
  renameSession: (sessionId, title) => ipcRenderer.invoke(DESKTOP_IPC.renameSession, sessionId, title),
  setSessionArchived: (sessionId, archived) =>
    ipcRenderer.invoke(DESKTOP_IPC.setSessionArchived, sessionId, archived),
  deleteSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.deleteSession, sessionId),
  getRemoteAccessInfo: () => ipcRenderer.invoke(DESKTOP_IPC.remoteAccessInfo),
  rotateRemoteAccess: () => ipcRenderer.invoke(DESKTOP_IPC.rotateRemoteAccess),
  prefetchSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.prefetchSession, sessionId),
  peekSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.peekSession, sessionId),
  setVisibleSessions: (sessionIds) =>
    ipcRenderer.invoke(DESKTOP_IPC.setVisibleSessions, sessionIds),
  resumeSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.resumeSession, sessionId),
  searchProjectFiles: (projectIdOrWorkspaceId, query, limit) =>
    ipcRenderer.invoke(DESKTOP_IPC.searchProjectFiles, projectIdOrWorkspaceId, query, limit),
  searchWorkspaceText: (projectPath, options) =>
    ipcRenderer.invoke(DESKTOP_IPC.searchWorkspaceText, projectPath, options),
  replaceWorkspaceText: (projectPath, options, replacement, relPaths) =>
    ipcRenderer.invoke(DESKTOP_IPC.replaceWorkspaceText, projectPath, options, replacement, relPaths),
  getSnapshot: () => ipcRenderer.invoke(DESKTOP_IPC.getSnapshot),
  subscribeState: (listener) => {
    // Reassemble transcript deltas (see DesktopStateWire): the host sends the
    // full items array once, then identity-prefix patches. Renderers keep
    // consuming complete EngineSnapshot objects; unchanged items retain their
    // object identity across snapshots, so memoized rows skip re-rendering.
    let items: unknown[] = [];
    let streamingTail: DesktopTranscriptItem | null = null;
    let stateFields: Record<string, unknown> = {};
    let revision: number | null = null;
    const stateFieldsFrom = (record: Record<string, unknown>): Record<string, unknown> => {
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (
          key !== 'items'
          && key !== 'streamingTail'
          && key !== '__itemsRevision'
          && key !== '__itemsPatch'
          && key !== '__streamingTailPatch'
          && key !== '__statePatch'
        ) {
          fields[key] = value;
        }
      }
      return fields;
    };
    const receive = (_event: Electron.IpcRendererEvent, wire: DesktopStateWire): void => {
      if (!wire || typeof wire !== 'object') {
        items = [];
        streamingTail = null;
        stateFields = {};
        revision = null;
        listener(wire as EngineSnapshot);
        return;
      }
      const record = wire as Record<string, unknown>;
      const patch = record.__itemsPatch as DesktopStateItemsPatch | undefined;
      if (!patch) {
        const snapshot = { ...record };
        delete snapshot.__itemsRevision;
        delete snapshot.__statePatch;
        if (Array.isArray(snapshot.items)) {
          items = snapshot.items;
          revision = typeof record.__itemsRevision === 'number' ? record.__itemsRevision : null;
        } else {
          items = [];
          revision = null;
        }
        streamingTail = snapshot.streamingTail && typeof snapshot.streamingTail === 'object'
          ? snapshot.streamingTail as DesktopTranscriptItem
          : null;
        stateFields = stateFieldsFrom(snapshot);
        listener(snapshot as EngineSnapshot);
        return;
      }
      const statePatch = record.__statePatch as DesktopStateFieldsPatch | undefined;
      if (
        revision === null
        || patch.base !== revision
        || (statePatch && (statePatch.base !== revision || statePatch.revision !== patch.revision))
      ) {
        // Lost sync (preload reload, missed event): drop the patch and ask the
        // host to restart from a full snapshot.
        revision = null;
        try { ipcRenderer.send(DESKTOP_IPC.stateResync); } catch { /* next full send recovers */ }
        return;
      }
      if (statePatch) {
        const nextFields = { ...stateFields };
        for (const key of statePatch.removed) delete nextFields[key];
        Object.assign(nextFields, statePatch.changed);
        stateFields = nextFields;
      } else {
        stateFields = stateFieldsFrom(record);
      }
      const tailPatch = record.__streamingTailPatch as DesktopStateStreamingTailPatch | undefined;
      let nextStreamingTail = streamingTail;
      if (tailPatch) {
        const priorText = typeof streamingTail?.text === 'string' ? streamingTail.text : '';
        if (
          !streamingTail
          || streamingTail.id == null
          || streamingTail.id !== tailPatch.tail.id
          || tailPatch.prefix < 0
          || tailPatch.prefix > priorText.length
        ) {
          revision = null;
          try { ipcRenderer.send(DESKTOP_IPC.stateResync); } catch { /* next full send recovers */ }
          return;
        }
        nextStreamingTail = {
          ...tailPatch.tail,
          text: priorText.slice(0, tailPatch.prefix) + tailPatch.append,
        };
      } else if (Object.hasOwn(record, 'streamingTail')) {
        nextStreamingTail = record.streamingTail && typeof record.streamingTail === 'object'
          ? record.streamingTail as DesktopTranscriptItem
          : null;
      }
      // A streaming-tail-only publication carries an empty settled-items
      // patch. Preserve the array identity so renderer memos do not rescan the
      // full transcript for every token flush.
      if (patch.prefix !== items.length || patch.append.length > 0) {
        items = items.slice(0, patch.prefix).concat(patch.append);
      }
      revision = patch.revision;
      const snapshot = { ...stateFields };
      snapshot.items = items;
      snapshot.streamingTail = nextStreamingTail;
      streamingTail = nextStreamingTail;
      listener(snapshot as EngineSnapshot);
    };
    ipcRenderer.on(DESKTOP_IPC.state, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.state, receive);
  },
  perfLog: (line) => {
    try { ipcRenderer.send(DESKTOP_IPC.perfLog, String(line)); } catch { /* diagnostics only */ }
  },
  rendererDiagnostic: (diagnostic) => {
    try { ipcRenderer.send(DESKTOP_IPC.rendererDiagnostic, diagnostic); } catch { /* diagnostics only */ }
  },
  rendererReady: () => {
    try { ipcRenderer.send(DESKTOP_IPC.rendererReady); } catch { /* show falls back to timeout */ }
  },
  termEnsure: (id, cwd, shell) =>
    ipcRenderer.invoke(DESKTOP_IPC.termEnsure, id, cwd ?? null, shell ?? null),
  termProfiles: () => ipcRenderer.invoke(DESKTOP_IPC.termProfiles),
  termWrite: (id, data) => {
    try { ipcRenderer.send(DESKTOP_IPC.termWrite, id, data); } catch { /* keystroke lost */ }
  },
  termResize: (id, cols, rows) => {
    try { ipcRenderer.send(DESKTOP_IPC.termResize, id, cols, rows); } catch { /* next resize wins */ }
  },
  termAcknowledge: (id, charCount) => {
    try { ipcRenderer.send(DESKTOP_IPC.termAcknowledge, id, charCount); } catch { /* teardown */ }
  },
  termDispose: (id) => ipcRenderer.invoke(DESKTOP_IPC.termDispose, id),
  subscribeTermData: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }): void => {
      listener(payload);
    };
    ipcRenderer.on(DESKTOP_IPC.termData, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.termData, receive);
  },
  gitStatus: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitStatus, cwd),
  gitBranches: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitBranches, cwd),
  gitCheckoutBranch: (cwd, branch, remote) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitCheckoutBranch, cwd, branch, remote === true),
  gitCreateBranch: (cwd, branch) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitCreateBranch, cwd, branch),
  gitRenameBranch: (cwd, branch, nextBranch) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitRenameBranch, cwd, branch, nextBranch),
  gitDeleteBranch: (cwd, branch) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitDeleteBranch, cwd, branch),
  gitMergeBranch: (cwd, branch) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitMergeBranch, cwd, branch),
  gitDiff: (cwd, path, staged, worktreeOnly, untracked) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitDiff, cwd, path, staged === true, worktreeOnly === true, untracked === true),
  gitApplyPatch: (cwd, path, patch, reverse) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitApplyPatch, cwd, path, patch, reverse === true),
  gitStage: (cwd, paths) => ipcRenderer.invoke(DESKTOP_IPC.gitStage, cwd, paths),
  gitUnstage: (cwd, paths) => ipcRenderer.invoke(DESKTOP_IPC.gitUnstage, cwd, paths),
  gitIgnore: (cwd, path, scope) => ipcRenderer.invoke(DESKTOP_IPC.gitIgnore, cwd, path, scope),
  gitCommit: (cwd, message) => ipcRenderer.invoke(DESKTOP_IPC.gitCommit, cwd, message),
  gitCommitPaths: (cwd, message, paths) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitCommitPaths, cwd, message, paths),
  gitGenerateCommitMessage: (cwd, files) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitGenerateCommitMessage, cwd, files),
  gitAmend: (cwd, message) => ipcRenderer.invoke(DESKTOP_IPC.gitAmend, cwd, message),
  gitUndoLastCommit: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitUndoLastCommit, cwd),
  gitStash: (cwd, message) => ipcRenderer.invoke(DESKTOP_IPC.gitStash, cwd, message),
  gitStashPop: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitStashPop, cwd),
  gitStashList: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitStashList, cwd),
  gitStashApply: (cwd, ref) => ipcRenderer.invoke(DESKTOP_IPC.gitStashApply, cwd, ref),
  gitStashDrop: (cwd, ref) => ipcRenderer.invoke(DESKTOP_IPC.gitStashDrop, cwd, ref),
  ghPrList: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.ghPrList, cwd),
  ghPrDefaultBranch: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.ghPrDefaultBranch, cwd),
  ghPrCreate: (cwd, input) => ipcRenderer.invoke(DESKTOP_IPC.ghPrCreate, cwd, input),
  ghPrView: (cwd, number) => ipcRenderer.invoke(DESKTOP_IPC.ghPrView, cwd, number),
  ghPrCheckout: (cwd, number) => ipcRenderer.invoke(DESKTOP_IPC.ghPrCheckout, cwd, number),
  ghPrMerge: (cwd, number, method) => ipcRenderer.invoke(DESKTOP_IPC.ghPrMerge, cwd, number, method),
  ghPrDiff: (cwd, number) => ipcRenderer.invoke(DESKTOP_IPC.ghPrDiff, cwd, number),
  gitPush: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitPush, cwd),
  gitFetch: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitFetch, cwd),
  gitPull: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitPull, cwd),
  gitSync: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitSync, cwd),
  gitContinue: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitContinue, cwd),
  gitAbortOperation: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitAbortOperation, cwd),
  gitRevert: (cwd, path, untracked, mode) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitRevert, cwd, path, untracked === true, mode),
  gitLog: (cwd, query, skip, limit) => ipcRenderer.invoke(DESKTOP_IPC.gitLog, cwd, query, skip, limit),
  gitShow: (cwd, hash) => ipcRenderer.invoke(DESKTOP_IPC.gitShow, cwd, hash),
  gitShowDiff: (cwd, hash, path) => ipcRenderer.invoke(DESKTOP_IPC.gitShowDiff, cwd, hash, path),
  gitShowFile: (cwd, rev, path) => ipcRenderer.invoke(DESKTOP_IPC.gitShowFile, cwd, rev, path),
  // `confirmedDirty` is forwarded as the renderer sends it: it is a caller
  // contract (see ipc.ts's handler for why the main side does not demand
  // evidence), and the refusal it waives only unstages work — the destructive
  // `hard` mode has no such flag.
  gitResetToCommit: (cwd, hash, mode, confirmedDirty) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitResetToCommit, cwd, hash, mode, confirmedDirty),
  gitRevertCommit: (cwd, hash) => ipcRenderer.invoke(DESKTOP_IPC.gitRevertCommit, cwd, hash),
  gitCherryPickCommit: (cwd, hash) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitCherryPickCommit, cwd, hash),
  gitCreateTag: (cwd, tag, hash) => ipcRenderer.invoke(DESKTOP_IPC.gitCreateTag, cwd, tag, hash),
  gitDeleteTag: (cwd, tag) => ipcRenderer.invoke(DESKTOP_IPC.gitDeleteTag, cwd, tag),
  gitCheckoutCommit: (cwd, hash) => ipcRenderer.invoke(DESKTOP_IPC.gitCheckoutCommit, cwd, hash),
  gitCreateBranchAtCommit: (cwd, branch, hash) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitCreateBranchAtCommit, cwd, branch, hash),
  gitReview: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitReview, cwd),
  gitReviewDiff: (cwd, path, untracked) => ipcRenderer.invoke(DESKTOP_IPC.gitReviewDiff, cwd, path, untracked === true),
  revealFile: (cwd, path, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.revealFile, cwd, path, accessToken),
  openFilePath: (cwd, path, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.openFilePath, cwd, path, accessToken),
  getUpdaterState: () => ipcRenderer.invoke(DESKTOP_IPC.getUpdaterState),
  subscribeUpdaterState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: DesktopUpdaterState): void => {
      listener(state);
    };
    ipcRenderer.on(DESKTOP_IPC.updaterState, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.updaterState, receive);
  },
  checkForDesktopUpdate: () => ipcRenderer.invoke(DESKTOP_IPC.checkForDesktopUpdate),
  showDesktopUpdate: () => ipcRenderer.invoke(DESKTOP_IPC.showDesktopUpdate),
  submit: (prompt, options) => ipcRenderer.invoke(DESKTOP_IPC.submit, prompt, options),
  submitNewTask: (prompt, options, draft) =>
    ipcRenderer.invoke(DESKTOP_IPC.submitNewTask, prompt, options, draft),
  abort: () => ipcRenderer.invoke(DESKTOP_IPC.abort),
  resolveToolApproval: (id, decision) =>
    ipcRenderer.invoke(DESKTOP_IPC.resolveToolApproval, id, decision),
  submitToSession: (sessionId, prompt, options) =>
    ipcRenderer.invoke(DESKTOP_IPC.submitToSession, sessionId, prompt, options),
  abortSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.abortSession, sessionId),
  resolveToolApprovalForSession: (sessionId, id, decision) =>
    ipcRenderer.invoke(DESKTOP_IPC.resolveToolApprovalForSession, sessionId, id, decision),
  subscribeSessionState: (listener) => {
    const decoders = new Map<string, ReturnType<typeof createSnapshotDeltaDecoder>>();
    const receive = (
      _event: Electron.IpcRendererEvent,
      update: DesktopSessionStateWireUpdate,
    ): void => {
      const sessionId = String(update?.sessionId || '');
      if (!sessionId) return;
      let decoder = decoders.get(sessionId);
      if (decoder) decoders.delete(sessionId);
      else decoder = createSnapshotDeltaDecoder();
      decoders.set(sessionId, decoder);
      const decoded = decoder.decode(update.wire);
      if (!decoded.ok) {
        decoder.reset();
        try { ipcRenderer.send(DESKTOP_IPC.sessionStateResync, sessionId); } catch {}
        return;
      }
      if (update.wire === null) decoders.delete(sessionId);
      listener({
        sessionId,
        snapshot: decoded.snapshot as EngineSnapshot,
        ...(update.frameSource ? { frameSource: update.frameSource } : {}),
        ...(typeof update.contentRevision === 'number'
          ? { contentRevision: update.contentRevision }
          : {}),
      } satisfies DesktopSessionStateUpdate);
    };
    ipcRenderer.on(DESKTOP_IPC.sessionState, receive);
    return () => {
      decoders.clear();
      ipcRenderer.removeListener(DESKTOP_IPC.sessionState, receive);
    };
  },
  listProviderModels: (options) => ipcRenderer.invoke(DESKTOP_IPC.listProviderModels, options),
  setModelRoute: (selection, sessionId) =>
    ipcRenderer.invoke(DESKTOP_IPC.setModelRoute, selection, sessionId),
  setFast: (enabled, sessionId) => ipcRenderer.invoke(DESKTOP_IPC.setFast, enabled, sessionId),
  readSettings: () => ipcRenderer.invoke(DESKTOP_IPC.readSettings),
  updateSetting: (key, enabled) => ipcRenderer.invoke(DESKTOP_IPC.updateSetting, key, enabled),
  getZoomFactor: () => ipcRenderer.invoke(DESKTOP_IPC.getZoomFactor),
  setZoomFactor: (factor) => ipcRenderer.invoke(DESKTOP_IPC.setZoomFactor, factor),
  applyTitleBarTheme: (theme, systemPreference) =>
    ipcRenderer.invoke(DESKTOP_IPC.applyTitleBarTheme, theme, systemPreference === true),
  setTitleBarDim: (dim) => ipcRenderer.invoke(DESKTOP_IPC.setTitleBarDim, dim),
  onZoomFactorChanged: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, factor: number): void => listener(factor);
    ipcRenderer.on(DESKTOP_IPC.zoomFactorChanged, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.zoomFactorChanged, receive);
  },
  invokeCapability: (request) => ipcRenderer.invoke(DESKTOP_IPC.invokeCapability, request),
  readCapabilities: (requests) => ipcRenderer.invoke(DESKTOP_IPC.readCapabilities, requests),
  // Byte lane for gallery media: a plain URL the DOM fetches itself (cached
  // by Chromium, range-able for video), never an IPC base64 payload.
  mediaUrl: (assetId, variant) =>
    `mixdog-media://asset/${encodeURIComponent(assetId)}?variant=${encodeURIComponent(variant || 'original')}`,
  dispose: () => ipcRenderer.invoke(DESKTOP_IPC.dispose),
  quit: () => ipcRenderer.invoke(DESKTOP_IPC.quit),
};

contextBridge.exposeInMainWorld('mixdogDesktop', Object.freeze(api));
