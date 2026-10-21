import { useEffect, useRef, useState } from 'react';
import { callCapability, errorText, type MediaAsset, type MediaAssetRead, type StudioApi } from './studio-support';
import type { useStudioMediaUrls } from './studio-media-state';

type StudioMediaUrls = ReturnType<typeof useStudioMediaUrls>;

/** Selected asset preview. With a byte-lane URL the DOM loads it directly;
 *  this RPC payload is only the fallback for a host without that lane ('' when
 *  the DOM loads it or nothing is selected). */
export function useStudioSelectedPreview(
  api: StudioApi,
  assetUrl: StudioMediaUrls['assetUrl'],
  laneReady: StudioMediaUrls['laneReady'],
  selected: MediaAsset | null,
  setError: (error: string) => void
): string {
  const [previewUrl, setPreviewUrl] = useState('');
  const previewToken = useRef(0);
  useEffect(() => {
    // While the lane probe is in flight the RPC fallback would race it and
    // pull a payload the DOM is about to fetch itself.
    if (!selected || laneReady === null || assetUrl(selected.id, selected.kind === 'video' ? 'original' : 'display')) {
      setPreviewUrl('');
      return;
    }
    const token = ++previewToken.current;
    void (async () => {
      try {
        const result = (await callCapability(api, 'readMediaAsset', [
          selected.id,
          {
            variant: selected.kind === 'video' ? 'original' : 'display',
            allowOriginal: true,
          },
        ])) as MediaAssetRead | null;
        if (token !== previewToken.current) return;
        setPreviewUrl(result?.base64 ? `data:${result.mime || 'image/png'};base64,${result.base64}` : '');
      } catch (reason) {
        if (token === previewToken.current) setError(errorText(reason));
      }
    })();
  }, [api, assetUrl, laneReady, selected, setError]);
  return previewUrl;
}
