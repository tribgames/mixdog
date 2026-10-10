import { useEffect, type RefObject } from 'react';
import type { EditorFileLoad } from './editor-file-loader';
import { startEditorDiskWatch } from './editor-disk-watch';
import { fileAccessError } from './editor-pane-session-errors';

/** While the tab is active, a newer mtime on disk reloads a clean buffer and
 *  flags a dirty one as changed on disk. Binary and oversized files are
 *  skipped; previews poll separately. */
export function useEditorDiskWatch({
  api,
  projectPath,
  relPath,
  accessToken,
  active,
  load,
  readModel,
  savedMtime,
  savedText,
  reload,
  setDiskChanged,
  setSaveError,
}: {
  api: typeof window.mixdogDesktop;
  projectPath: string;
  relPath: string;
  accessToken?: string;
  active: boolean;
  load: EditorFileLoad | null;
  readModel: () => import('monaco-editor').editor.ITextModel | null;
  savedMtime: RefObject<number>;
  savedText: RefObject<string>;
  reload: () => void;
  setDiskChanged: (changed: boolean) => void;
  setSaveError: (message: string) => void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is the window bridge, re-read each render and kept as a dependency so a re-installed bridge restarts the watch.
  useEffect(() => {
    if (!active || !load || load.binary || load.tooLarge) return undefined;
    return startEditorDiskWatch(window, () => {
      if (document.body.dataset.tabDragging) return;
      void api
        ?.statProjectFile?.(projectPath, relPath, accessToken)
        .then((info) => {
          if (!info || info.mtimeMs <= savedMtime.current) return;
          const model = readModel();
          const isDirty = model ? model.getValue() !== savedText.current : false;
          if (isDirty) setDiskChanged(true);
          else reload();
        })
        .catch((reason) => {
          if (!readModel()) return;
          setDiskChanged(true);
          setSaveError(fileAccessError(reason));
        });
    });
  }, [accessToken, active, api, readModel, load, projectPath, relPath, reload]);
}
