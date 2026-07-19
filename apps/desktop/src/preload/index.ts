// Bridge structure adapted from AiderDesk src/preload/index.ts under Apache-2.0.
import { contextBridge, ipcRenderer } from 'electron';

import {
  DESKTOP_IPC,
  type DesktopApi,
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
  renameSession: (sessionId, title) => ipcRenderer.invoke(DESKTOP_IPC.renameSession, sessionId, title),
  deleteSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.deleteSession, sessionId),
  resumeSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.resumeSession, sessionId),
  searchProjectFiles: (projectIdOrWorkspaceId, query, limit) =>
    ipcRenderer.invoke(DESKTOP_IPC.searchProjectFiles, projectIdOrWorkspaceId, query, limit),
  getSnapshot: () => ipcRenderer.invoke(DESKTOP_IPC.getSnapshot),
  subscribeState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: EngineSnapshot): void => {
      listener(snapshot);
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
