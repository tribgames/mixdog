import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import * as monaco from 'monaco-editor';
import type { DesktopEditorSettings, DesktopLspCapabilities } from '../shared/contract';
import { bindEditorCommand } from './editor-command-binding';
import {
  ensureCallHierarchyMenu,
  focusedGraphEditor,
  FORMAT_DOCUMENT_WITH,
  HAS_CALL_HIERARCHY,
} from './editor-monaco-providers';

type Editor = monaco.editor.IStandaloneCodeEditor;
type Disposable = { dispose(): void };

export function useEditorCommandWiring({
  callHierarchyContextKey,
  lspReady,
  lspCapabilities,
  languageDisposables,
  activeRef,
  focusedRef,
  editorSettingsRef,
  saveRef,
  setWordWrapOverride,
  startCallHierarchy,
}: {
  callHierarchyContextKey: RefObject<monaco.editor.IContextKey<boolean> | null>;
  lspReady: RefObject<boolean>;
  lspCapabilities: RefObject<DesktopLspCapabilities | null>;
  languageDisposables: RefObject<Disposable[]>;
  activeRef: RefObject<boolean>;
  focusedRef: RefObject<boolean>;
  editorSettingsRef: RefObject<DesktopEditorSettings>;
  saveRef: RefObject<() => Promise<boolean>>;
  setWordWrapOverride: Dispatch<SetStateAction<DesktopEditorSettings['wordWrap'] | null>>;
  startCallHierarchy(): void;
}) {
  return useCallback(
    (editor: Editor) => {
      ensureCallHierarchyMenu();
      callHierarchyContextKey.current = editor.createContextKey(
        HAS_CALL_HIERARCHY,
        Boolean(lspReady.current && lspCapabilities.current?.callHierarchy)
      );
      languageDisposables.current.push(
        editor.onDidFocusEditorText(() => {
          focusedGraphEditor.current = editor;
        })
      );
      if (activeRef.current && focusedRef.current) focusedGraphEditor.current = editor;
      const addCommand = (keybinding: number, handler: () => void) => {
        languageDisposables.current.push(bindEditorCommand(editor, keybinding, handler));
      };
      addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void saveRef.current();
      });
      languageDisposables.current.push(
        editor.addAction({
          id: 'editor.action.toggleWordWrap',
          label: 'View: Toggle Word Wrap',
          keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
          run: () => {
            const wrapped = editor.getOption(monaco.editor.EditorOption.wordWrap) !== 'off';
            const configured = editorSettingsRef.current.wordWrap;
            const unwrapped = configured !== 'off' ? configured : 'on';
            setWordWrapOverride(wrapped ? 'off' : unwrapped);
          },
        })
      );
      const cycle = (offset: number) => window.dispatchEvent(new CustomEvent('mixdog:cycle-tab', { detail: offset }));
      addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.PageDown, () => cycle(1));
      addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.PageUp, () => cycle(-1));
      const switchTab = (offset: number) =>
        window.dispatchEvent(new CustomEvent('mixdog:tab-switcher', { detail: offset }));
      addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Tab, () => switchTab(1));
      addCommand(monaco.KeyMod.WinCtrl | monaco.KeyMod.Shift | monaco.KeyCode.Tab, () => switchTab(-1));
      addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () =>
        window.dispatchEvent(new CustomEvent('mixdog:close-active-tab'))
      );
      addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyQ, () =>
        window.dispatchEvent(new CustomEvent('mixdog:close-active-tab'))
      );
      const onEditorAction = (event: Event) => {
        if (!activeRef.current || !focusedRef.current) return;
        const detail = (event as CustomEvent).detail;
        const action = typeof detail === 'string' ? detail : String(detail?.action || '');
        if (typeof detail?.line === 'number') {
          editor.setPosition({
            lineNumber: Math.max(1, detail.line),
            column: Math.max(1, Number(detail.column) || 1),
          });
          editor.revealLineInCenter(Math.max(1, detail.line));
        }
        if (action === 'callHierarchy') {
          startCallHierarchy();
          return;
        }
        let actionId = '';
        if (action === 'rename') actionId = 'editor.action.rename';
        else if (action === 'quickFix') actionId = 'editor.action.quickFix';
        else if (action === 'refactor') actionId = 'editor.action.refactor';
        else if (action === 'format') actionId = 'editor.action.formatDocument';
        else if (action.startsWith('editor.')) actionId = action;
        if (actionId === FORMAT_DOCUMENT_WITH) {
          void editor.getAction('editor.action.formatDocument')?.run();
        } else if (actionId) {
          void editor.getAction(actionId)?.run();
        }
      };
      window.addEventListener('mixdog:editor-action', onEditorAction);
      languageDisposables.current.push({
        dispose: () => window.removeEventListener('mixdog:editor-action', onEditorAction),
      });
    },
    [
      activeRef,
      callHierarchyContextKey,
      editorSettingsRef,
      focusedRef,
      languageDisposables,
      lspCapabilities,
      lspReady,
      saveRef,
      setWordWrapOverride,
      startCallHierarchy,
    ]
  );
}
