// The visualize panel's user → agent feedback: the bridge to the HTML panes'
// page script (choices, page readiness, pin numbers), the Comment layer the
// panel lays over a pane (element picks on HTML, a dragged region on PDF and
// image panes, and the note box), and the composer chips that carry both into
// the next message. Every pin and choice is tied to a real user gesture the
// page cannot produce (visualize-feedback-gate.ts). Crops come from a window
// capture on the desktop; a paired remote client crops image panes itself
// and sends the other pins without a crop.
import { SlidersHorizontal, X } from 'lucide-react';
import {
  type FormEvent,
  type MouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  type WheelEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { VisualizePaneView, VisualizeTabView } from '../shared/visualize';
import {
  VISUALIZE_FEEDBACK_TAG,
  type VisualizeFeedbackParentMessage,
  type VisualizeFeedbackRect,
  type VisualizePagePick,
  visualizeFeedbackPageMessage,
} from '../shared/visualize-feedback';
import { t } from './i18n';
import { takeVisualizeElementPin, useVisualizeElementPinPending } from './visualize-elements-store';
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
} from './visualize-feedback-gate';
import {
  addVisualizePin,
  clearVisualizeChoices,
  clearVisualizeTweaks,
  MAX_VISUALIZE_PINS,
  removeVisualizePin,
  setVisualizeChoice,
  setVisualizePinImage,
  useVisualizeFeedback,
  visualizeChoicesChip,
  visualizeTweaksLabel,
  visualizeFeedbackPending,
  visualizePaneChoices,
  visualizePaneFile,
  visualizePaneMarkers,
  visualizePinChip,
  visualizePinsFull,
  type VisualizePinImage,
  type VisualizeRegionPin,
} from './visualize-feedback-store';
import {
  setVisualizeTweakDefs,
  useVisualizeTweaksRevision,
  visualizePaneTweaks,
  visualizeTweakValues,
  visualizeTweakVersion,
} from './visualize-tweaks-store';
import { tweakOps } from '../shared/visualize-tweaks';
import './visualize-feedback.css';

const MAX_CROP_EDGE = 1024;
const MIN_REGION_PX = 6;
const READY_ANSWER_MS = 200;
const NOTICE_MS = 2_500;
/** After the page is asked to hide its marks, before the shot. */
const HIDE_SETTLE_MS = 60;
/** How long the page has to re-describe a pinned element before its crop. */
const DESCRIBE_TIMEOUT_MS = 500;

function intersect(a: VisualizeFeedbackRect, b: VisualizeFeedbackRect): VisualizeFeedbackRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right - x >= 1 && bottom - y >= 1 ? { x, y, width: right - x, height: bottom - y } : null;
}

const domRect = (rect: DOMRect): VisualizeFeedbackRect => ({
  x: rect.left,
  y: rect.top,
  width: rect.width,
  height: rect.height,
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const nextFrames = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('the crop could not be decoded'));
    image.src = src;
  });
}

/** PNG of `source`'s area (source px), at most MAX_CROP_EDGE on its long
 *  edge, with `masks` (source px) painted over. */
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
  const clipped = intersect(area, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
  if (!capture || !clipped) return null;
  const image = await loadImage(`data:image/png;base64,${await capture(clipped)}`);
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

function postToPage(frame: HTMLIFrameElement, message: VisualizeFeedbackParentMessage): void {
  frame.contentWindow?.postMessage({ ...message, [VISUALIZE_FEEDBACK_TAG]: 1 }, '*');
}

/** The page's fresh description of a pinned element (box and secret-field
 *  masks now), or null when it does not answer in time. */
export function requestVisualizeDescription(frame: HTMLIFrameElement, selector: string): Promise<VisualizePagePick | null> {
  const source = frame.contentWindow;
  if (!source) return Promise.resolve(null);
  const id = visualizeRequestId();
  return new Promise((resolve) => {
    const done = (pick: VisualizePagePick | null) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(pick);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== source) return;
      const message = visualizeFeedbackPageMessage(event.data);
      if (message?.type === 'picked' && message.id === id) done(message.pick);
    };
    const timer = setTimeout(() => done(null), DESCRIBE_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    postToPage(frame, { type: 'describe', id, selector });
  });
}

