// Bridge structure adapted from AiderDesk src/preload/index.ts under Apache-2.0.
import { contextBridge, ipcRenderer } from 'electron';

import {
  DESKTOP_IPC,
  type DesktopApi,
  type EngineSnapshot,
} from '../shared/contract';

const api: DesktopApi = {
  chooseProject: () => ipcRenderer.invoke(DESKTOP_IPC.chooseProject),
  startProject: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.startProject, projectPath),
  startProjectTask: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.startProjectTask, projectPath),
  startTask: () => ipcRenderer.invoke(DESKTOP_IPC.startTask),
  listProjects: () => ipcRenderer.invoke(DESKTOP_IPC.listProjects),
  openProjectInExplorer: (projectPath) =>
    ipcRenderer.invoke(DESKTOP_IPC.openProjectInExplorer, projectPath),
  renameProject: (projectPath, alias) =>
    ipcRenderer.invoke(DESKTOP_IPC.renameProject, projectPath, alias),
  setProjectPinned: (projectPath, pinned) =>
    ipcRenderer.invoke(DESKTOP_IPC.setProjectPinned, projectPath, pinned),
  removeProject: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.removeProject, projectPath),
  listSessions: () => ipcRenderer.invoke(DESKTOP_IPC.listSessions),
  resumeSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.resumeSession, sessionId),
  getSnapshot: () => ipcRenderer.invoke(DESKTOP_IPC.getSnapshot),
  subscribeState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: EngineSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on(DESKTOP_IPC.state, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.state, receive);
  },
  submit: (prompt, options) => ipcRenderer.invoke(DESKTOP_IPC.submit, prompt, options),
  abort: () => ipcRenderer.invoke(DESKTOP_IPC.abort),
  resolveToolApproval: (id, decision) =>
    ipcRenderer.invoke(DESKTOP_IPC.resolveToolApproval, id, decision),
  listProviderModels: (options) => ipcRenderer.invoke(DESKTOP_IPC.listProviderModels, options),
  setModelRoute: (selection) => ipcRenderer.invoke(DESKTOP_IPC.setModelRoute, selection),
  setFast: (enabled) => ipcRenderer.invoke(DESKTOP_IPC.setFast, enabled),
  readSettings: () => ipcRenderer.invoke(DESKTOP_IPC.readSettings),
  updateSetting: (key, enabled) => ipcRenderer.invoke(DESKTOP_IPC.updateSetting, key, enabled),
  invokeCapability: (request) => ipcRenderer.invoke(DESKTOP_IPC.invokeCapability, request),
  readCapabilities: (requests) => ipcRenderer.invoke(DESKTOP_IPC.readCapabilities, requests),
  dispose: () => ipcRenderer.invoke(DESKTOP_IPC.dispose),
  quit: () => ipcRenderer.invoke(DESKTOP_IPC.quit),
};

contextBridge.exposeInMainWorld('mixdogDesktop', Object.freeze(api));
