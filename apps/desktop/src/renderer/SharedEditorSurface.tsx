import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { monaco } from './monaco-setup';
import { EditorSurfacePool } from './editor-surface-pool';

const surfaces = new EditorSurfacePool();
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
      if (!owners) modelOwners.set(modelRef.current, (owners = new Set()));
      owners.add(owner.current);
    }
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

  useEffect(
    () => () => {
      const model = modelRef.current;
      if (!model) return;
      const owners = modelOwners.get(model);
      owners?.delete(owner.current);
      if (!owners?.size) {
        modelOwners.delete(model);
        model.dispose();
      }
      modelRef.current = null;
    },
    [modelRef]
  );

  return <div ref={container} style={{ width: '100%', height: '100%' }} />;
}