/** An element pin's crop, redacted against the page as it is at the shot:
 *  the masks are re-read right before it (no crop without a fresh, complete
 *  answer for an element still where it was pinned), and the page is asked
 *  once more after it; any change in the element, its boxes, the mask set or
 *  the frame's place, or no answer, discards the crop. */
export async function captureVisualizeElementCrop(
  target: HTMLIFrameElement,
  pick: VisualizePagePick,
  capture: (area: VisualizeFeedbackRect, masks: VisualizeFeedbackRect[]) => Promise<VisualizePinImage | null> = captureWindowArea
): Promise<VisualizePinImage | null> {
  const before = await requestVisualizeDescription(target, pick.selector);
  const plan = visualizeFreshCrop(pick, before);
  if (!plan || !before) return null;
  const origin = domRect(target.getBoundingClientRect());
  const shift = (rect: VisualizeFeedbackRect) => ({ ...rect, x: origin.x + rect.x, y: origin.y + rect.y });
  const area = intersect(shift(plan.view), origin);
  if (!area) return null;
  const image = await capture(area, plan.masks.map(shift));
  if (!image) return null;
  const after = await requestVisualizeDescription(target, pick.selector);
  const moved = domRect(target.getBoundingClientRect());
  const framePut = moved.x === origin.x && moved.y === origin.y && moved.width === origin.width && moved.height === origin.height;
  return framePut && visualizeSameDescription(before, after) ? image : null;
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

  const stateFor = (index: number, withChoices: boolean): VisualizeFeedbackParentMessage => {
    const current = live.current;
    const tabId = current.tab?.id ?? '';
    return {
      type: 'state',
      comment: current.comment,
      markers: visualizePaneMarkers(current.value, tabId, index).markers,
      ...(withChoices ? { choices: visualizePaneChoices(current.value, tabId, index) } : {}),
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
    return { type: 'tweaks', ops: tweakOps(tweaks, visualizeTweakValues(session, shown.id, index, visualizeTweakVersion(shown, pane))) };
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
      if (!frame || pane?.kind !== 'html') return;
      const now = performance.now();
      if (message.type === 'ready') {
        if (now - (answered.get(event.source) ?? Number.NEGATIVE_INFINITY) < READY_ANSWER_MS) return;
        answered.set(event.source, now);
        postToPage(frame, stateRef.current(index, true));
      } else if (message.type === 'tweaks') {
        // The page's declared controls: a malformed block is logged by the page
        // itself, which the desktop reports as a page problem.
        const defs = setVisualizeTweakDefs(session, shown.id, index, message.raw);
        if (defs && 'error' in defs) postToPage(frame, { type: 'tweaks-problem', reason: defs.error });
      } else if (message.type === 'exit-comment') {
        if (live.current.comment) live.current.setComment(false);
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
      if (!cell || !shown || shown.panes[Number(cell.dataset.visualizePane)]?.kind !== 'html') return;
      void attach(session, shown.id).catch(() => {});
    };
    body.addEventListener('load', onLoad, true);
    return () => body.removeEventListener('load', onLoad, true);
  }, [body]);

  // Panel → pages: Comment mode and the pin numbers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value, comment and the tweaks revision are re-send triggers; they are read through the live refs
  useEffect(() => {
    if (!body || !tab) return;
    tab.panes.forEach((pane, index) => {
      if (pane.kind !== 'html') return;
      const frame = body.querySelector<HTMLIFrameElement>(`[data-visualize-pane="${index}"] iframe`);
      if (!frame) return;
      postToPage(frame, stateRef.current(index, false));
      const tweaks = tweaksRef.current(index);
      if (tweaks) postToPage(frame, tweaks);
    });
  }, [body, tab, value, comment, tweaksRevision]);

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

const fractionStyle = (rect: VisualizeFeedbackRect) => ({
  left: `${rect.x * 100}%`,
  top: `${rect.y * 100}%`,
  width: `${rect.width * 100}%`,
  height: `${rect.height * 100}%`,
});

const unit = (value: number): number => Math.min(1, Math.max(0, value));
const round = (value: number, digits = 4): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** A pin being written: the area (fractions of the layer), and for an HTML
 *  pane the element the page described for the user's click. */
interface CommentDraft {
  rect: VisualizeFeedbackRect;
  pick?: VisualizePagePick;
}

/** The panel's own layer over a pane in Comment mode. HTML panes: a trusted
 *  click asks the page (one-time id) to describe the element under it, the
 *  hover outline and scrolling are forwarded. PDF, document and image panes:
 *  drag a rectangle; pinned regions keep their numbers drawn here. Either way
 *  the note is typed into this layer's box, and only its submit makes a pin. */
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
  const value = useVisualizeFeedback(sessionId);
  const { regions, next } = visualizePaneMarkers(value, tab.id, index);
  const html = pane.kind === 'html';
  const layer = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const hoverFrame = useRef(0);
  const [pickGate] = useState(() => createVisualizePickGate());
  const [drag, setDrag] = useState<VisualizeFeedbackRect | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [note, setNote] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [notice, setNotice] = useState('');

  const frame = (): HTMLIFrameElement | null => layer.current?.parentElement?.querySelector('iframe') ?? null;
  const post = (message: VisualizeFeedbackParentMessage) => {
    const target = frame();
    if (target) postToPage(target, message);
  };

  useEffect(() => {
    if (comment) return;
    start.current = null;
    pickGate.cancel();
    setDrag(null);
    setDraft(null);
  }, [comment, pickGate]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), []);

  // The page's answer to this layer's own pick request, and nothing else.
  useEffect(() => {
    if (!html) return;
    const onMessage = (event: MessageEvent) => {
      const target = layer.current?.parentElement?.querySelector('iframe');
      if (!target?.contentWindow || event.source !== target.contentWindow) return;
      const message = visualizeFeedbackPageMessage(event.data);
      if (message?.type !== 'picked' || !pickGate.accept(message.id, performance.now())) return;
      const box = layer.current?.getBoundingClientRect();
      if (!box?.width || !box.height) return;
      const { view } = message.pick;
      const x = unit(view.x / box.width);
      const y = unit(view.y / box.height);
      setDraft({
        rect: {
          x,
          y,
          width: Math.max(0, unit((view.x + view.width) / box.width) - x),
          height: Math.max(0, unit((view.y + view.height) / box.height) - y),
        },
        pick: message.pick,
      });
      setNote('');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [html, pickGate]);

  // A row of the Elements list asked for a pin on its element: ask the page to
  // describe it (the answer is accepted like a click's), once Comment mode is on.
  const elementPinPending = useVisualizeElementPinPending(tab.id, index);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pending flag and Comment mode are the triggers; the rest is read when they fire
  useEffect(() => {
    if (!html || !comment || !elementPinPending) return;
    const request = takeVisualizeElementPin(tab.id, index);
    const target = frame();
    if (!request || !target) return;
    if (draft && note.trim()) return;
    if (visualizePinsFull(sessionId)) {
      setNotice(t('Up to {{count}} pins per message. Send or remove some first.', { count: MAX_VISUALIZE_PINS }));
      return;
    }
    setDraft(null);
    postToPage(target, { type: 'describe', id: pickGate.request(performance.now()), selector: request.selector });
  }, [html, comment, elementPinPending]);

  const confirmBar = html ? <VisualizeChoiceConfirm proposalKey={visualizeProposalKey(sessionId, tab.id, index)} /> : null;
  if (!comment && !capturing && (html || !regions.length)) return confirmBar;

  const showFull = () => setNotice(t('Up to {{count}} pins per message. Send or remove some first.', { count: MAX_VISUALIZE_PINS }));
  const fraction = (clientX: number, clientY: number) => {
    const box = layer.current?.getBoundingClientRect();
    if (!box?.width || !box.height) return { x: 0, y: 0 };
    return { x: unit((clientX - box.left) / box.width), y: unit((clientY - box.top) / box.height) };
  };
  const spanned = (a: { x: number; y: number }, b: { x: number; y: number }): VisualizeFeedbackRect => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  });
  const framePoint = (clientX: number, clientY: number) => {
    const origin = frame()?.getBoundingClientRect();
    return origin ? { x: clientX - origin.left, y: clientY - origin.top } : null;
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!html || !comment || !event.nativeEvent.isTrusted || event.target !== event.currentTarget) return;
    if (draft) {
      if (note.trim()) return;
      setDraft(null);
    }
    if (visualizePinsFull(sessionId)) {
      showFull();
      return;
    }
    const target = frame();
    const point = framePoint(event.clientX, event.clientY);
    if (!target || !point) return;
    postToPage(target, { type: 'pick', id: pickGate.request(performance.now()), ...point });
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (html || !comment || draft || event.button !== 0 || !event.nativeEvent.isTrusted) return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = fraction(event.clientX, event.clientY);
    setDrag({ ...start.current, width: 0, height: 0 });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current) {
      setDrag(spanned(start.current, fraction(event.clientX, event.clientY)));
      return;
    }
    if (!html || draft || hoverFrame.current) return;
    const { clientX, clientY } = event;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      const point = framePoint(clientX, clientY);
      if (point) post({ type: 'hover', ...point });
    });
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    start.current = null;
    setDrag(null);
    const box = layer.current?.getBoundingClientRect();
    if (!from || !box || !event.nativeEvent.isTrusted) return;
    const rect = spanned(from, fraction(event.clientX, event.clientY));
    if (rect.width * box.width < MIN_REGION_PX || rect.height * box.height < MIN_REGION_PX) return;
    if (visualizePinsFull(sessionId)) {
      showFull();
      return;
    }
    setDraft({ rect });
    setNote('');
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!html || draft) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    post({ type: 'scroll', dx: event.deltaX * scale, dy: event.deltaY * scale });
  };

  const cancel = () => {
    setDraft(null);
    setNote('');
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = note.trim();
    const current = draft;
    const box = layer.current?.getBoundingClientRect();
    if (!text || !current || !box) return;
    const base = {
      tabId: tab.id,
      tabLabel: tab.label,
      pane: index,
      paneKind: pane.kind,
      file: visualizePaneFile(pane),
      note: text,
    };
    let crop: () => Promise<VisualizePinImage | null>;
    let added: ReturnType<typeof addVisualizePin>;
    const { pick } = current;
    if (pick) {
      added = addVisualizePin(sessionId, {
        ...base,
        label: pick.label,
        element: { selector: pick.selector, html: pick.html, styles: pick.styles, box: pick.box },
      });
      crop = async () => {
        const target = frame();
        return target ? captureVisualizeElementCrop(target, pick) : null;
      };
    } else {
      const area = current.rect;
      const windowArea = {
        x: box.left + area.x * box.width,
        y: box.top + area.y * box.height,
        width: area.width * box.width,
        height: area.height * box.height,
      };
      const region: VisualizeRegionPin = {
        view: { x: round(area.x), y: round(area.y), width: round(area.width), height: round(area.height) },
      };
      // Image panes also name the area in the image's own pixels.
      const image = pane.kind === 'image' ? layer.current?.parentElement?.querySelector('img') : null;
      let natural: VisualizeFeedbackRect | null = null;
      if (image?.naturalWidth && image.naturalHeight) {
        const shown = image.getBoundingClientRect();
        const inside = intersect(windowArea, domRect(shown));
        if (inside && shown.width && shown.height) {
          const sx = image.naturalWidth / shown.width;
          const sy = image.naturalHeight / shown.height;
          natural = {
            x: Math.round((inside.x - shown.left) * sx),
            y: Math.round((inside.y - shown.top) * sy),
            width: Math.max(1, Math.round(inside.width * sx)),
            height: Math.max(1, Math.round(inside.height * sy)),
          };
          region.image = natural;
        }
      }
      added = addVisualizePin(sessionId, { ...base, label: `${pane.label} region`, region });
      crop = async () => {
        if (window.mixdogDesktop?.visualizeCaptureRect) return captureWindowArea(windowArea);
        return image && natural ? encodeCrop(image, natural) : null;
      };
    }
    setDraft(null);
    setNote('');
    if (!added) {
      showFull();
      return;
    }
    // One capture at a time; a pin that cannot get a slot goes without a crop.
    if (!beginVisualizeCapture()) return;
    let image: VisualizePinImage | null = null;
    try {
      // Hide the marks for the shot: this layer's and the page's.
      if (html) post({ type: 'hide' });
      setCapturing(true);
      await nextFrames();
      if (html) await sleep(HIDE_SETTLE_MS);
      image = await crop();
    } catch {
      image = null;
    } finally {
      setCapturing(false);
      if (html) post({ type: 'show' });
      endVisualizeCapture();
    }
    if (image) setVisualizePinImage(sessionId, added.id, image);
  };
  const onNoteKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };
  const below = draft ? draft.rect.y + draft.rect.height < 0.7 : true;
  const placeholder = html ? t('Comment on this element…') : t('Comment on this area…');
  return (
    <>
    {confirmBar}
    <div
      ref={layer}
      className={`visualize-region-layer${comment ? ' is-commenting' : ''}`}
      style={capturing ? { visibility: 'hidden' } : undefined}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        if (html && !draft) post({ type: 'hover', x: -1, y: -1 });
      }}
      onPointerCancel={() => {
        start.current = null;
        setDrag(null);
      }}
      onWheel={onWheel}
    >
      {regions.map(({ n, pin }) =>
        pin.region ? (
          <div key={pin.id} className="visualize-region-box" style={fractionStyle(pin.region.view)}>
            <span className="visualize-region-number">{n}</span>
          </div>
        ) : null
      )}
      {drag && <div className="visualize-region-box is-draft" style={fractionStyle(drag)} />}
      {notice && (
        <div className="visualize-region-notice" role="status">
          {notice}
        </div>
      )}
      {draft && (
        <>
          <div className="visualize-region-box is-draft" style={fractionStyle(draft.rect)}>
            <span className="visualize-region-number">{next}</span>
          </div>
          <form
            className="visualize-region-note"
            style={{
              left: `clamp(8px, ${draft.rect.x * 100}%, calc(100% - 248px))`,
              ...(below
                ? { top: `calc(${(draft.rect.y + draft.rect.height) * 100}% + 8px)` }
                : { bottom: `calc(${(1 - draft.rect.y) * 100}% + 8px)` }),
            }}
            onSubmit={(event) => void submit(event)}
          >
            {draft.pick && <div className="visualize-region-note-label">{draft.pick.label}</div>}
            <textarea
              // biome-ignore lint/a11y/noAutofocus: the note box opens from the user's own click or drag and takes the text at once
              autoFocus
              rows={3}
              value={note}
              placeholder={placeholder}
              aria-label={placeholder}
              onChange={(event) => setNote(event.currentTarget.value)}
              onKeyDown={onNoteKey}
            />
            <div className="visualize-region-note-row">
              <button type="button" onClick={cancel}>
                {t('Cancel')}
              </button>
              <button type="submit" className="is-primary" disabled={!note.trim()}>
                {t('Add')}
              </button>
            </div>
          </form>
        </>
      )}
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

