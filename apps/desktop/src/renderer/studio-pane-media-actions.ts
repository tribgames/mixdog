import type { Dispatch, SetStateAction } from 'react';
import { t } from './i18n';
import { isSshConnectionWindow } from './desktop-connection';
import { showDesktopToast } from './desktop-toasts';
import { fileDownloadFailureMessage, saveBlobOnDevice } from './file-download-transfer';
import { downloadAndOpenServerFile, revealFileFromWindow } from './server-transfers';
import { base64Bytes, type MediaBytes, mediaFile } from './studio-pane-support';
import { callCapability, errorText, type MediaAsset, type MediaAssetRead, type StudioApi } from './studio-support';

type AssetUrl = (id: string, variant: 'original') => string;
type MediaOpenApi = StudioApi | undefined;

/** A server window's asset lives on the server: its original's server path,
 *  resolved to a Project entry or a one-file grant like any server path. */
async function serverMediaEntry(api: MediaOpenApi, assetId: string) {
  const file = (await callCapability(api, 'resolveMediaFile', [assetId, { variant: 'original' }])) as {
    available?: unknown;
    path?: unknown;
  } | null;
  if (file?.available !== true || typeof file.path !== 'string' || !file.path) {
    throw new Error(t('Could not read this media file.'));
  }
  const [entry] = (await window.mixdogDesktop?.resolveLocalPaths?.([file.path])) ?? [];
  if (!entry?.projectPath || !entry.relPath) throw new Error(t('Could not read this media file.'));
  return { path: file.path, project: entry.projectPath, rel: entry.relPath, accessToken: entry.accessToken };
}

/** "Open": this PC's viewer in a local window; a server window downloads the
 *  asset to this PC first (asking before it does). */
export async function openMediaAssetFromWindow(api: MediaOpenApi, assetId: string): Promise<void> {
  if (isSshConnectionWindow()) {
    const { project, rel, accessToken } = await serverMediaEntry(api, assetId);
    await downloadAndOpenServerFile(project, rel, accessToken);
    return;
  }
  if (api?.openMediaAsset) await api.openMediaAsset(assetId);
  else await callCapability(api, 'openMediaAsset', [assetId]);
}

/** "Open folder": this PC's file manager in a local window. A server window
 *  reveals the asset in its own Files tree when a Project holds it, and
 *  otherwise copies its server path. */
export async function openMediaFolderFromWindow(api: MediaOpenApi, assetId: string): Promise<void> {
  if (isSshConnectionWindow()) {
    const { path, project, rel, accessToken } = await serverMediaEntry(api, assetId);
    if (!accessToken) {
      await revealFileFromWindow(project, rel);
      return;
    }
    await navigator.clipboard.writeText(path);
    showDesktopToast(t('Copied the server path: {{path}}', { path }), 'success');
    return;
  }
  if (api?.openMediaFolder) await api.openMediaFolder(assetId);
  else await callCapability(api, 'openMediaFolder', [assetId]);
}

// Per-asset actions of the detail viewer and the tile hover: reading original
// bytes, saving/sharing, opening in the OS, copying the prompt, hover preview.
export function createStudioMediaActions({
  api,
  assetUrl,
  fullUrls,
  localTransport,
  setCopied,
  setError,
  setFullUrls,
  setHoverId,
}: {
  api: StudioApi | undefined;
  assetUrl: AssetUrl;
  fullUrls: Record<string, string>;
  localTransport: boolean;
  setCopied: (copied: boolean) => void;
  setError: (message: string) => void;
  setFullUrls: Dispatch<SetStateAction<Record<string, string>>>;
  setHoverId: (id: string) => void;
}) {
  /** Original bytes: the web app's byte lane when it answers, else the RPC
   *  read (always on the desktop, where it rides local IPC). */
  const readOriginalMedia = async (asset: MediaAsset): Promise<MediaBytes> => {
    const url = localTransport ? '' : assetUrl(asset.id, 'original');
    if (url) {
      const response = await fetch(url);
      if (response.ok) {
        const mime = (response.headers.get('content-type') || '').split(';')[0]?.trim();
        return { bytes: await response.arrayBuffer(), mime: mime || asset.mime };
      }
    }
    const result = (await callCapability(api, 'readMediaAsset', [
      asset.id,
      { variant: 'original' },
    ])) as MediaAssetRead | null;
    if (!result?.base64) throw new Error(t('Could not read this media file.'));
    return { bytes: base64Bytes(result.base64), mime: result.mime || asset.mime };
  };

  // Web app Save: the phone app's native save, else the device share sheet
  // (Photos and Files on a phone) or a download link.
  const saveAsset = async (asset: MediaAsset) => {
    try {
      const file = mediaFile(asset, await readOriginalMedia(asset));
      await saveBlobOnDevice(file, file.name);
    } catch (reason) {
      setError(fileDownloadFailureMessage(reason));
    }
  };

  const openAsset = async (asset: MediaAsset) => {
    try {
      await openMediaAssetFromWindow(api, asset.id);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const openAssetFolder = async (asset: MediaAsset) => {
    try {
      await openMediaFolderFromWindow(api, asset.id);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  /** Play the hovered clip inline. With a byte lane the <video> streams it
   *  itself (ranges, no full download); without one the clip has to arrive as
   *  an RPC payload, which is only affordable on local transport. */
  const hoverPreview = async (asset: MediaAsset) => {
    setHoverId(asset.id);
    if (assetUrl(asset.id, 'original') || !localTransport || fullUrls[asset.id]) return;
    try {
      const result = (await callCapability(api, 'readMediaAsset', [asset.id])) as MediaAssetRead | null;
      if (!result?.base64) return;
      setFullUrls((current) => ({
        ...current,
        [asset.id]: `data:${result.mime || 'video/mp4'};base64,${result.base64}`,
      }));
    } catch {
      // Preview is a nicety; the still stays in place.
    }
  };

  const copyPrompt = async (asset: MediaAsset) => {
    try {
      await navigator.clipboard?.writeText(asset.prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard denial is silent; the prompt text stays selectable.
    }
  };

  return { copyPrompt, hoverPreview, openAsset, openAssetFolder, readOriginalMedia, saveAsset };
}
