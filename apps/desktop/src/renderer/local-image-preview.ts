import { useCallback, useEffect, useState } from 'react';
import { openEditorFileExternally } from './editor-external-file';
import { verifyLocalLink, type ResolvedLocalLink } from './local-link-resolver';
import { useBlobPreviewLease, useMediaSessionEpoch } from './remote-file-preview';
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
  const [blobRefresh, setBlobRefresh] = useState(0);
  const refreshRevokedBlob = useCallback(() => {
    setBlobRefresh((count) => count + 1);
  }, []);
  // A new media session invalidates streamed URLs: resolve again.
  const mediaSession = useMediaSessionEpoch();
  const currentUrl = state.path === path ? state.url : '';
  const blobLease = useBlobPreviewLease(currentUrl, refreshRevokedBlob);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mediaSession and blobRefresh only re-trigger the resolve.
  useEffect(() => {
    const api = window.mixdogDesktop;
    if (!path || !isRemoteHostRenderer() || !api?.resolveLocalPaths || !api.previewProjectFile) return;
    let active = true;
    void api
      .resolveLocalPaths([path])
      .then(([entry]) => {
        if (!active || !entry?.projectPath || !entry.relPath) throw new Error('Preview unavailable.');
        return api.previewProjectFile!(entry.projectPath, entry.relPath, entry.accessToken).then((preview) => {
          if (!active) return;
          blobLease.hold(preview.url);
          setState({ path, url: preview.url });
        });
      })
      .catch(() => {});
    return () => {
      active = false;
      blobLease.releasePending();
    };
  }, [path, mediaSession, blobRefresh, blobLease]);
  return currentUrl;
}

/** Resolves a local image path inside its Project and asks main for a preview
 *  URL; the result is only ever shown through `<img>`. `sessionId`: the
 *  conversation that links the image, which a paired device's host finds it by
 *  (as for the link itself). */
export function useLocalImagePreview(project: string, path: string, sessionId = ''): LocalImagePreview {
  const [state, setState] = useState<{ key: string; value: LocalImagePreview }>({ key: '', value: PENDING });
  const [blobRefresh, setBlobRefresh] = useState(0);
  const refreshRevokedBlob = useCallback(() => {
    setBlobRefresh((count) => count + 1);
  }, []);
  const key = `${project}\0${path}\0${sessionId}`;
  const mediaSession = useMediaSessionEpoch();
  const current = state.key === key ? state.value : PENDING;
  const blobLease = useBlobPreviewLease(current.url, refreshRevokedBlob);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mediaSession and blobRefresh only re-trigger the resolve.
  useEffect(() => {
    const previewFile = window.mixdogDesktop?.previewProjectFile;
    if (!previewFile) {
      setState({ key, value: { ...PENDING, unavailable: true } });
      return;
    }
    let active = true;
    void verifyLocalLink(project, path, sessionId || undefined)
      .then(async (target) => {
        if (!active) return;
        const preview = await previewFile(target.project, target.path, target.accessToken);
        if (!active) return;
        blobLease.hold(preview.url);
        setState({ key, value: { url: preview.url, target, unavailable: false } });
      })
      .catch(() => {
        if (active) setState({ key, value: { ...PENDING, unavailable: true } });
      });
    return () => {
      active = false;
      blobLease.releasePending();
    };
  }, [project, path, sessionId, key, mediaSession, blobRefresh, blobLease]);
  return current;
}

/** Launches a Project file in the OS default app, through the same call as
 *  the editor's own "open externally" button. */
export function openProjectFileInDefaultApp(target: ResolvedLocalLink): Promise<void> {
  return openEditorFileExternally(target.project, target.path, target.accessToken);
}
