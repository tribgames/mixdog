import { useState } from 'react';
import { mediaFrameRatio, type MediaAsset } from './studio-support';
import { RATIO_CACHE_KEY, TILE_SIZE_KEY, TILE_SIZES } from './studio-pane-support';

/** Gallery density (top-right control), remembered across sessions. */
export function useStudioTileSize(): [number, (next: number) => void] {
  const [tileSize, setTileSize] = useState<number>(() => {
    const stored = Number(window.localStorage.getItem(TILE_SIZE_KEY));
    return TILE_SIZES.includes(stored as (typeof TILE_SIZES)[number]) ? stored : TILE_SIZES[1];
  });
  const updateTileSize = (next: number) => {
    setTileSize(next);
    try {
      window.localStorage.setItem(TILE_SIZE_KEY, String(next));
    } catch {
      // Density is a convenience.
    }
  };
  return [tileSize, updateTileSize];
}

/** Aspect ratios drive the justified rows; measured from the rendered thumb
 *  so no extra decode is needed. Ratios persist: without them the first paint
 *  lays every tile out square and then snaps once each thumbnail decodes
 *  (user: 처음 들어갈 때 튄다). */
export function useStudioThumbRatios(): [Record<string, number>, (asset: MediaAsset) => void] {
  const [ratios, setRatios] = useState<Record<string, number>>(() => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(RATIO_CACHE_KEY) || '{}');
      return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {};
    } catch {
      return {};
    }
  });
  const rememberRatio = (asset: MediaAsset) => {
    setRatios((current) => {
      if (current[asset.id]) return current;
      const next = { ...current, [asset.id]: mediaFrameRatio(asset) };
      try {
        window.localStorage.setItem(RATIO_CACHE_KEY, JSON.stringify(next));
      } catch {
        // Ratio cache is a convenience.
      }
      return next;
    });
  };
  return [ratios, rememberRatio];
}
