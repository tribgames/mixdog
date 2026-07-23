// Typed IPC bridge: explicit method allow-list, no arbitrary invoke.
import { contextBridge, ipcRenderer } from 'electron';

import {
  DESKTOP_IPC,
  type DesktopApi,
  type DesktopSessionSummary,
  type DesktopStateFieldsPatch,
  type DesktopStateItemsPatch,
  type DesktopStateStreamingTailPatch,
  type DesktopStateWire,
  type DesktopTranscriptItem,
  type EngineSnapshot,
  type DesktopUpdaterState,
} from '../shared/contract';

const api: DesktopApi = {
  chooseProject: () => ipcRenderer.invoke(DESKTOP_IPC.chooseProject),
  startProject: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.startProject, projectPath),
  startProjectTask: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.startProjectTask, projectPath),
  startTask: () => ipcRenderer.invoke(DESKTOP_IPC.startTask),
  listProjects: () => ipcRenderer.invoke(DESKTOP_IPC.listProjects),
  openProjectInExplorer: (projectPath) =>
    ipcRenderer.invoke(DESKTOP_IPC.openProjectInExplorer, projectPath),
  openExternal: (url) => ipcRenderer.invoke(DESKTOP_IPC.openExternal, url),
  renameProject: (projectPath, alias) =>
    ipcRenderer.invoke(DESKTOP_IPC.renameProject, projectPath, alias),
  setProjectPinned: (projectPath, pinned) =>
    ipcRenderer.invoke(DESKTOP_IPC.setProjectPinned, projectPath, pinned),
  removeProject: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.removeProject, projectPath),
  listSessions: () => ipcRenderer.invoke(DESKTOP_IPC.listSessions),
  subscribeSessions: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, sessions: DesktopSessionSummary[]): void => {
      listener(sessions);
    };
    ipcRenderer.on(DESKTOP_IPC.sessionsChanged, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.sessionsChanged, receive);
  },
  renameSession: (sessionId, title) => ipcRenderer.invoke(DESKTOP_IPC.renameSession, sessionId, title),
  setSessionArchived: (sessionId, archived) =>
    ipcRenderer.invoke(DESKTOP_IPC.setSessionArchived, sessionId, archived),
  deleteSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.deleteSession, sessionId),
  getRemoteAccessInfo: () => ipcRenderer.invoke(DESKTOP_IPC.remoteAccessInfo),
  prefetchSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.prefetchSession, sessionId),
  resumeSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.resumeSession, sessionId),
  searchProjectFiles: (projectIdOrWorkspaceId, query, limit) =>
    ipcRenderer.invoke(DESKTOP_IPC.searchProjectFiles, projectIdOrWorkspaceId, query, limit),
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
  rendererReady: () => {
    try { ipcRenderer.send(DESKTOP_IPC.rendererReady); } catch { /* show falls back to timeout */ }
  },
  termEnsure: (id, cwd) => ipcRenderer.invoke(DESKTOP_IPC.termEnsure, id, cwd ?? null),
  termWrite: (id, data) => {
    try { ipcRenderer.send(DESKTOP_IPC.termWrite, id, data); } catch { /* keystroke lost */ }
  },
  termResize: (id, cols, rows) => {
    try { ipcRenderer.send(DESKTOP_IPC.termResize, id, cols, rows); } catch { /* next resize wins */ }
  },
  subscribeTermData: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }): void => {
      listener(payload);
    };
    ipcRenderer.on(DESKTOP_IPC.termData, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.termData, receive);
  },
  gitStatus: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitStatus, cwd),
  gitDiff: (cwd, path, staged) => ipcRenderer.invoke(DESKTOP_IPC.gitDiff, cwd, path, staged === true),
  gitStage: (cwd, paths) => ipcRenderer.invoke(DESKTOP_IPC.gitStage, cwd, paths),
  gitUnstage: (cwd, paths) => ipcRenderer.invoke(DESKTOP_IPC.gitUnstage, cwd, paths),
  gitCommit: (cwd, message) => ipcRenderer.invoke(DESKTOP_IPC.gitCommit, cwd, message),
  gitPush: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitPush, cwd),
  gitRevert: (cwd, path, untracked) => ipcRenderer.invoke(DESKTOP_IPC.gitRevert, cwd, path, untracked === true),
  gitLog: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitLog, cwd),
  gitShow: (cwd, hash) => ipcRenderer.invoke(DESKTOP_IPC.gitShow, cwd, hash),
  gitReview: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitReview, cwd),
  gitReviewDiff: (cwd, path, untracked) => ipcRenderer.invoke(DESKTOP_IPC.gitReviewDiff, cwd, path, untracked === true),
  revealFile: (cwd, path) => ipcRenderer.invoke(DESKTOP_IPC.revealFile, cwd, path),
  openFilePath: (cwd, path) => ipcRenderer.invoke(DESKTOP_IPC.openFilePath, cwd, path),
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
  abort: () => ipcRenderer.invoke(DESKTOP_IPC.abort),
  resolveToolApproval: (id, decision) =>
    ipcRenderer.invoke(DESKTOP_IPC.resolveToolApproval, id, decision),
  listProviderModels: (options) => ipcRenderer.invoke(DESKTOP_IPC.listProviderModels, options),
  setModelRoute: (selection) => ipcRenderer.invoke(DESKTOP_IPC.setModelRoute, selection),
  setFast: (enabled) => ipcRenderer.invoke(DESKTOP_IPC.setFast, enabled),
  readSettings: () => ipcRenderer.invoke(DESKTOP_IPC.readSettings),
  updateSetting: (key, enabled) => ipcRenderer.invoke(DESKTOP_IPC.updateSetting, key, enabled),
  getZoomFactor: () => ipcRenderer.invoke(DESKTOP_IPC.getZoomFactor),
  setZoomFactor: (factor) => ipcRenderer.invoke(DESKTOP_IPC.setZoomFactor, factor),
  applyTitleBarTheme: (theme) => ipcRenderer.invoke(DESKTOP_IPC.applyTitleBarTheme, theme),
  onZoomFactorChanged: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, factor: number): void => listener(factor);
    ipcRenderer.on(DESKTOP_IPC.zoomFactorChanged, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.zoomFactorChanged, receive);
  },
  invokeCapability: (request) => ipcRenderer.invoke(DESKTOP_IPC.invokeCapability, request),
  readCapabilities: (requests) => ipcRenderer.invoke(DESKTOP_IPC.readCapabilities, requests),
  dispose: () => ipcRenderer.invoke(DESKTOP_IPC.dispose),
  quit: () => ipcRenderer.invoke(DESKTOP_IPC.quit),
};

contextBridge.exposeInMainWorld('mixdogDesktop', Object.freeze(api));
