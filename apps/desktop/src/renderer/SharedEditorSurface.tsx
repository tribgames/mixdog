import { useLayoutEffect, useRef, type RefObject } from 'react';
import { monaco } from './monaco-setup';
import { ensureMonacoLanguage } from './monaco-language-loader';
import { stopMonacoLanguageWorkers, wakeMonacoLanguageWorkers } from './monaco-worker-lifecycle';
import { releaseUnattachedPeekPreviewModels } from './editor-graph-context';
import { EditorSurfacePool } from './editor-surface-pool';

const surfaces = new EditorSurfacePool({
  onActive: wakeMonacoLanguageWorkers,
  onEmpty: () => {
    // Release cached peek models before stopping language workers so no live
    // CSS/JSON peek model can trigger DiagnosticsAdapter validation and respawn.
    releaseUnattachedPeekPreviewModels();
    stopMonacoLanguageWorkers();
  },
});
const modelOwners = new WeakMap<monaco.editor.ITextModel, Set<object>>();

export default function SharedEditorSurface({
  surfaceKey,
  active,
  path,
  defaultValue,
  defaultLanguage,
  modelRef,
  theme,
  options,
  onMount,
  onRelease,
}: {
  surfaceKey: string;
  active: boolean;
  path: string;
  defaultValue: string;
  defaultLanguage?: string;
  modelRef: RefObject<monaco.editor.ITextModel | null>;
  theme: string;
  options: monaco.editor.IStandaloneEditorConstructionOptions;
  onMount(editor: monaco.editor.IStandaloneCodeEditor): void;
  onRelease(editor: monaco.editor.IStandaloneCodeEditor): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const owner = useRef({});
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef({ defaultValue, defaultLanguage, options, onMount, onRelease });
  latest.current = { defaultValue, defaultLanguage, options, onMount, onRelease };

  useLayoutEffect(() => {
    if (!active || !container.current) return;
    const host = container.current;
    if (!modelRef.current) {
      const uri = monaco.Uri.parse(path);
      modelRef.current =
        monaco.editor.getModel(uri) ??
        monaco.editor.createModel(latest.current.defaultValue, latest.current.defaultLanguage, uri);
      let owners = modelOwners.get(modelRef.current);
      if (!owners) {
        owners = new Set();
        modelOwners.set(modelRef.current, owners);
      }
      owners.add(owner.current);
    }
    void ensureMonacoLanguage(latest.current.defaultLanguage ?? modelRef.current?.getLanguageId()).catch(() => {});
    const surface = surfaces.acquire(
      surfaceKey,
      owner.current,
      () => {
        const element = document.createElement('div');
        element.style.width = '100%';
        element.style.height = '100%';
        host.appendChild(element);
        const editor = monaco.editor.create(element, { ...latest.current.options, model: null });
        return { element, editor };
      },
      () => {
        const editor = editorRef.current;
        if (!editor) return;
        latest.current.onRelease(editor);
        editor.setModel(null);
        editorRef.current = null;
      }
    );
    host.appendChild(surface.element);
    editorRef.current = surface.editor;
    surface.editor.updateOptions(latest.current.options);
    surface.editor.setModel(modelRef.current);
    latest.current.onMount(surface.editor);
    return () => surfaces.release(surfaceKey, owner.current);
  }, [active, modelRef, path, surfaceKey]);

  useLayoutEffect(() => {
    if (!active) return;
    monaco.editor.setTheme(theme);
    editorRef.current?.updateOptions(options);
  }, [active, options, theme]);

  // Dispose the owned model in layout cleanup so it is gone before the release
  // microtask stops language workers (passive useEffect runs too late).
  useLayoutEffect(
    () => () => {
      const model = modelRef.current;
      if (!model) return;
      const owners = modelOwners.get(model);
      owners?.delete(owner.current);
      if (!owners?.size) {
        modelOwners.delete(model);
        model.dispose();
        // A hidden tab closing while no editor surface is mounted may have been
        // holding the last CSS/SCSS/LESS model that deferred stopping its worker.
        if (surfaces.isEmpty) stopMonacoLanguageWorkers();
      }
      modelRef.current = null;
    },
    [modelRef]
  );

  return <div ref={container} style={{ width: '100%', height: '100%' }} />;
}
