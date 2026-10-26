// The PC picture's view on the phone's stage, as state with no DOM: the first
// view fills the stage's height and pans sideways (Chrome Remote Desktop's),
// the minimum zoom is the whole screen centred, and the soft keyboard is an
// inset, not a resize, so the picture never jumps as it comes and goes. The
// maths is remote-viewport.ts's.
import {
  clampView,
  initialView,
  rescaleView,
  sameAspect,
  trackStage,
  viewReady,
  type RemoteView,
  type RemoteViewLayout,
  type StageTrack,
  type ViewSize,
} from './remote-viewport';

export interface ScreenViewportState {
  track: StageTrack;
  picture: ViewSize;
  /** Null until the stage and the picture both have a size. */
  view: RemoteView | null;
}

export function screenViewportLayout(state: ScreenViewportState): RemoteViewLayout {
  return {
    picture: state.picture,
    stage: { width: state.track.width, height: state.track.height },
    insets: { bottom: state.track.bottom },
  };
}

/** The state after the stage was measured (`keyboardOpen` from the visual
 *  viewport) or the picture changed size. */
export function nextScreenViewport(
  prev: ScreenViewportState | null,
  measured: ViewSize,
  keyboardOpen: boolean,
  picture: ViewSize,
  /** Stage px the platform reports the keyboard covering (VirtualKeyboard API). */
  overlay = 0
): ScreenViewportState {
  const track = trackStage(prev?.track ?? null, measured, keyboardOpen, overlay);
  const layout = screenViewportLayout({ track, picture, view: null });
  if (!viewReady(layout)) return { track, picture, view: null };
  const view = prev?.view ?? null;
  if (!view) return { track, picture, view: initialView(layout) };
  // A picture of another size (a resized display): the same spot of the same
  // shape stays put; another shape starts again.
  if (picture.width !== prev?.picture.width || picture.height !== prev?.picture.height) {
    const next = prev && sameAspect(prev.picture, picture) ? rescaleView(view, prev.picture, picture) : null;
    return { track, picture, view: next ? clampView(next, layout) : initialView(layout) };
  }
  // The keyboard coming or going leaves the view as it is; a stage of another
  // size fits it again.
  const resized = track.width !== prev?.track.width || track.height !== prev?.track.height;
  return { track, picture, view: resized ? clampView(view, layout) : view };
}
