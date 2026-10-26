// The visualize panel's user → agent feedback: the bridge to the HTML panes'
// page script (choices, page readiness, pin numbers), the Comment layer the
// panel lays over a commentable pane, the hint strip under the toolbar, and
// the composer cards (VisualizeFeedbackCards.tsx) that carry the feedback into the next message. What a
// pane offers (element click, dragged region, video time, crop source) comes
// from its entry in shared/visualize-comment-kinds.ts. Every pin and choice is
// tied to a real user gesture the page cannot produce
// (visualize-feedback-gate.ts). Crops come from a window capture on the
// desktop, or from the image / video frame itself; a client with neither (a
// paired remote client on an HTML or PDF pane) sends its pins without one.
import {
  type FormEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { VisualizePaneView, VisualizeTabView } from '../shared/visualize';
import {
  type VisualizeCommentCrop,
  visualizeCommentHints,
  visualizeCommentKind,
  visualizeCommentPage,
  visualizeElementName,
  visualizeElementNouns,
} from '../shared/visualize-comment-kinds';
import {
  intersectRect,
  postToPage,
  rectFromFractions,
  rectOfBox,
  rectToFractions,
  roundRect,
  sameRect,
  spanRect,
  type VisualizeFeedbackPageMessage,
  type VisualizeFeedbackParentMessage,
  type VisualizeFeedbackRect,
  type VisualizePageMeasure,
  type VisualizePagePick,
  visualizeFeedbackPageMessage,
} from '../shared/visualize-feedback';
import { tweakOps } from '../shared/visualize-tweaks';
import { showDesktopToast } from './desktop-toasts';
import { t } from './i18n';
import { loadImage } from './load-image';
import { takeVisualizeElementPin, useVisualizeElementPinPending } from './visualize-elements-store';
import { openVisualizePageLink } from './visualize-store';
import { useVisualizeCommentCardPlace, VisualizeCommentCard } from './visualize-comment-card';
import { type CommentDraft, commentDraftLabel, fullNotice, pinElement } from './visualize-comment-draft';
import { setActiveVisualizeKeyLayer, useVisualizeCommentKeys } from './visualize-comment-keys';
import {
  useVisualizePaneVideo,
  useVisualizePictureRelayout,
  VisualizeCommentMediaBar,
} from './visualize-comment-media';
import {
  fractionStyle,
  layerBox,
  liveRegion,
  mediaArea,
  type PaneMedia,
  paneFrame,
  paneMedia,
  paneVideo,
  regionUnder,
} from './visualize-comment-pane';
import { useVisualizePickAnswers, type VisualizePickReason } from './visualize-comment-picks';
import {
  beginVisualizeCapture,
  consumeVisualizeChoiceGesture,
  createVisualizePickGate,
  endVisualizeCapture,
  proposeVisualizeChoice,
  takeVisualizeChoiceProposal,
  useVisualizeChoiceProposal,
  VISUALIZE_PROPOSAL_TTL_MS,
  visualizeFreshCrop,
  visualizeProposalKey,
  visualizeRequestId,
  visualizeSameDescription,
  visualizeSameMeasure,
} from './visualize-feedback-gate';
import {
  addVisualizePin,
  peekVisualizePinOpen,
  removeVisualizePin,
  setVisualizeChoice,
  setVisualizePinImage,
  takeVisualizePinOpen,
  updateVisualizePinNote,
  useVisualizeFeedback,
  useVisualizePinOpenPending,
  visualizePaneChoices,
  visualizePaneFile,
  visualizePaneMarkers,
  visualizePinsFull,
  type VisualizePin,
  type VisualizePinImage,
  type VisualizeRegionTarget,
} from './visualize-feedback-store';
import {
  setVisualizeTweakDefs,
  useVisualizeTweaksRevision,
  visualizePaneTweaks,
  visualizeTweakValues,
  visualizeTweakVersion,
} from './visualize-tweaks-store';
import './visualize-feedback.css';

const MAX_CROP_EDGE = 1024;
/** A pointer that moves farther than this (CSS px) drags a region instead of clicking. */
const DRAG_PX = 5;
const READY_ANSWER_MS = 200;
const NOTICE_MS = 2_500;
/** After the page is asked to hide its marks, before the shot. */
const HIDE_SETTLE_MS = 60;
/** How long the page has to answer a describe or measure request. */
const DESCRIBE_TIMEOUT_MS = 500;
/** How long a video has to land on a pin's time before its frame is cropped. */
const SEEK_TIMEOUT_MS = 1_000;
/** A video pin's region shows while the video is this close (s) to its time. */
const PIN_TIME_WINDOW_S = 0.5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const nextFrames = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** PNG of `source`'s area (source px), at most MAX_CROP_EDGE on its long
 *  edge, with `masks` (source px) painted over. Throws when the canvas may
 *  not be read (a cross-origin picture). */
function encodeCrop(
  source: CanvasImageSource,
  area: VisualizeFeedbackRect,
  masks: VisualizeFeedbackRect[] = []
): VisualizePinImage | null {
  if (area.width < 1 || area.height < 1) return null;
  const scale = Math.min(1, MAX_CROP_EDGE / Math.max(area.width, area.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(area.width * scale));
  canvas.height = Math.max(1, Math.round(area.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(source, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  for (const mask of masks) {
    context.fillRect((mask.x - area.x) * scale, (mask.y - area.y) * scale, mask.width * scale, mask.height * scale);
  }
  const url = canvas.toDataURL('image/png');
  return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/png', width: canvas.width, height: canvas.height };
}

/** Desktop only: a screenshot of `area` (CSS px of this window) with the
 *  secret fields in `masks` (same space) painted over; null elsewhere. */
async function captureWindowArea(
  area: VisualizeFeedbackRect,
  masks: VisualizeFeedbackRect[] = []
): Promise<VisualizePinImage | null> {
  const capture = window.mixdogDesktop?.visualizeCaptureRect;
  const clipped = intersectRect(area, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
  if (!capture || !clipped) return null;
  const image = await loadImage(`data:image/png;base64,${await capture(clipped)}`, 'the crop could not be decoded');
  const ratio = image.naturalWidth / clipped.width;
  return encodeCrop(
    image,
    { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight },
    masks.map((mask) => ({
      x: (mask.x - clipped.x) * ratio,
      y: (mask.y - clipped.y) * ratio,
      width: mask.width * ratio,
      height: mask.height * ratio,
    }))
  );
}

/** One request to the page and its own answer, or null when none comes in time. */
function askPage<T>(
  frame: HTMLIFrameElement,
  ask: (id: string) => VisualizeFeedbackParentMessage,
  answer: (message: VisualizeFeedbackPageMessage, id: string) => T | null
): Promise<T | null> {
  const source = frame.contentWindow;
  if (!source) return Promise.resolve(null);
  const id = visualizeRequestId();
  return new Promise((resolve) => {
    const done = (value: T | null) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== source) return;
      const message = visualizeFeedbackPageMessage(event.data);
      const value = message ? answer(message, id) : null;
      if (value) done(value);
    };
    const timer = setTimeout(() => done(null), DESCRIBE_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    postToPage(frame, ask(id));
  });
}

/** The page's fresh description of a pinned element (box and secret-field
 *  masks now), or null when it does not answer in time. */
export function requestVisualizeDescription(
  frame: HTMLIFrameElement,
  selector: string
): Promise<VisualizePagePick | null> {
  return askPage(
    frame,
    (id) => ({ type: 'describe', id, selector }),
    (message, id) => (message.type === 'picked' && message.id === id ? message.pick : null)
  );
}

/** What lies in an area of the page (its viewport px) now: the elements
 *  wholly inside and the secret fields to mask, or null without an answer. */
export function requestVisualizeMeasure(
  frame: HTMLIFrameElement,
  rect: VisualizeFeedbackRect
): Promise<VisualizePageMeasure | null> {
  return askPage(
    frame,
    (id) => ({ type: 'measure', id, rect }),
    (message, id) =>
      message.type === 'measured' && message.id === id
        ? { count: message.count, masks: message.masks, masksOverflow: message.masksOverflow, anchor: message.anchor }
        : null
  );
}

type CaptureArea = (area: VisualizeFeedbackRect, masks: VisualizeFeedbackRect[]) => Promise<VisualizePinImage | null>;

/** A page crop of `area` (the frame's viewport px), redacted against the page
 *  as it is at the shot: `before` gives the fresh masks, `after` is asked
 *  once more after the shot, and any change there or in the frame's place
 *  (or no answer) discards the crop. */
async function capturePageArea<T extends { masks: VisualizeFeedbackRect[] }>(
  target: HTMLIFrameElement,
  area: VisualizeFeedbackRect,
  before: T,
  after: () => Promise<boolean>,
  capture: CaptureArea
): Promise<VisualizePinImage | null> {
  const origin = rectOfBox(target.getBoundingClientRect());
  const shift = (rect: VisualizeFeedbackRect) => ({ ...rect, x: origin.x + rect.x, y: origin.y + rect.y });
  const shot = intersectRect(shift(area), origin);
  if (!shot) return null;
  const image = await capture(shot, before.masks.map(shift));
  if (!image) return null;
  const same = await after();
  return same && sameRect(rectOfBox(target.getBoundingClientRect()), origin) ? image : null;
}

/** An element pin's crop: no crop without a fresh, complete answer for an
 *  element still where it was pinned, and the same answer after the shot. */
export async function captureVisualizeElementCrop(
  target: HTMLIFrameElement,
  pick: VisualizePagePick,
  capture: CaptureArea = captureWindowArea
): Promise<VisualizePinImage | null> {
  const before = await requestVisualizeDescription(target, pick.selector);
  const plan = visualizeFreshCrop(pick, before);
  if (!plan || !before) return null;
  return capturePageArea(
    target,
    plan.view,
    plan,
    async () => visualizeSameDescription(before, await requestVisualizeDescription(target, pick.selector)),
    capture
  );
}

/** A dragged HTML area's crop: the same rule, on what lies in the area. */
export async function captureVisualizeRegionCrop(
  target: HTMLIFrameElement,
  area: VisualizeFeedbackRect,
  capture: CaptureArea = captureWindowArea
): Promise<VisualizePinImage | null> {
  const before = await requestVisualizeMeasure(target, area);
  if (!before || before.masksOverflow) return null;
  return capturePageArea(
    target,
    area,
    before,
    async () => visualizeSameMeasure(before, await requestVisualizeMeasure(target, area)),
    capture
  );
}

/** Pause a video on `time` (s), waiting briefly for it to get there. */
async function settleVideo(video: HTMLVideoElement, time: number): Promise<void> {
  video.pause();
  if (Math.abs(video.currentTime - time) < 0.05) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      resolve();
    };
    const timer = setTimeout(done, SEEK_TIMEOUT_MS);
    video.addEventListener('seeked', done);
    video.currentTime = time;
  });
}

/** An image or video-frame crop: drawn from the picture itself; a canvas the
 *  picture taints (cross-origin media) falls back to a window capture. */
async function captureMediaArea(
  element: PaneMedia,
  natural: VisualizeFeedbackRect | null,
  windowArea: VisualizeFeedbackRect
): Promise<VisualizePinImage | null> {
  if (natural) {
    try {
      const image = encodeCrop(element, natural);
      if (image) return image;
    } catch {
      // A tainted canvas cannot be read: the window capture below shows the same pixels.
    }
  }
  return captureWindowArea(windowArea);
}

/** Queue a new comment's pin, with how its crop is taken: an element is
 *  described afresh by its page, an HTML area measured again, an image or
 *  video-frame area drawn from the picture (a video settled on the pin's
 *  time first), anything else captured from the window. */
function addCommentPin(
  sessionId: string,
  base: Omit<VisualizePin, 'id' | 'target'>,
  draft: Extract<CommentDraft, { mode: 'new' }>,
  {
    cropKind,
    layer,
    frame,
    windowArea,
  }: {
    cropKind: VisualizeCommentCrop;
    layer: HTMLElement | null;
    frame: HTMLIFrameElement | null;
    windowArea: VisualizeFeedbackRect;
  }
): { added: VisualizePin | null; crop: () => Promise<VisualizePinImage | null> } {
  const { pick } = draft;
  if (pick) {
    const added = addVisualizePin(sessionId, {
      ...base,
      target: {
        type: 'element',
        selector: pick.selector,
        html: pick.html,
        styles: pick.styles,
        box: pick.box,
        path: pick.path.map((node) => visualizeElementName(node, t)),
      },
    });
    return { added, crop: async () => (frame ? captureVisualizeElementCrop(frame, pick) : null) };
  }
  const element = cropKind === 'image' || cropKind === 'video-frame' ? paneMedia(layer) : null;
  const natural = element ? mediaArea(element, windowArea) : null;
  const region: VisualizeRegionTarget = {
    type: 'region',
    view: roundRect(draft.rect),
    ...(natural ? { image: natural } : {}),
    ...(draft.time !== undefined ? { time: draft.time } : {}),
    ...(draft.elements !== undefined ? { elements: draft.elements } : {}),
    ...(draft.anchor ? { anchor: draft.anchor } : {}),
  };
  const added = addVisualizePin(sessionId, { ...base, target: region });
  const crop = async () => {
    if (cropKind === 'page') {
      if (!frame) return null;
      const origin = frame.getBoundingClientRect();
      return captureVisualizeRegionCrop(frame, {
        ...windowArea,
        x: windowArea.x - origin.left,
        y: windowArea.y - origin.top,
      });
    }
    if (!element) return captureWindowArea(windowArea);
    if (element instanceof HTMLVideoElement && draft.time !== undefined) await settleVideo(element, draft.time);
    return captureMediaArea(element, natural, windowArea);
  };
  return { added, crop };
}

/** Wires the active tab's HTML panes to the feedback store: injects the page
 *  script on the desktop, answers page readiness, takes `data-choice` picks
 *  made with a real user gesture, mirrors Comment mode and the pin numbers
 *  into every page, and ends Comment mode on Esc. Pins come only from the
 *  Comment layer. */
export function useVisualizeFeedbackBridge({
  sessionId,
  tab,
  body,
  comment,
  setComment,
}: {
  sessionId: string;
  tab: VisualizeTabView | null;
  body: HTMLElement | null;
  comment: boolean;
  setComment(on: boolean): void;
}): void {
  const value = useVisualizeFeedback(sessionId);
  const live = useRef({ sessionId, tab, comment, value, setComment });
  live.current = { sessionId, tab, comment, value, setComment };

  // A pin's composer card was clicked: its card is reopened in Comment mode.
  const pinOpenPending = useVisualizePinOpenPending(sessionId, tab?.id ?? '');
  useEffect(() => {
    if (pinOpenPending && !live.current.comment) live.current.setComment(true);
  }, [pinOpenPending]);

  const stateFor = (index: number, withChoices: boolean): VisualizeFeedbackParentMessage => {
    const current = live.current;
    const tabId = current.tab?.id ?? '';
    return {
      type: 'state',
      comment: current.comment,
      markers: visualizePaneMarkers(current.value, tabId, index).markers,
      ...(withChoices ? { choices: visualizePaneChoices(current.value, tabId, index) } : {}),
      nouns: visualizeElementNouns(t),
    };
  };
  const stateRef = useRef(stateFor);
  stateRef.current = stateFor;

  // The overrides the user set on a pane's declared tweaks (null: it has none).
  const tweaksFor = (index: number): VisualizeFeedbackParentMessage | null => {
    const { sessionId: session, tab: shown } = live.current;
    const pane = shown?.panes[index];
    if (!shown || !pane) return null;
    const tweaks = visualizePaneTweaks(session, shown.id, index);
    if (!tweaks.length) return null;
    return {
      type: 'tweaks',
      ops: tweakOps(tweaks, visualizeTweakValues(session, shown.id, index, visualizeTweakVersion(shown, pane))),
    };
  };
  const tweaksRef = useRef(tweaksFor);
  tweaksRef.current = tweaksFor;
  const tweaksRevision = useVisualizeTweaksRevision();

  // Page → panel.
  useEffect(() => {
    if (!body) return;
    const answered = new WeakMap<object, number>();
    const onMessage = (event: MessageEvent) => {
      const message = visualizeFeedbackPageMessage(event.data);
      if (!message || !event.source) return;
      const { sessionId: session, tab: shown } = live.current;
      if (!shown) return;
      let frame: HTMLIFrameElement | null = null;
      let index = -1;
      for (const cell of body.querySelectorAll<HTMLElement>('[data-visualize-pane]')) {
        const candidate = cell.querySelector('iframe');
        if (candidate?.contentWindow && candidate.contentWindow === event.source) {
          frame = candidate;
          index = Number(cell.dataset.visualizePane);
          break;
        }
      }
      const pane = shown.panes[index];
      if (!frame || !pane || !visualizeCommentPage(pane.kind)) return;
      const now = performance.now();
      if (message.type === 'ready') {
        if (now - (answered.get(event.source) ?? Number.NEGATIVE_INFINITY) < READY_ANSWER_MS) return;
        answered.set(event.source, now);
        postToPage(frame, stateRef.current(index, true));
      } else if (message.type === 'tweaks') {
        // A document announces its own controls once it is ready (never
        // throttled: a reload at the same URL announces again). Its saved
        // overrides are replayed from these definitions only: a new document
        // has nothing applied, so nothing from the previous one is cleared.
        // A malformed block is logged by the page itself, which the desktop
        // reports as a page problem.
        const defs = setVisualizeTweakDefs(session, shown.id, index, message.raw);
        const replay = tweaksRef.current(index);
        if (replay) postToPage(frame, replay);
        if (defs && 'error' in defs) postToPage(frame, { type: 'tweaks-problem', reason: defs.error });
      } else if (message.type === 'exit-comment') {
        if (live.current.comment) live.current.setComment(false);
      } else if (message.type === 'link') {
        if (!live.current.comment) openVisualizePageLink(session, message.url, message.external);
      } else if (message.type === 'choice') {
        // Comment mode covers the pane: no page click can be a choice then.
        if (live.current.comment) return;
        const choice = {
          tabId: shown.id,
          tabLabel: shown.label,
          pane: index,
          file: visualizePaneFile(pane),
          group: message.group,
          choice: message.choice,
          label: message.label,
        };
        // One real gesture in this very pane per choice (main saw it).
        const page = frame;
        const reset = () => postToPage(page, stateRef.current(index, true));
        void consumeVisualizeChoiceGesture({ sessionId: session, tabId: shown.id, pane: index }).then((spent) => {
          if (spent) {
            if (!setVisualizeChoice(session, choice, message.selected)) reset();
            return;
          }
          // No gesture main saw (remote client, touch tap, failed lookup):
          // the user confirms in the panel's own bar. An unpick without a
          // gesture leaves the queue as it is (the chip clears it).
          const proposed =
            message.selected &&
            !live.current.comment &&
            proposeVisualizeChoice(
              visualizeProposalKey(session, shown.id, index),
              { sessionId: session, choice, reset },
              performance.now()
            );
          if (!proposed) reset();
        });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [body]);

  // Desktop: main runs the page script in each loaded HTML pane (a remote
  // client inlines it into the pane's document instead).
  useEffect(() => {
    const attach = window.mixdogDesktop?.visualizeFeedbackAttach;
    if (!body || !attach) return;
    const onLoad = (event: Event) => {
      const frame = event.target;
      if (!(frame instanceof HTMLIFrameElement)) return;
      const cell = frame.closest<HTMLElement>('[data-visualize-pane]');
      const { sessionId: session, tab: shown } = live.current;
      const pane = cell && shown ? shown.panes[Number(cell.dataset.visualizePane)] : undefined;
      if (!shown || !pane || !visualizeCommentPage(pane.kind)) return;
      void attach(session, shown.id).catch(() => {});
    };
    body.addEventListener('load', onLoad, true);
    return () => body.removeEventListener('load', onLoad, true);
  }, [body]);

  // Panel → pages: Comment mode and the pin numbers. Keyed on what is sent
  // (the shown panes and their messages), not on the tab object or the whole
  // feedback / tweak state, so an unrelated change resends nothing.
  // tweaksRevision only re-renders this hook when a tweak changes; the tweak
  // messages themselves are part of the key.
  void tweaksRevision;
  const pageKey =
    body && tab
      ? JSON.stringify([
          tab.id,
          tab.revision,
          tab.panes.map((pane, index) =>
            visualizeCommentPage(pane.kind) ? [pane.kind, pane.url, stateFor(index, false), tweaksFor(index)] : null
          ),
        ])
      : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: pageKey is the re-send trigger; the messages are read through the live refs
  useEffect(() => {
    const shown = live.current.tab;
    if (!body || !shown) return;
    shown.panes.forEach((pane, index) => {
      if (!visualizeCommentPage(pane.kind)) return;
      const frame = body.querySelector<HTMLIFrameElement>(`[data-visualize-pane="${index}"] iframe`);
      if (!frame) return;
      postToPage(frame, stateRef.current(index, false));
      const tweaks = tweaksRef.current(index);
      if (tweaks) postToPage(frame, tweaks);
    });
  }, [body, pageKey]);

  // Esc leaves Comment mode (inside a page, the page script reports it).
  useEffect(() => {
    if (!comment) return;
    const section = body?.closest('.visualize-pane');
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as Node | null;
      if (target !== document.body && !(target && section?.contains(target))) return;
      live.current.setComment(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [body, comment]);
}

export const VISUALIZE_COMMENT_HINT_SEEN_KEY = 'mixdog:visualize-comment-hint-seen';

/** What Comment mode accepts for these pane kinds, and the way out, as one line. */
export function visualizeCommentHintText(kinds: readonly string[]): string {
  const actions = visualizeCommentHints(kinds).map((hint) =>
    [hint.keys?.join(''), t(hint.text)].filter(Boolean).join(' ')
  );
  return [...actions, `Esc ${t('End comments')}`].join(' · ');
}

/** The mode explains itself once (a toast, never a bar under the toolbar);
 *  after that the Comment button's pressed state is the only sign. */
export function announceVisualizeCommentMode(kinds: readonly string[]): void {
  try {
    if (window.localStorage.getItem(VISUALIZE_COMMENT_HINT_SEEN_KEY)) return;
    window.localStorage.setItem(VISUALIZE_COMMENT_HINT_SEEN_KEY, '1');
  } catch {
    // Storage unavailable: the hint shows each time.
  }
  showDesktopToast(visualizeCommentHintText(kinds), 'info', { scope: 'visualize-comment' });
}

export { visualizeCardPlace } from './visualize-comment-card';

/** A notice the layer shows for a moment (a full pin queue). */
function useTransientNotice(): readonly [string, (notice: string) => void] {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice];
}

/** The panel's own layer over a commentable pane in Comment mode. Panes
 *  that take elements (HTML): a trusted click asks the page (one-time id) to
 *  describe the element under it, the hover outline, Alt+↑/↓ and scrolling
 *  are forwarded. Panes that take regions: a drag marks one (on HTML, a drag
 *  past DRAG_PX is a region too). Video panes pause, show a timeline with
 *  their pins, and keep each pin's time. The note is typed into this layer's
 *  card, and only its submit makes (or changes) a pin. */
export function VisualizeCommentLayer({
  sessionId,
  tab,
  pane,
  index,
  comment,
}: {
  sessionId: string;
  tab: VisualizeTabView;
  pane: VisualizePaneView;
  index: number;
  comment: boolean;
}) {
  const spec = visualizeCommentKind(pane.kind);
  const picks = spec?.select.includes('element') ?? false;
  const drags = spec?.select.includes('region') ?? false;
  const timed = spec?.anchors.includes('rect+time') ?? false;
  const paged = spec?.page ?? false;
  const media = spec?.media ?? false;
  const value = useVisualizeFeedback(sessionId);
  const { regions, next } = visualizePaneMarkers(value, tab.id, index);
  const layer = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  /** The pointer moved past DRAG_PX: the click that follows is no pick. */
  const dragged = useRef(false);
  const pickReason = useRef<VisualizePickReason>('click');
  const card = useRef<HTMLFormElement>(null);
  const hoverFrame = useRef(0);
  const [pickGate] = useState(() => createVisualizePickGate());
  const [drag, setDrag] = useState<VisualizeFeedbackRect | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [note, setNote] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  /** The mounted layer (it renders only while it has something to show). */
  const [layerNode, setLayerNode] = useState<HTMLDivElement | null>(null);
  const attachLayer = useCallback((node: HTMLDivElement | null) => {
    layer.current = node;
    setLayerNode(node);
  }, []);
  const live = useRef({ value, draft, comment });
  live.current = { value, draft, comment };

  const cropsMedia = spec?.crop === 'image' || spec?.crop === 'video-frame';
  const placeRegion = (target: VisualizeRegionTarget): VisualizeFeedbackRect =>
    liveRegion(layer.current, cropsMedia, target) ?? target.view;
  const close = () => {
    setDraft(null);
    setNote('');
  };
  /** Ask the page to describe another element for the open draft. */
  const retarget = (selector: string) => {
    const target = paneFrame(layer.current);
    if (!target) return;
    pickReason.current = 'retarget';
    postToPage(target, { type: 'describe', id: pickGate.request(performance.now()), selector });
  };
  /** Alt+↑/↓: the draft's element widens or narrows, else the hover target does. */
  const step = (dir: 'up' | 'down') => {
    const target = paneFrame(layer.current);
    const open = live.current.draft;
    if (!target) return;
    if (open?.mode === 'new' && open.pick) {
      const node = dir === 'up' ? open.pick.path.at(-1) : open.pick.child;
      if (node) retarget(node.selector);
    } else if (!open) {
      postToPage(target, { type: 'hover-step', dir });
    }
  };
  /** A pin card asked for a pin the page draws (an element, an anchored
   *  region): ask its page to describe the element, for where it is now. The
   *  request stays pending until the answer comes (a page not ready yet is
   *  asked again on its `ready`), or it expires. */
  const describePinOpen = () => {
    const pin = peekVisualizePinOpen(sessionId, tab.id, index);
    const selector = pin ? pinElement(pin) : null;
    const target = paneFrame(layer.current);
    if (!selector || !target) return;
    setDraft(null);
    pickReason.current = 'open';
    postToPage(target, { type: 'describe', id: pickGate.request(performance.now()), selector });
  };
  const keys = useRef({ step, close, describePinOpen });
  keys.current = { step, close, describePinOpen };

  useEffect(() => {
    if (comment) return;
    start.current = null;
    pickGate.cancel();
    setDrag(null);
    setDraft(null);
    setHovered(null);
  }, [comment, pickGate]);
  const [notice, setNotice] = useTransientNotice();
  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), []);

  useVisualizePickAnswers({
    picks,
    pickGate,
    pickReason,
    sessionId,
    tabId: tab.id,
    index,
    layer,
    live,
    keys,
    setDraft,
    setNote,
    setNotice,
  });

  // A row of the Elements list asked for a pin on its element: ask the page to
  // describe it (the answer is accepted like a click's), once Comment mode is on.
  const elementPinPending = useVisualizeElementPinPending(tab.id, index);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pending flag and Comment mode are the triggers; the rest is read when they fire
  useEffect(() => {
    if (!picks || !comment || !elementPinPending) return;
    const request = takeVisualizeElementPin(tab.id, index);
    const target = paneFrame(layer.current);
    if (!request || !target) return;
    if (draft && note.trim()) return;
    setDraft(null);
    pickReason.current = 'click';
    postToPage(target, { type: 'describe', id: pickGate.request(performance.now()), selector: request.selector });
  }, [picks, comment, elementPinPending]);

  // A pin's composer card asked for that pin: reopen its comment card (a video
  // seeks to the pin's time; an element is described afresh, and the page's
  // answer reopens the pin like a click on it does).
  const pinOpenPending = useVisualizePinOpenPending(sessionId, tab.id, index);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pending flag and Comment mode are the triggers; the rest is read when they fire
  useEffect(() => {
    if (!comment || !pinOpenPending) return;
    const pending = peekVisualizePinOpen(sessionId, tab.id, index);
    if (!pending) return;
    pickGate.cancel();
    if (pinElement(pending)) {
      describePinOpen();
      return;
    }
    const pin = takeVisualizePinOpen(sessionId, tab.id, index);
    if (pin?.target.type !== 'region') return;
    const seekTo = pin.target.time === undefined ? null : paneVideo(layer.current);
    if (seekTo && pin.target.time !== undefined) {
      seekTo.pause();
      seekTo.currentTime = pin.target.time;
    }
    setDraft({ mode: 'edit', pinId: pin.id, rect: placeRegion(pin.target) });
    setNote(pin.note);
  }, [comment, pinOpenPending]);

  // The page outlines the element a comment is being written for.
  const editedPin = draft?.mode === 'edit' ? value.pins.find((pin) => pin.id === draft.pinId) : undefined;
  let selected: string | null = null;
  if (draft?.mode === 'new') selected = draft.pick?.selector ?? null;
  else if (editedPin?.target.type === 'element') selected = editedPin.target.selector;
  // An anchored region's box is the page's too: it outlines that one as selected.
  const selectedPin = editedPin?.target.type === 'region' && editedPin.target.anchor && paged ? editedPin.id : null;
  useEffect(() => {
    const target = paged ? paneFrame(layer.current) : null;
    if (target) postToPage(target, { type: 'select', selector: selected, pin: selectedPin });
  }, [paged, selected, selectedPin]);
  // A reopened pin that was sent or removed meanwhile closes its card.
  useEffect(() => {
    if (draft?.mode === 'edit' && !editedPin) close();
  });

  const { video, mediaState } = useVisualizePaneVideo(layer, comment, media);
  useVisualizePictureRelayout(layerNode, cropsMedia, video);
  useVisualizeCommentKeys(layer, { comment, picks, media }, live, keys);
  // A reopened pin on a picture stays beside it as the pane is laid out anew.
  useVisualizeCommentCardPlace(card, layer, draft?.rect ?? null, () =>
    draft?.mode === 'edit' && editedPin?.target.type === 'region'
      ? liveRegion(layer.current, cropsMedia, editedPin.target)
      : null
  );

  const confirmBar = paged ? (
    <VisualizeChoiceConfirm proposalKey={visualizeProposalKey(sessionId, tab.id, index)} />
  ) : null;
  // The page draws anchored regions itself (they follow its scroll and reflow).
  const drawnRegions = paged ? regions.filter(({ target }) => !target.anchor) : regions;
  if (!spec || (!comment && !capturing && (media || !drawnRegions.length))) return confirmBar;

  // Region pins on screen now (a video's only near its current time), and where.
  const shownRegions = drawnRegions
    .filter(
      ({ target }) =>
        !timed ||
        target.time === undefined ||
        !mediaState ||
        Math.abs(target.time - mediaState.time) < PIN_TIME_WINDOW_S
    )
    .map((region) => ({ ...region, rect: placeRegion(region.target) }));
  const regionAt = (clientX: number, clientY: number) => {
    const box = layerBox(layer.current);
    return box ? regionUnder(shownRegions, box, clientX, clientY) : undefined;
  };
  const hoverPage = (x: number, y: number) => {
    const target = paneFrame(layer.current);
    if (!target) return;
    const origin = target.getBoundingClientRect();
    postToPage(target, { type: 'hover', x: x < 0 ? -1 : x - origin.left, y: y < 0 ? -1 : y - origin.top });
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!comment || !event.nativeEvent.isTrusted || event.target !== event.currentTarget) return;
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (draft) {
      if (note.trim()) return;
      close();
    }
    const hit = regionAt(event.clientX, event.clientY);
    if (hit) {
      setDraft({ mode: 'edit', pinId: hit.pin.id, rect: hit.rect });
      setNote(hit.pin.note);
      return;
    }
    const target = picks ? paneFrame(layer.current) : null;
    if (!target) return;
    const origin = target.getBoundingClientRect();
    pickReason.current = 'click';
    postToPage(target, {
      type: 'pick',
      id: pickGate.request(performance.now()),
      x: event.clientX - origin.left,
      y: event.clientY - origin.top,
    });
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    setActiveVisualizeKeyLayer(event.currentTarget);
    if (!comment || !drags || event.button !== 0 || !event.nativeEvent.isTrusted) return;
    if (event.target !== event.currentTarget || (draft && note.trim())) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = { x: event.clientX, y: event.clientY };
    dragged.current = false;
    paneVideo(layer.current)?.pause();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    setActiveVisualizeKeyLayer(event.currentTarget);
    const from = start.current;
    const box = layerBox(layer.current);
    if (from) {
      const far = Math.max(Math.abs(event.clientX - from.x), Math.abs(event.clientY - from.y)) > DRAG_PX;
      if (!dragged.current && !far) return;
      if (!dragged.current && paged) hoverPage(-1, -1);
      dragged.current = true;
      if (box) setDrag(rectToFractions(spanRect(from, { x: event.clientX, y: event.clientY }), box));
      return;
    }
    if (!comment || draft) return;
    const hit = regionAt(event.clientX, event.clientY);
    setHovered(hit?.pin.id ?? null);
    if (!picks || hoverFrame.current) return;
    const { clientX, clientY } = event;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      if (hit) hoverPage(-1, -1);
      else hoverPage(clientX, clientY);
    });
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    start.current = null;
    setDrag(null);
    const box = layerBox(layer.current);
    if (!from || !dragged.current || !box || !event.nativeEvent.isTrusted) return;
    const area = spanRect(from, { x: event.clientX, y: event.clientY });
    if (area.width <= DRAG_PX || area.height <= DRAG_PX) return;
    if (visualizePinsFull(sessionId)) {
      setNotice(fullNotice());
      return;
    }
    const video = timed ? paneVideo(layer.current) : null;
    const opened: Extract<CommentDraft, { mode: 'new' }> = {
      mode: 'new',
      rect: rectToFractions(area, box),
      ...(video ? { time: Math.round(video.currentTime * 100) / 100 } : {}),
    };
    setDraft(opened);
    setNote('');
    // An HTML area counts the elements inside it, for its label, and names
    // the element it lies in, which its pin is drawn from.
    const target = paged ? paneFrame(layer.current) : null;
    if (!target) return;
    const origin = target.getBoundingClientRect();
    void requestVisualizeMeasure(target, { ...area, x: area.x - origin.left, y: area.y - origin.top }).then(
      (measured) => {
        if (!measured) return;
        const { anchor } = measured;
        const path = anchor?.path.map((node) => visualizeElementName(node, t)) ?? [];
        const pathPart = path.length ? { path } : {};
        const measuredDraft = {
          ...opened,
          elements: measured.count,
          ...(anchor ? { anchor: { selector: anchor.selector, rect: anchor.rect, ...pathPart } } : {}),
        };
        setDraft((current) => (current === opened ? measuredDraft : current));
      }
    );
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const target = paged && !draft ? paneFrame(layer.current) : null;
    if (!target) return;
    let scale = 1;
    if (event.deltaMode === 1) scale = 16;
    else if (event.deltaMode === 2) scale = 400;
    postToPage(target, { type: 'scroll', dx: event.deltaX * scale, dy: event.deltaY * scale });
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = note.trim();
    const current = draft;
    const box = layerBox(layer.current);
    if (!text || !current || !box) return;
    if (current.mode === 'edit') {
      updateVisualizePinNote(sessionId, current.pinId, text);
      close();
      return;
    }
    const base = {
      tabId: tab.id,
      tabLabel: tab.label,
      pane: index,
      paneKind: pane.kind,
      file: visualizePaneFile(pane),
      note: text,
      label: commentDraftLabel(current, editedPin, pane),
    };
    const frame = paneFrame(layer.current);
    const { added, crop } = addCommentPin(sessionId, base, current, {
      cropKind: spec.crop,
      layer: layer.current,
      frame,
      windowArea: rectFromFractions(current.rect, box),
    });
    close();
    if (!added) {
      setNotice(fullNotice());
      return;
    }
    // One capture at a time; a pin that cannot get a slot goes without a crop.
    if (!beginVisualizeCapture()) return;
    let image: VisualizePinImage | null = null;
    try {
      // Hide the marks for the shot: this layer's and the page's.
      if (paged && frame) postToPage(frame, { type: 'hide' });
      setCapturing(true);
      await nextFrames();
      if (paged) await sleep(HIDE_SETTLE_MS);
      image = await crop();
    } catch {
      image = null;
    } finally {
      setCapturing(false);
      if (paged && frame) postToPage(frame, { type: 'show' });
      endVisualizeCapture();
    }
    if (image) setVisualizePinImage(sessionId, added.id, image);
  };
  const remove = () => {
    if (draft?.mode === 'edit') removeVisualizePin(sessionId, draft.pinId);
    close();
  };

  const editing = draft?.mode === 'edit';
  const sizeOf = (rect: VisualizeFeedbackRect) => {
    const box = layerBox(layer.current);
    return box ? `${Math.round(rect.width * box.width)}×${Math.round(rect.height * box.height)}` : '';
  };
  let draftBox: ReactNode = null;
  if (draft?.mode === 'new') {
    draftBox = (
      <div
        className={`visualize-region-box ${draft.pick ? 'is-anchor' : 'is-selected'}`}
        style={fractionStyle(draft.rect)}
      >
        <span className="visualize-region-number">{next}</span>
      </div>
    );
  } else if (draft && editedPin?.target.type === 'element') {
    draftBox = <div className="visualize-region-box is-anchor" style={fractionStyle(draft.rect)} />;
  }
  return (
    <>
      {confirmBar}
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a pointer surface over the pane; keyboard users pin through the Elements list and move targets with Alt+↑/↓ */}
      <div
        ref={attachLayer}
        className={`visualize-region-layer${comment ? ' is-commenting' : ''}`}
        style={capturing ? { visibility: 'hidden' } : undefined}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHovered(null);
          if (picks && !draft) hoverPage(-1, -1);
        }}
        onPointerCancel={() => {
          start.current = null;
          setDrag(null);
        }}
        onWheel={onWheel}
      >
        {shownRegions.map(({ n, pin, rect }) => {
          const open = draft?.mode === 'edit' && draft.pinId === pin.id;
          const over = hovered === pin.id && !draft;
          let state = '';
          if (open) state = ' is-selected';
          else if (over) state = ' is-hover';
          return (
            <div key={pin.id} className={`visualize-region-box${state}`} style={fractionStyle(rect)}>
              <span className="visualize-region-number">{n}</span>
              {over ? (
                <span className="visualize-region-tag">
                  {pin.label}
                  <em>{sizeOf(rect)}</em>
                </span>
              ) : null}
            </div>
          );
        })}
        {drag && (
          <div className="visualize-region-box is-draft" style={fractionStyle(drag)}>
            <span className="visualize-region-tag">
              {t('Region')}
              <em>{sizeOf(drag)}</em>
            </span>
          </div>
        )}
        {notice && (
          <div className="visualize-region-notice" role="status">
            {notice}
          </div>
        )}
        {draft && (
          <>
            {draftBox}
            <VisualizeCommentCard
              cardRef={card}
              number={editing ? value.pins.findIndex((pin) => pin.id === draft.pinId) + 1 : next}
              label={commentDraftLabel(draft, editedPin, pane)}
              editing={editing}
              pick={draft.mode === 'new' ? draft.pick : undefined}
              note={note}
              setNote={setNote}
              submit={submit}
              remove={remove}
              close={close}
              retarget={retarget}
            />
          </>
        )}
        {video && mediaState ? (
          <VisualizeCommentMediaBar video={video} mediaState={mediaState} regions={regions} />
        ) : null}
      </div>
    </>
  );
}

