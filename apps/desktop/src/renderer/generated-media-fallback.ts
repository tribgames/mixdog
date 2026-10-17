// A generated-media card on a surface whose host has no media lane (an old
// host, or a page the service worker does not control yet) reads the asset
// over RPC like the Studio gallery does, so the card still shows a picture
// and can be opened.
import { useEffect, useRef, useState } from 'react';
import type { MediaAssetRead } from './studio-support';
import { callCapability, type StudioApi } from './studio-support';
import { base64Bytes } from './studio-pane-support';

export type ReadMediaAsset = (assetId: string, options: Record<string, unknown>) => Promise<MediaAssetRead | null>;

/** A still: the display rendition of an image, the thumbnail of a clip.
 *  '' when the host returned none or a clip instead of a still. */
export async function readMediaStill(read: ReadMediaAsset, assetId: string, kind: 'image' | 'video'): Promise<string> {
  const result = await read(
    assetId,
    kind === 'video' ? { variant: 'thumb' } : { variant: 'display', allowOriginal: true }
  );
  if (!result?.base64) return '';
  const mime = result.mime || 'image/png';
  return mime.startsWith('video/') ? '' : `data:${mime};base64,${result.base64}`;
}

/** The clip itself as an object URL (the caller revokes it). */
export async function readMediaClip(read: ReadMediaAsset, assetId: string): Promise<string> {
  const result = await read(assetId, { variant: 'original' });
  if (!result?.base64) throw new Error('Could not read this media file.');
  return URL.createObjectURL(new Blob([base64Bytes(result.base64)], { type: result.mime || 'video/mp4' }));
}

export interface GeneratedMediaFallback {
  /** Data URL of the still ('' until read, or when unavailable). */
  still: string;
  /** Video only: reads the clip into an object URL when the card opens. */
  loadClip?: () => Promise<string>;
}

/** The RPC-read still (and clip loader) of an asset, active only while
 *  `enabled` (no lane URL). */
export function useGeneratedMediaFallback(
  api: StudioApi | undefined,
  assetId: string,
  kind: 'image' | 'video',
  enabled: boolean
): GeneratedMediaFallback {
  const [still, setStill] = useState('');
  const clips = useRef<string[]>([]);
  const mounted = useRef(true);
  const read: ReadMediaAsset = (id, options) =>
    callCapability(api, 'readMediaAsset', [id, options]) as Promise<MediaAssetRead | null>;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the read closes over api, which only changes with the connection; the still is per asset.
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    readMediaStill(read, assetId, kind).then(
      (url) => {
        if (active) setStill(url);
      },
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [enabled, assetId, kind]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const url of clips.current) URL.revokeObjectURL(url);
      clips.current = [];
    };
  }, []);
  if (!enabled) return { still: '' };
  return {
    still,
    loadClip:
      kind === 'video'
        ? async () => {
            const url = await readMediaClip(read, assetId);
            if (!mounted.current) {
              URL.revokeObjectURL(url);
              throw new Error('The media card closed before the clip loaded.');
            }
            clips.current.push(url);
            return url;
          }
        : undefined,
  };
}
