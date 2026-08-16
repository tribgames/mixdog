import type { MutableRefObject } from "react";
import { t } from "./i18n";
import type { WorkspaceTab } from "./navigation";
import { desktopFeatureEnabled, hasDesktopUtilityDockFeature } from "./desktop-feature-config";
import type { getEditorCommandCapabilities } from "./editor-language-store";
import type { UtilityDockTab } from "./UtilityDock";
import type { WorkbenchCommand, WorkbenchQuickAccessMode } from "./WorkbenchOverlays";

interface EditorSaveHandle {
  save(): Promise<boolean>;
}

interface EditorNavigationHistory {
  entries: unknown[];
  index: number;
}

export function buildAppWorkbenchCommands({
  quickAccessMode,
  editorNavigationHistory,
  navigateEditorHistory,
  setQuickAccessMode,
  chooseFileTab,
  activeFileKey,
  editorSaveHandles,
  dirtyFileKeys,
  focusedLeafTabs,
  openDockTab,
  bottomPanel,
  toggleBottomPanel,
  toggleTerminalPanel,
  editorCommandCapabilities,
  toggleSidebar,
  toggleDock,
  openTerminalTab,
  openFolderTab,
  startTask,
  openStudioTab,
  openSettings,
}: {
  quickAccessMode: WorkbenchQuickAccessMode | null;
  editorNavigationHistory: MutableRefObject<EditorNavigationHistory>;
  navigateEditorHistory(offset: -1 | 1): void;
  setQuickAccessMode(mode: WorkbenchQuickAccessMode | null): void;
  chooseFileTab(): Promise<void>;
  activeFileKey: string;
  editorSaveHandles: MutableRefObject<Map<string, EditorSaveHandle>>;
  dirtyFileKeys: ReadonlySet<string>;
  focusedLeafTabs: readonly WorkspaceTab[];
  openDockTab(tab: UtilityDockTab): void;
  bottomPanel: { setTab(tab: string): void };
  toggleBottomPanel(): void;
  toggleTerminalPanel(): void;
  editorCommandCapabilities: ReturnType<typeof getEditorCommandCapabilities>;
  toggleSidebar(): void;
  toggleDock(): void;
  openTerminalTab(): void;
  openFolderTab(): void;
  startTask(): void;
  openStudioTab(): void;
  openSettings(): void;
}): WorkbenchCommand[] {
  return quickAccessMode === "commands" ? [
    {
      id: "workbench.action.navigateBack",
      category: "Go",
      label: "Go Back",
      enabled: editorNavigationHistory.current.index > 0,
      run: () => navigateEditorHistory(-1),
    },
    {
      id: "workbench.action.navigateForward",
      category: "Go",
      label: "Go Forward",
      enabled: editorNavigationHistory.current.index >= 0
        && editorNavigationHistory.current.index < editorNavigationHistory.current.entries.length - 1,
      run: () => navigateEditorHistory(1),
    },
    {
      id: "workbench.action.quickOpen",
      category: "File",
      label: "Go to File…",
      shortcut: "Ctrl+P",
      run: () => setQuickAccessMode("files"),
    },
    {
      id: "workbench.action.files.openFile",
      category: "File",
      label: "Open File…",
      shortcut: "Ctrl+O",
      run: () => { void chooseFileTab(); },
    },
    {
      id: "workbench.action.files.save",
      category: "File",
      label: "Save",
      shortcut: "Ctrl+S",
      enabled: Boolean(activeFileKey && editorSaveHandles.current.has(activeFileKey)),
      run: async () => {
        const handle = editorSaveHandles.current.get(activeFileKey);
        if (handle) await handle.save();
      },
    },
    {
      id: "workbench.action.files.saveAll",
      category: "File",
      label: "Save All",
      enabled: dirtyFileKeys.size > 0,
      run: async () => {
        for (const key of dirtyFileKeys) {
          const handle = editorSaveHandles.current.get(key);
          if (handle && !await handle.save()) break;
        }
      },
    },
    {
      id: "workbench.action.closeActiveEditor",
      category: "File",
      label: "Close Editor",
      shortcut: "Ctrl+W",
      enabled: focusedLeafTabs.length > 0,
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:close-active-tab")); },
    },
    {
      id: "editor.action.toggleWordWrap",
      category: "View",
      label: "Toggle Word Wrap",
      shortcut: "Alt+Z",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.toggleWordWrap" })); },
    },
    {
      id: "workbench.action.showSearch",
      category: "View",
      label: t("Show Search"),
      run: () => openDockTab("search"),
    },
    {
      id: "workbench.action.findInFiles",
      category: "Search",
      label: "Find in Files…",
      shortcut: "Ctrl+Shift+F",
      run: () => {
        openDockTab("search");
        window.dispatchEvent(new CustomEvent("mixdog:focus-dock-search"));
      },
    },
    {
      id: "workbench.action.showSourceControl",
      category: "View",
      label: "Show Source Control",
      run: () => openDockTab("source-control"),
    },
    {
      id: "workbench.action.showProblems",
      category: "View",
      label: "Show Problems",
      run: () => bottomPanel.setTab("problems"),
    },
    {
      id: "workbench.action.togglePanel",
      category: "View",
      label: "Toggle Panel",
      shortcut: "Ctrl+J",
      run: toggleBottomPanel,
    },
    {
      id: "workbench.action.terminal.toggleTerminal",
      category: "Terminal",
      label: "Toggle Terminal",
      shortcut: "Ctrl+` / Ctrl+T",
      run: toggleTerminalPanel,
    },
    {
      id: "editor.action.revealDefinition",
      category: "Editor",
      label: "Go to Definition",
      shortcut: "F12",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.definition),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.revealDefinition" })); },
    },
    {
      id: "editor.action.peekDefinition",
      category: "Editor",
      label: "Peek Definition",
      shortcut: "Alt+F12",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.definition),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.peekDefinition" })); },
    },
    {
      id: "editor.action.revealDeclaration",
      category: "Editor",
      label: "Go to Declaration",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.declaration),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.revealDeclaration" })); },
    },
    {
      id: "editor.action.goToTypeDefinition",
      category: "Editor",
      label: "Go to Type Definition",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.typeDefinition),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.goToTypeDefinition" })); },
    },
    {
      id: "editor.action.goToImplementation",
      category: "Editor",
      label: "Go to Implementations",
      shortcut: "Ctrl+F12",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.implementation),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.goToImplementation" })); },
    },
    {
      id: "editor.action.goToReferences",
      category: "Editor",
      label: "Go to References",
      shortcut: "Shift+F12",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.references),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.goToReferences" })); },
    },
    {
      id: "editor.action.referenceSearch.trigger",
      category: "Editor",
      label: "Peek References",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.references),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.referenceSearch.trigger" })); },
    },
    {
      id: "editor.action.triggerSuggest",
      category: "Editor",
      label: "Trigger Suggest",
      shortcut: "Ctrl+Space",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.triggerSuggest" })); },
    },
    {
      id: "editor.action.triggerParameterHints",
      category: "Editor",
      label: "Trigger Parameter Hints",
      shortcut: "Ctrl+Shift+Space",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.signatureHelp),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.triggerParameterHints" })); },
    },
    {
      id: "editor.action.quickOutline",
      category: "Go",
      label: "Go to Symbol in Editor…",
      shortcut: "Ctrl+Shift+O",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.quickOutline" })); },
    },
    {
      id: "editor.action.rename",
      category: "Editor",
      label: "Rename Symbol",
      shortcut: "F2",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.rename),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "rename" })); },
    },
    {
      id: "editor.action.changeAll",
      category: "Editor",
      label: "Change All Occurrences",
      shortcut: "Ctrl+F2",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.changeAll" })); },
    },
    {
      id: "editor.action.quickFix",
      category: "Editor",
      label: "Quick Fix…",
      shortcut: "Ctrl+.",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.codeAction),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "quickFix" })); },
    },
    {
      id: "editor.action.refactor",
      category: "Editor",
      label: "Refactor…",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.codeAction),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "refactor" })); },
    },
    {
      id: "editor.action.sourceAction",
      category: "Editor",
      label: "Source Action…",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.codeAction),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.sourceAction" })); },
    },
    {
      id: "editor.action.formatDocument",
      category: "Editor",
      label: "Format Document",
      shortcut: "Shift+Alt+F",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.formatting),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "format" })); },
    },
    {
      id: "editor.action.formatDocument.multiple",
      category: "Editor",
      label: "Format Document With…",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.formatting),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.formatDocument.multiple" })); },
    },
    {
      id: "editor.action.formatSelection",
      category: "Editor",
      label: "Format Selection",
      shortcut: "Ctrl+K Ctrl+F",
      enabled: Boolean(activeFileKey
        && (editorCommandCapabilities.rangeFormatting || editorCommandCapabilities.formatting)),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.formatSelection" })); },
    },
    {
      id: "editor.action.commentLine",
      category: "Editor",
      label: "Toggle Line Comment",
      shortcut: "Ctrl+/",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.commentLine" })); },
    },
    {
      id: "editor.fold",
      category: "Editor",
      label: "Fold",
      shortcut: "Ctrl+Shift+[",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.fold" })); },
    },
    {
      id: "editor.unfold",
      category: "Editor",
      label: "Unfold",
      shortcut: "Ctrl+Shift+]",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.unfold" })); },
    },
    {
      id: "editor.showCallHierarchy",
      category: "Editor",
      label: "Peek Call Hierarchy",
      shortcut: "Shift+Alt+H",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.callHierarchy),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "callHierarchy" })); },
    },
    {
      id: "workbench.action.toggleSidebar",
      category: "View",
      label: "Toggle Primary Side Bar",
      shortcut: "Ctrl+B",
      run: toggleSidebar,
    },
    {
      id: "workbench.action.toggleUtilityPanel",
      category: "View",
      label: "Toggle Utility Panel",
      shortcut: "Ctrl+Alt+B",
      run: toggleDock,
    },
    {
      id: "workbench.action.terminal.new",
      category: "Terminal",
      label: "Create New Terminal",
      run: () => openTerminalTab(),
    },
    {
      id: "mixdog.action.openFolderPane",
      category: "View",
      label: "Open Folder…",
      run: () => openFolderTab(),
    },
    {
      id: "mixdog.action.newTask",
      category: "Task",
      label: "New Task",
      shortcut: "Ctrl+N",
      run: () => startTask(),
    },
    {
      id: "mixdog.action.newStudio",
      category: "Studio",
      label: "New Studio",
      run: () => openStudioTab(),
    },
    {
      id: "workbench.action.openSettings",
      category: "Preferences",
      label: "Open Settings",
      shortcut: "Ctrl+,",
      run: () => openSettings(),
    },
  ].filter((command) => {
    if (command.id === "workbench.action.showSearch"
      || command.id === "workbench.action.findInFiles") {
      return desktopFeatureEnabled("explorer");
    }
    if (command.id === "workbench.action.showSourceControl") {
      return desktopFeatureEnabled("sourceControl");
    }
    if (command.id === "workbench.action.openSettings") {
      return desktopFeatureEnabled("settings");
    }
    if (command.id === "workbench.action.toggleSidebar") {
      return desktopFeatureEnabled("sessions");
    }
    if (command.id === "workbench.action.toggleUtilityPanel") {
      return hasDesktopUtilityDockFeature;
    }
    return true;
  }) : [];
}
