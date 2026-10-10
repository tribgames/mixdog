// Gutter and inline decorations the file editor owns: ANSI escape rendering and
// Git quick-diff stripes. Each hook returns its own teardown for the surface
// release.
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { t } from './i18n';
import { monaco, resolveThemeColor } from './monaco-setup';
import { createGitRefreshScheduler, FILE_DIFF_REFRESH_OPTIONS, watchGitRefreshEvidence } from './git-refresh-scheduler';
import { colorWithAlpha, QUICK_DIFF_COLOR_TOKENS } from './editor-monaco-bootstrap';
import { editorAnsiDecorationPlan, isAnsiOutputPath } from './editor-ansi';
import { parseEditorQuickDiffStripes } from './editor-pane-model';
import type { EditorFileLoad } from './editor-file-loader';

type EditorInstance = import('monaco-editor').editor.IStandaloneCodeEditor;
type EditorDecorations = { current: import('monaco-editor').editor.IEditorDecorationsCollection | null };
type EditorGitDiff = NonNullable<NonNullable<typeof window.mixdogDesktop>['gitDiff']>;

const QUICK_DIFF_TOOLTIPS: Record<keyof typeof QUICK_DIFF_COLOR_TOKENS, () => string> = {
  add: () => t('Added line'),
  mod: () => t('Changed line'),
  del: () => t('Removed line'),
};

/** ANSI output files render their escape sequences as inline decorations plus
 *  one generated stylesheet; every other file clears both. */
function applyEditorAnsiDecorations({
  editor,
  model,
  relPath,
  lightTheme,
  decorations,
  styleElement,
}: {
  editor: EditorInstance | null;
  model: import('monaco-editor').editor.ITextModel | null | undefined;
  relPath: string;
  lightTheme: boolean;
  decorations: EditorDecorations;
  styleElement: { current: HTMLStyleElement | null };
}): void {
  if (!editor || !model || !isAnsiOutputPath(relPath) || !model.getValue().includes('\x1b[')) {
    decorations.current?.clear();
    if (styleElement.current) styleElement.current.textContent = '';
    return;
  }
  const plan = editorAnsiDecorationPlan(model.getValue(), lightTheme);
  const next = plan.decorations.map((decoration) => {
    const start = model.getPositionAt(decoration.start);
    const end = model.getPositionAt(decoration.end);
    return {
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      options: {
        inlineClassName: decoration.className,
        inlineClassNameAffectsLetterSpacing: decoration.className === 'editor-ansi-control',
      },
    };
  });
  if (decorations.current) decorations.current.set(next);
  else decorations.current = editor.createDecorationsCollection(next);
  if (!styleElement.current) {
    const style = document.createElement('style');
    style.dataset.mixdogEditorAnsi = 'true';
    document.head.appendChild(style);
    styleElement.current = style;
  }
  styleElement.current.textContent = plan.cssText;
}

/** Gutter quick-diff against the Git worktree: file-watch evidence plus a slow
 *  safety pass, paused while the window is hidden. Returns its own teardown. */