/** The composer's chips for the session's queued pins and picks. */
export function VisualizeFeedbackChips({ sessionId }: { sessionId?: string }) {
  const value = useVisualizeFeedback(sessionId);
  if (!sessionId || !visualizeFeedbackPending(value)) return null;
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the chip row keeps its tag; the label names it
    <div className="visualize-feedback-chips" aria-label={t('Visualize feedback')}>
      {value.pins.map((pin, index) => (
        <span key={pin.id} className="visualize-feedback-chip" data-tooltip={pin.note}>
          <span className="visualize-feedback-chip-text">{visualizePinChip(pin, index + 1)}</span>
          <button
            type="button"
            aria-label={t('Remove pin {{number}}', { number: String(index + 1) })}
            onClick={() => removeVisualizePin(sessionId, pin.id)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      {value.choices.length > 0 && (
        <span className="visualize-feedback-chip" data-tooltip={visualizeChoicesChip(value.choices)}>
          <span className="visualize-feedback-chip-text">{visualizeChoicesChip(value.choices)}</span>
          <button type="button" aria-label={t('Clear choices')} onClick={() => clearVisualizeChoices(sessionId)}>
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      )}
      {value.tweaks.length > 0 && (
        <span className="visualize-feedback-chip" data-tooltip={visualizeTweaksLabel(value.tweaks)}>
          <SlidersHorizontal className="visualize-feedback-chip-icon" size={12} aria-hidden="true" />
          <span className="visualize-feedback-chip-text">{visualizeTweaksLabel(value.tweaks)}</span>
          <button type="button" aria-label={t('Clear tweaks')} onClick={() => clearVisualizeTweaks(sessionId)}>
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  );
}
