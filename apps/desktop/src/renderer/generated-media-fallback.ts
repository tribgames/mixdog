import { useEffect, useRef, useState } from 'react';
import type { MediaAssetRead } from './studio-support';
import { callCapability, type StudioApi } from './studio-support';
import { base64Bytes } from './studio-pane-support';

export type ReadMediaAsset = (assetId: string, options: Record<string, unknown>) => Promise<MediaAssetRead | null>;

async function readStillAsset(
  read: ReadMediaAsset,
  assetId: string,
  kind: 'image' | 'video'
): Promise<{ base64: string; mime: string } | null> {
  const result = await read(
    assetId,
    kind === 'video' ? { variant: 'thumb' } : { variant: 'display', allowOriginal: true }
  );
  if (!result?.base64) return null;
  const mime = result.mime || 'image/png';
  return mime.startsWith('video/') ? null : { base64: result.base64, mime };
}

/** A still: the display rendition of an image, the thumbnail of a clip.
 *  '' when the host returned none or a clip instead of a still. */
export async function readMediaStill(read: ReadMediaAsset, assetId: string, kind: 'image' | 'video'): Promise<string> {
  const still = await readStillAsset(read, assetId, kind);
  return still ? `data:${still.mime};base64,${still.base64}` : '';
}

/** The same still as an object URL ('' when none; the caller revokes it). */
async function readMediaStillObjectUrl(
  read: ReadMediaAsset,
  assetId: string,
  kind: 'image' | 'video'
): Promise<string> {
  const still = await readStillAsset(read, assetId, kind);
  return still ? URL.createObjectURL(new Blob([base64Bytes(still.base64)], { type: still.mime })) : '';
}

/** The clip itself as an object URL (the caller revokes it). */
export async function readMediaClip(read: ReadMediaAsset, assetId: string): Promise<string> {
  const result = await read(assetId, { variant: 'original' });
  if (!result?.base64) throw new Error('Could not read this media file.');
  return URL.createObjectURL(new Blob([base64Bytes(result.base64)], { type: result.mime || 'video/mp4' }));
}

export interface GeneratedMediaFallback {
  /** Object URL of the still ('' until read, or when unavailable); revoked
   *  when the asset changes or the card unmounts. */
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
    let owned = '';
    readMediaStillObjectUrl(read, assetId, kind).then(
      (url) => {
        if (!url) return;
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        owned = url;
        setStill(url);
      },
      () => undefined
    );
    return () => {
      active = false;
      if (!owned) return;
      const revoked = owned;
      owned = '';
      setStill((current) => (current === revoked ? '' : current));
      URL.revokeObjectURL(revoked);
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