function startEditorQuickDiff({
  gitDiff,
  projectPath,
  relPath,
  lightTheme,
  editorRef,
  decorations,
}: {
  gitDiff: EditorGitDiff;
  projectPath: string;
  relPath: string;
  lightTheme: boolean;
  editorRef: { current: EditorInstance | null };
  decorations: EditorDecorations;
}): () => void {
  let live = true;
  const refresh = async () => {
    try {
      const text = await gitDiff(projectPath, relPath, false);
      if (!live) return;
      const editor = editorRef.current;
      if (!editor) return;
      const stripes = parseEditorQuickDiffStripes(text);
      const decos = stripes.map((stripe) => {
        const [token, darkFallback, lightFallback] = QUICK_DIFF_COLOR_TOKENS[stripe.kind];
        const color = resolveThemeColor(token, lightTheme ? lightFallback : darkFallback);
        return {
          range: new monaco.Range(stripe.line, 1, stripe.line, 1),
          options: {
            isWholeLine: stripe.kind !== 'del',
            linesDecorationsClassName: `editor-dirty-diff editor-dirty-diff-${stripe.kind}`,
            linesDecorationsTooltip: QUICK_DIFF_TOOLTIPS[stripe.kind](),
            overviewRuler: {
              color: colorWithAlpha(color, '99'),
              position: monaco.editor.OverviewRulerLane.Left,
            },
            minimap: {
              color,
              position: monaco.editor.MinimapPosition.Gutter,
            },
          },
        };
      });
      decorations.current?.clear();
      decorations.current = editor.createDecorationsCollection(decos);
    } catch {
      decorations.current?.clear();
    }
  };
  const stopWatching = watchGitRefreshEvidence(
    projectPath,
    createGitRefreshScheduler(refresh, FILE_DIFF_REFRESH_OPTIONS)
  );
  return () => {
    live = false;
    stopWatching();
  };
}

/** Debounced ANSI rendering for the open model. `release` drops the pending
 *  render, the decorations and the generated stylesheet. */
export function useEditorAnsiOutput({
  editorRef,
  relPath,
  lightTheme,
}: {
  editorRef: RefObject<EditorInstance | null>;
  relPath: string;
  lightTheme: boolean;
}) {
  const decorations = useRef<import('monaco-editor').editor.IEditorDecorationsCollection | null>(null);
  const styleElement = useRef<HTMLStyleElement | null>(null);
  const renderTimer = useRef<number | null>(null);
  const renderAnsiOutput = useCallback(
    (model: import('monaco-editor').editor.ITextModel | null | undefined) => {
      applyEditorAnsiDecorations({
        editor: editorRef.current,
        model,
        relPath,
        lightTheme,
        decorations,
        styleElement,
      });
    },
    [editorRef, lightTheme, relPath]
  );
  const scheduleAnsiOutput = useCallback(
    (model: import('monaco-editor').editor.ITextModel | null | undefined) => {
      if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
      renderTimer.current = window.setTimeout(() => {
        renderTimer.current = null;
        renderAnsiOutput(model);
      }, 80);
    },
    [renderAnsiOutput]
  );
  useEffect(() => {
    renderAnsiOutput(editorRef.current?.getModel());
  }, [editorRef, renderAnsiOutput]);
  const releaseAnsiOutput = useCallback(() => {
    if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
    decorations.current?.clear();
    decorations.current = null;
    styleElement.current?.remove();
    styleElement.current = null;
  }, []);
  return { renderAnsiOutput, scheduleAnsiOutput, releaseAnsiOutput };
}

/** Quick-diff refresh while the pane is active on an editable text file. A save
 *  or revert bumps `diffTick` to re-arm the watch. */
export function useEditorQuickDiff({
  api,
  active,
  load,
  projectPath,
  relPath,
  diffTick,
  lightTheme,
  editorRef,
}: {
  api: typeof window.mixdogDesktop;
  active: boolean;
  load: EditorFileLoad | null;
  projectPath: string;
  relPath: string;
  diffTick: number;
  lightTheme: boolean;
  editorRef: RefObject<EditorInstance | null>;
}) {
  const decorations = useRef<import('monaco-editor').editor.IEditorDecorationsCollection | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: diffTick is a deliberate re-arm signal (save/revert), and api is the window bridge re-read each render.
  useEffect(() => {
    const gitDiff = api?.gitDiff;
    if (!active || !load || load.binary || load.tooLarge || load.readOnly || !gitDiff) return undefined;
    return startEditorQuickDiff({
      gitDiff,
      projectPath,
      relPath,
      lightTheme,
      editorRef,
      decorations,
    });
  }, [api, active, load, projectPath, relPath, diffTick, lightTheme, editorRef]);
  return useCallback(() => {
    decorations.current?.clear();
    decorations.current = null;
  }, []);
}
