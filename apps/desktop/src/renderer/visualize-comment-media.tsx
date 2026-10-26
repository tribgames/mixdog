// The pane's picture and video under the Comment layer: the video it follows
// (paused for comments, its time tracked), the relayout that keeps region
// pins on a picture, and the video's timeline with its pins.
import { Pause, Play } from 'lucide-react';
import { type ChangeEvent, type RefObject, useEffect, useState } from 'react';

import { formatVisualizeTime } from '../shared/visualize-comment-kinds';
import { t } from './i18n';
import { paneMedia, paneVideo } from './visualize-comment-pane';
import type { VisualizePin, VisualizeRegionTarget } from './visualize-feedback-store';

export interface MediaState {
  time: number;
  duration: number;
  paused: boolean;
}

/** Video panes in Comment mode: the pane's video element (one that mounts or
 *  is replaced later, a remote or late load, included), paused for comments,
 *  and its time. */
export function useVisualizePaneVideo(
  layer: RefObject<HTMLDivElement | null>,
  comment: boolean,
  media: boolean
): { video: HTMLVideoElement | null; mediaState: MediaState | null } {
  const [mediaState, setMediaState] = useState<MediaState | null>(null);
  /** The pane's video while Comment mode is on (it may mount later). */
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the layer ref is stable; the keys are those the layer had
  useEffect(() => {
    const cell = comment && media ? layer.current?.parentElement : null;
    if (!cell) {
      setVideo(null);
      return;
    }
    const find = () => setVideo(paneVideo(layer.current));
    find();
    const observer = new window.MutationObserver(find);
    observer.observe(cell, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [comment, media]);

  // That video pauses for comments, and its time is followed.
  useEffect(() => {
    if (!video) {
      setMediaState(null);
      return;
    }
    video.pause();
    const sync = () =>
      setMediaState({
        time: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        paused: video.paused,
      });
    sync();
    const events = ['timeupdate', 'seeked', 'play', 'pause', 'loadedmetadata', 'durationchange'];
    for (const name of events) video.addEventListener(name, sync);
    return () => {
      for (const name of events) video.removeEventListener(name, sync);
    };
  }, [video]);

  return { video, mediaState };
}

/** Pins on an image or video follow its picture: a pane resize (maximize,
 *  restore, zoom) or a picture that loads or changes size re-renders the
 *  layer, which places them again. */
export function useVisualizePictureRelayout(
  layerNode: HTMLDivElement | null,
  cropsMedia: boolean,
  video: HTMLVideoElement | null
): void {
  /** Bumped when the pane or its picture is laid out anew. */
  const [, setLayoutTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a video mounting later re-runs this; the element is read from the pane
  useEffect(() => {
    if (!layerNode || !cropsMedia) return;
    const relayout = () => setLayoutTick((tick) => tick + 1);
    const element = paneMedia(layerNode);
    const observer = new ResizeObserver(relayout);
    observer.observe(layerNode);
    if (element) observer.observe(element);
    const events = ['load', 'loadedmetadata', 'resize'];
    for (const name of events) element?.addEventListener(name, relayout);
    relayout();
    return () => {
      observer.disconnect();
      for (const name of events) element?.removeEventListener(name, relayout);
    };
  }, [layerNode, cropsMedia, video]);
}

/** The followed video's play button, time, seek track with its pins, and length. */
export function VisualizeCommentMediaBar({
  video,
  mediaState,
  regions,
}: {
  video: HTMLVideoElement;
  mediaState: MediaState;
  regions: ReadonlyArray<{ n: number; pin: VisualizePin; target: VisualizeRegionTarget }>;
}) {
  const seek = (time: number) => {
    video.pause();
    video.currentTime = Math.max(0, time);
  };
  const PlayPause = mediaState.paused ? Play : Pause;
  const pinMarkers = mediaState.duration
    ? regions.map(({ n, pin, target }) => {
        if (target.time === undefined) return null;
        return (
          <button
            key={pin.id}
            type="button"
            className="visualize-media-pin"
            style={{ left: `${Math.min(100, (target.time / mediaState.duration) * 100)}%` }}
            aria-label={t('Go to pin {{number}}', { number: String(n) })}
            onClick={() => seek(target.time ?? 0)}
          >
            {n}
          </button>
        );
      })
    : null;
  return (
    <div className="visualize-media-bar">
      <button
        type="button"
        aria-label={mediaState.paused ? t('Play') : t('Pause')}
        onClick={() => {
          if (video.paused) void video.play().catch(() => {});
          else video.pause();
        }}
      >
        <PlayPause size={14} aria-hidden="true" />
      </button>
      <span className="visualize-media-time">{formatVisualizeTime(mediaState.time)}</span>
      <span className="visualize-media-track">
        <input
          type="range"
          min={0}
          max={mediaState.duration || 0}
          step={0.01}
          value={Math.min(mediaState.time, mediaState.duration || 0)}
          aria-label={t('Seek')}
          onChange={(event: ChangeEvent<HTMLInputElement>) => seek(Number(event.currentTarget.value))}
        />
        {pinMarkers}
      </span>
      <span className="visualize-media-time">{formatVisualizeTime(mediaState.duration)}</span>
    </div>
  );
}
