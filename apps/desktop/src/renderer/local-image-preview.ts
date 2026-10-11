import { useEffect, useState } from 'react';
import { openEditorFileExternally } from './editor-external-file';
import { verifyLocalLink, type ResolvedLocalLink } from './local-link-resolver';
import { isRemoteHostRenderer } from './remote-ui-projection';

export interface LocalImagePreview {
  /** `mixdog-media://` preview URL (a blob: URL over remote); '' until resolved. */
  url: string;
  target: ResolvedLocalLink | null;
  /** The file cannot be previewed (or there is no desktop API to do so). */
  unavailable: boolean;
}

const PENDING: LocalImagePreview = { url: '', target: null, unavailable: false };

/** Remote surfaces only: a blob: URL for an image at a HOST absolute path (an
 *  approval's rendered preview page). The path is described by the host's own
 *  grant-or-project resolution, then read through the same ranged preview call
 *  as every other remote file. '' on desktop, while loading, or on failure. */
export function useRemoteHostImageUrl(path: string): string {
  const [state, setState] = useState({ path: '', url: '' });
  useEffect(() => {
    const api = window.mixdogDesktop;
    if (!path || !isRemoteHostRenderer() || !api?.resolveLocalPaths || !api.previewProjectFile) return;
    let active = true;
    api
      .resolveLocalPaths([path])
      .then(([entry]) => {
        if (!entry?.projectPath || !entry.relPath) throw new Error('Preview unavailable.');
        return api.previewProjectFile!(entry.projectPath, entry.relPath, entry.accessToken);
      })
      .then(
        (preview) => {
          if (active) setState({ path, url: preview.url });
        },
        () => {}
      );
    return () => {
      active = false;
    };
  }, [path]);
  return state.path === path ? state.url : '';
}

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
