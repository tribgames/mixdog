import type { Dispatch, SetStateAction } from 'react';
import { t } from './i18n';
import { base64Bytes, type MediaBytes, mediaFile } from './studio-pane-support';
import { callCapability, errorText, type MediaAsset, type MediaAssetRead, type StudioApi } from './studio-support';

type AssetUrl = (id: string, variant: 'original') => string;

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

  // Web app Save: the device share sheet reaches Photos and Files on a phone.
  // Where it is missing or refuses — a slow read can outlive the tap's user
  // activation — a download link delivers the same file.
  const saveAsset = async (asset: MediaAsset) => {
    try {
      const file = mediaFile(asset, await readOriginalMedia(asset));
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return;
        } catch (reason) {
          if (reason instanceof DOMException && reason.name === 'AbortError') return;
        }
      }
      const href = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = href;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const openAsset = async (asset: MediaAsset) => {
    try {
      if (api?.openMediaAsset) await api.openMediaAsset(asset.id);
      else await callCapability(api, 'openMediaAsset', [asset.id]);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const openAssetFolder = async (asset: MediaAsset) => {
    try {
      if (api?.openMediaFolder) await api.openMediaFolder(asset.id);
      else await callCapability(api, 'openMediaFolder', [asset.id]);
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
