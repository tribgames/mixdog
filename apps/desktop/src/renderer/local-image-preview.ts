import { useEffect, useState } from 'react';
import { openEditorFileExternally } from './editor-external-file';
import { verifyLocalLink, type ResolvedLocalLink } from './local-link-resolver';

export interface LocalImagePreview {
  /** `mixdog-media://` preview URL; '' until resolved. */
  url: string;
  target: ResolvedLocalLink | null;
  /** The file cannot be previewed (or there is no desktop API to do so). */
  unavailable: boolean;
}

const PENDING: LocalImagePreview = { url: '', target: null, unavailable: false };

/** Resolves a local image path inside its Project and asks main for a preview
 *  URL; the result is only ever shown through `<img>`. */
export function useLocalImagePreview(project: string, path: string): LocalImagePreview {
  const [state, setState] = useState<{ key: string; value: LocalImagePreview }>({ key: '', value: PENDING });
  const key = `${project}\0${path}`;
  useEffect(() => {
    const previewFile = window.mixdogDesktop?.previewProjectFile;
    if (!previewFile) {
      setState({ key, value: { ...PENDING, unavailable: true } });
      return;
    }
    let active = true;
    verifyLocalLink(project, path)
      .then(async (target) => ({ target, preview: await previewFile(target.project, target.path, target.accessToken) }))
      .then(
        ({ target, preview }) => {
          if (active) setState({ key, value: { url: preview.url, target, unavailable: false } });
        },
        () => {
          if (active) setState({ key, value: { ...PENDING, unavailable: true } });
        }
      );
    return () => {
      active = false;
    };
  }, [project, path, key]);
  return state.key === key ? state.value : PENDING;
}

/** Launches a Project file in the OS default app, through the same call as
 *  the editor's own "open externally" button. */
export function openProjectFileInDefaultApp(target: ResolvedLocalLink): Promise<void> {
  return openEditorFileExternally(target.project, target.path, target.accessToken);
}