/** A pane's confirm bar for a choice made without a gesture main could see.
 *  Only a trusted click or key press on its own button queues the choice;
 *  Cancel, a replacement or the timeout put the page's marks back. */
export function VisualizeChoiceConfirm({ proposalKey }: { proposalKey: string }) {
  const proposal = useVisualizeChoiceProposal(proposalKey);
  useEffect(() => {
    if (!proposal) return;
    const timer = setTimeout(() => {
      if (takeVisualizeChoiceProposal(proposalKey, proposal.id)) proposal.reset();
    }, VISUALIZE_PROPOSAL_TTL_MS);
    return () => clearTimeout(timer);
  }, [proposal, proposalKey]);
  if (!proposal) return null;
  const label = proposal.choice.label || proposal.choice.choice;
  const confirm = (event: MouseEvent<HTMLButtonElement>) => {
    // A button's Enter/Space arrives as a click too; script-made ones do not count.
    if (!event.nativeEvent.isTrusted) return;
    if (!takeVisualizeChoiceProposal(proposalKey, proposal.id)) return;
    if (!setVisualizeChoice(proposal.sessionId, proposal.choice, true)) proposal.reset();
  };
  const cancel = () => {
    if (takeVisualizeChoiceProposal(proposalKey, proposal.id)) proposal.reset();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a floating confirm bar, not a form fieldset
    <div className="visualize-choice-confirm" role="group" aria-label={t('Choose {{label}}?', { label })}>
      <span className="visualize-choice-confirm-text">{t('Choose {{label}}?', { label })}</span>
      <button type="button" className="is-primary" onClick={confirm}>
        {t('Choose')}
      </button>
      <button type="button" onClick={cancel}>
        {t('Cancel')}
      </button>
    </div>
  );
}
