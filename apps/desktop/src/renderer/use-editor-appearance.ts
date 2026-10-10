// Settings and theme the file editor follows: the per-file editor settings the
// desktop resolves, and the app's light/dark theme.
import { useEffect, useState, type RefObject } from 'react';
import type { DesktopEditorSettings } from '../shared/contract';
import { DEFAULT_DESKTOP_EDITOR_SETTINGS } from '../shared/editor-settings';

/** Resolves the editor settings for a file (defaults for remote/unavailable
 *  reads) and keeps the open model's indentation options in step with them. */
export function useEditorSettings({
  api,
  accessToken,
  projectPath,
  relPath,
  workspaceFile,
  editorRef,
}: {
  api: typeof window.mixdogDesktop;
  accessToken?: string;
  projectPath: string;
  relPath: string;
  workspaceFile?: string;
  editorRef: RefObject<import('monaco-editor').editor.IStandaloneCodeEditor | null>;
}): DesktopEditorSettings {
  const [editorSettings, setEditorSettings] = useState<DesktopEditorSettings>(DEFAULT_DESKTOP_EDITOR_SETTINGS);
  useEffect(() => {
    let live = true;
    const reader = api?.readEditorSettings;
    if (!reader || accessToken) {
      setEditorSettings(DEFAULT_DESKTOP_EDITOR_SETTINGS);
      return () => {
        live = false;
      };
    }
    void reader(projectPath, relPath, workspaceFile)
      .then((settings) => {
        if (live && settings) setEditorSettings(settings);
      })
      .catch(() => {
        if (live) setEditorSettings(DEFAULT_DESKTOP_EDITOR_SETTINGS);
      });
    return () => {
      live = false;
    };
  }, [accessToken, api, projectPath, relPath, workspaceFile]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (editorSettings.detectIndentation) {
      model.detectIndentation(editorSettings.insertSpaces, editorSettings.tabSize);
    } else {
      model.updateOptions({
        tabSize: editorSettings.tabSize,
        insertSpaces: editorSettings.insertSpaces,
      });
    }
  }, [editorRef, editorSettings.detectIndentation, editorSettings.insertSpaces, editorSettings.tabSize]);
  return editorSettings;
}

/** Follows the app theme (default dark; :root[data-mixdog-theme="light"]). */
export function useLightTheme(): boolean {
  const [lightTheme, setLightTheme] = useState(() => document.documentElement.dataset.mixdogTheme === 'light');
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setLightTheme(document.documentElement.dataset.mixdogTheme === 'light')
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mixdog-theme'] });
    return () => observer.disconnect();
  }, []);
  return lightTheme;
}
