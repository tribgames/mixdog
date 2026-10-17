// The user's visualize feedback waiting for the next message, per session:
// numbered pins (an element of an HTML pane, or a dragged region of any
// commentable pane, see shared/visualize-comment-kinds.ts) and `data-choice`
// picks. The composer shows them and sends them with the next user message;
// the panes draw the pins' numbers. A pin's number is its position in the
// session's list, so removing one renumbers the rest everywhere alike.
import { useSyncExternalStore } from 'react';

import { isRemoteContentSurface } from './remote-conversation-privacy';
import type { VisualizePaneKind, VisualizePaneView } from '../shared/visualize';
import {
  formatVisualizeTime,
  VISUALIZE_TAG_ROLES,
  visualizeCommentKind,
  visualizeCommentLabel,
} from '../shared/visualize-comment-kinds';
import type { VisualizePageMarker } from '../shared/visualize-feedback';
import { type VisualizeFeedbackRect, visualizeUnitRect } from '../shared/visualize-rect';
import type { VisualizeTweakChange } from '../shared/visualize-tweaks';

/** The file a pin names: project-relative on the desktop (`file`), and the
 *  host's path-free target on a remote client. */
export function visualizePaneFile(pane: VisualizePaneView): string {
  const file = pane.file ?? pane.target;
  return pane.version === undefined ? file : `${file} (kept version v${pane.version}, read-only)`;
}

export interface VisualizePinImage {
  /** Base64 PNG of the pinned area (secret fields painted over). */
  data: string;
  mimeType: 'image/png';
  width: number;
  height: number;
}

/** What a pin is about. An element of an HTML page: its selector and markup,
 *  `box` in page (document) CSS px, `path` its ancestors' human names
 *  (outermost first). A region: `view` in fractions (0-1) of the pane's
 *  visible view, `image` the same area in the image's (video frame's) own
 *  pixels, `time` the video time in seconds, `elements` how many HTML
 *  elements lie wholly inside it, `anchor` (HTML) the element it lies in:
 *  the page draws it from there. */
export type VisualizePinTarget =
  | {
      type: 'element';
      selector: string;
      html: string;
      styles: Record<string, string>;
      box: VisualizeFeedbackRect;
      path: string[];
    }
  | {
      type: 'region';
      view: VisualizeFeedbackRect;
      image?: VisualizeFeedbackRect;
      time?: number;
      elements?: number;
      anchor?: VisualizeRegionAnchor;
    };
export type VisualizeRegionTarget = Extract<VisualizePinTarget, { type: 'region' }>;

/** The smallest page element wholly holding an HTML region: its selector,
 *  the region as fractions (0-1) of its border box, and (when it is not
 *  body/html) its human path, outermost first. */
export interface VisualizeRegionAnchor {
  selector: string;
  rect: VisualizeFeedbackRect;
  path?: string[];
}

export interface VisualizePin {
  id: string;
  tabId: string;
  tabLabel: string;
  pane: number;
  paneKind: VisualizePaneKind;
  /** Project-relative file of the pane (never a host path on a remote client). */
  file: string;
  note: string;
  /** Human label from the pane kind's registry entry ("Button · Save"). */
  label: string;
  target: VisualizePinTarget;
  image?: VisualizePinImage;
}

// ── Stored pins: this shape, or the one before `target` (element / region) ──

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function storedRect(value: unknown): VisualizeFeedbackRect | null {
  const raw = record(value);
  if (!raw || ![raw.x, raw.y, raw.width, raw.height].every(finiteNumber)) return null;
  return { x: raw.x as number, y: raw.y as number, width: raw.width as number, height: raw.height as number };
}

function storedStyles(value: unknown): Record<string, string> {
  const raw = record(value) ?? {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function storedElement(raw: Record<string, unknown>, path: unknown): VisualizePinTarget | null {
  const box = storedRect(raw.box);
  if (typeof raw.selector !== 'string' || !raw.selector || !box) return null;
  return {
    type: 'element',
    selector: raw.selector,
    html: typeof raw.html === 'string' ? raw.html : '',
    styles: storedStyles(raw.styles),
    box,
    path: stringList(path),
  };
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** An anchor only an HTML pane's region keeps; a broken one is dropped (the
 *  pin stays, drawn from its view). */
function storedAnchor(value: unknown): VisualizeRegionAnchor | null {
  const raw = record(value);
  const rect = raw ? storedRect(raw.rect) : null;
  const area = rect ? visualizeUnitRect(rect) : null;
  if (!raw || typeof raw.selector !== 'string' || !raw.selector || !area) return null;
  const path = stringList(raw.path);
  return { selector: raw.selector, rect: area, ...(path.length ? { path } : {}) };
}

function storedRegion(raw: Record<string, unknown>, paged: boolean): VisualizePinTarget | null {
  const view = storedRect(raw.view);
  if (!view) return null;
  const image = storedRect(raw.image);
  const anchor = paged ? storedAnchor(raw.anchor) : null;
  return {
    type: 'region',
    view,
    ...(image ? { image } : {}),
    ...(finiteNumber(raw.time) && raw.time >= 0 ? { time: raw.time } : {}),
    ...(finiteNumber(raw.elements) && raw.elements >= 0 ? { elements: Math.round(raw.elements) } : {}),
    ...(anchor ? { anchor } : {}),
  };
}

function storedImage(value: unknown): VisualizePinImage | undefined {
  const raw = record(value);
  if (!raw || typeof raw.data !== 'string' || raw.mimeType !== 'image/png') return undefined;
  if (!finiteNumber(raw.width) || !finiteNumber(raw.height)) return undefined;
  return { data: raw.data, mimeType: 'image/png', width: raw.width, height: raw.height };
}

/** A stored pin in today's shape: one written before `target` existed
 *  (`element` / `region`, a `tag#id.class` label) is converted and relabelled;
 *  anything that cannot be a pin of a commentable pane is dropped (null). */
function storedCurrentTarget(current: Record<string, unknown>, page: boolean) {
  if (current.type === 'element') return storedElement(current, current.path);
  if (current.type === 'region') return storedRegion(current, page);
  return null;
}

function storedLegacyTarget(raw: Record<string, unknown>) {
  const legacyElement = record(raw.element);
  if (legacyElement) return storedElement(legacyElement, []);
  const legacyRegion = record(raw.region);
  return legacyRegion ? storedRegion(legacyRegion, false) : null;
}

export function visualizeStoredPin(value: unknown): VisualizePin | null {
  const raw = record(value);
  if (!raw) return null;
  const { id, tabId, tabLabel, pane, paneKind, file, note } = raw;
  if (typeof id !== 'string' || !/^p\d+$/.test(id) || typeof tabId !== 'string' || typeof tabLabel !== 'string')
    return null;
  if (!Number.isInteger(pane) || (pane as number) < 0 || typeof file !== 'string') return null;
  if (typeof note !== 'string' || !note.trim() || typeof paneKind !== 'string') return null;
  const kind = visualizeCommentKind(paneKind);
  if (!kind) return null;
  const current = record(raw.target);
  const target = current ? storedCurrentTarget(current, kind.page) : storedLegacyTarget(raw);
  if (!target || !kind.select.includes(target.type)) return null;
  let label = current && typeof raw.label === 'string' && raw.label ? raw.label : '';
  if (!label) {
    const pane = { kind: paneKind as VisualizePaneKind };
    if (target.type === 'element') {
      // The old label began with the tag: `button#go.primary`.
      const tag = (typeof raw.label === 'string' ? raw.label : '').split(/[#.\s]/)[0].toLowerCase();
      const role = Object.hasOwn(VISUALIZE_TAG_ROLES, tag) ? VISUALIZE_TAG_ROLES[tag] : 'box';
      label = visualizeCommentLabel({ type: 'element', role, name: '' }, pane);
    } else {
      label = visualizeCommentLabel({ type: 'region', time: target.time, elements: target.elements }, pane);
    }
  }
  const image = storedImage(raw.image);
  return {
    id,
    tabId,
    tabLabel,
    pane: pane as number,
    paneKind: paneKind as VisualizePaneKind,
    file,
    note,
    label,
    target,
    ...(image ? { image } : {}),
  };
}

export interface VisualizeChoice {
  tabId: string;
  tabLabel: string;
  pane: number;
  file: string;
  group: string;
  choice: string;
  label: string;
}

/** The tweak values the user moved off a page's defaults (one set per tab and
 *  pane), for the agent to bake into the file. */
export interface VisualizeTweakSet {
  tabId: string;
  tabLabel: string;
  pane: number;
  file: string;
  changes: VisualizeTweakChange[];
}

export interface VisualizeFeedback {
  pins: VisualizePin[];
  choices: VisualizeChoice[];
  tweaks: VisualizeTweakSet[];
}

const EMPTY: VisualizeFeedback = Object.freeze({ pins: [], choices: [], tweaks: [] }) as VisualizeFeedback;

// The queue outlives a renderer reload (crash recovery, a shell update, a
// dev reload): queued pins and picks are the user's unsent words, and a
// reload that dropped them lost feedback with no trace. Window-scoped, like
// the composer's other unsent state.
const STORAGE_KEY = 'mixdog:visualize-feedback:v1';

function storedFeedback(): Map<string, VisualizeFeedback> {
  if (isRemoteContentSurface()) return new Map();
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]') as unknown;
    if (!Array.isArray(raw)) return new Map();
    return new Map(
      raw
        .filter(
          (entry): entry is [string, VisualizeFeedback] =>
            Array.isArray(entry) &&
            typeof entry[0] === 'string' &&
            Array.isArray(entry[1]?.pins) &&
            Array.isArray(entry[1]?.choices)
        )
        // Pins are migrated or dropped one by one; a queue stored before
        // tweaks existed has none.
        .map(([id, value]): [string, VisualizeFeedback] => [
          id,
          {
            ...value,
            pins: (value.pins as unknown[]).map(visualizeStoredPin).filter((pin): pin is VisualizePin => pin !== null),
            tweaks: Array.isArray(value.tweaks) ? value.tweaks : [],
          },
        ])
        .filter(([, value]) => value.pins.length || value.choices.length || value.tweaks.length)
    );
  } catch {
    return new Map();
  }
}

/** Pin ids stay unique past the restored ones. */
const lastPinNumber = (map: Map<string, VisualizeFeedback>): number =>
  Math.max(0, ...[...map.values()].flatMap((value) => value.pins.map((pin) => Number(pin.id.slice(1)) || 0)));

function store(map: Map<string, VisualizeFeedback>): void {
  if (isRemoteContentSurface()) return;
  try {
    if (map.size) sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...map]));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Over the storage quota (large crops): keep the notes and picks, which
    // a reload must not lose, and let the crops go.
    try {
      const textOnly = [...map].map(([id, value]) => [
        id,
        { ...value, pins: value.pins.map(({ image: _image, ...pin }) => pin) },
      ]);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(textOnly));
    } catch {
      // Not even that fits: drop the stored copy rather than leave an older
      // one a reload would bring back (removed pins, sent feedback, crops).
      // The queue then lives for this document only.
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // No storage at all: nothing was stored to come back.
      }
    }
  }
}

let feedback = storedFeedback();
const listeners = new Set<() => void>();
let sequence = lastPinNumber(feedback);

function update(sessionId: string, next: VisualizeFeedback): void {
  const map = new Map(feedback);
  if (next.pins.length || next.choices.length || next.tweaks.length) map.set(sessionId, next);
  else map.delete(sessionId);
  feedback = map;
  store(map);
  for (const listener of listeners) listener();
}

export function visualizeFeedbackFor(sessionId: string | undefined): VisualizeFeedback {
  return (sessionId && feedback.get(sessionId)) || EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useVisualizeFeedback(sessionId: string | undefined): VisualizeFeedback {
  return useSyncExternalStore(
    subscribe,
    () => visualizeFeedbackFor(sessionId),
    () => EMPTY
  );
}

export function visualizeFeedbackPending(value: VisualizeFeedback): boolean {
  return value.pins.length > 0 || value.choices.length > 0 || value.tweaks.length > 0;
}

/** Most pins one session holds for its next message. */
export const MAX_VISUALIZE_PINS = 20;
/** Most choice groups (tab, pane, group) one session holds. */
export const MAX_VISUALIZE_CHOICE_GROUPS = 20;

export function visualizePinsFull(sessionId: string): boolean {
  return visualizeFeedbackFor(sessionId).pins.length >= MAX_VISUALIZE_PINS;
}

/** Queue a pin; returns it with its id, or null once the session is full. */
export function addVisualizePin(sessionId: string, pin: Omit<VisualizePin, 'id'>): VisualizePin | null {
  if (visualizePinsFull(sessionId)) return null;
  sequence += 1;
  const added: VisualizePin = { ...pin, id: `p${sequence}` };
  const current = visualizeFeedbackFor(sessionId);
  update(sessionId, { ...current, pins: [...current.pins, added] });
  return added;
}

/** The crop arrives after the pin; a pin already sent or removed ignores it. */
export function setVisualizePinImage(sessionId: string, id: string, image: VisualizePinImage): void {
  const current = visualizeFeedbackFor(sessionId);
  if (!current.pins.some((pin) => pin.id === id)) return;
  update(sessionId, { ...current, pins: current.pins.map((pin) => (pin.id === id ? { ...pin, image } : pin)) });
}

/** Rewrite a queued pin's note (its card reopened); an empty note keeps the old one. */
export function updateVisualizePinNote(sessionId: string, id: string, note: string): void {
  const text = note.trim();
  const current = visualizeFeedbackFor(sessionId);
  if (!text || !current.pins.some((pin) => pin.id === id)) return;
  update(sessionId, { ...current, pins: current.pins.map((pin) => (pin.id === id ? { ...pin, note: text } : pin)) });
}

export function removeVisualizePin(sessionId: string, id: string): void {
  const current = visualizeFeedbackFor(sessionId);
  update(sessionId, { ...current, pins: current.pins.filter((pin) => pin.id !== id) });
}

const choiceSlot = (choice: Pick<VisualizeChoice, 'tabId' | 'pane' | 'group'>): string =>
  `${choice.tabId}\0${choice.pane}\0${choice.group}`;

/** A pick replaces the earlier one of its group; an unpick drops it. A new
 *  group past MAX_VISUALIZE_CHOICE_GROUPS is refused (returns false). */
export function setVisualizeChoice(sessionId: string, choice: VisualizeChoice, selected: boolean): boolean {
  const current = visualizeFeedbackFor(sessionId);
  const slot = choiceSlot(choice);
  const others = current.choices.filter((entry) => choiceSlot(entry) !== slot);
  if (selected && others.length >= MAX_VISUALIZE_CHOICE_GROUPS) return false;
  update(sessionId, { ...current, choices: selected ? [...others, choice] : others });
  return true;
}

export function clearVisualizeChoices(sessionId: string): void {
  const current = visualizeFeedbackFor(sessionId);
  update(sessionId, { ...current, choices: [] });
}

/** Queue a pane's changed tweak values (replacing its earlier set); no
 *  changes drops the set. */
export function setVisualizeTweakSet(sessionId: string, set: VisualizeTweakSet): void {
  const current = visualizeFeedbackFor(sessionId);
  const others = current.tweaks.filter((entry) => entry.tabId !== set.tabId || entry.pane !== set.pane);
  update(sessionId, { ...current, tweaks: set.changes.length ? [...others, set] : others });
}

export function clearVisualizeTweaks(sessionId: string): void {
  const current = visualizeFeedbackFor(sessionId);
  update(sessionId, { ...current, tweaks: [] });
}

/** After a send: drop exactly what that message carried (anything queued
 *  while it travelled stays for the next one). A pin whose note was edited
 *  meanwhile stays too: the message carried its old note, not this one. */
export function consumeVisualizeFeedback(sessionId: string, sent: VisualizeFeedback): void {
  const notes = new Map(sent.pins.map((pin) => [pin.id, pin.note]));
  const choices = new Set(sent.choices);
  const tweaks = new Set(sent.tweaks);
  const current = visualizeFeedbackFor(sessionId);
  update(sessionId, {
    pins: current.pins.filter((pin) => notes.get(pin.id) !== pin.note),
    choices: current.choices.filter((choice) => !choices.has(choice)),
    tweaks: current.tweaks.filter((set) => !tweaks.has(set)),
  });
}

// A click on a pin's composer card asks the panel to open that pin's comment
// card. One pending slot: only the composer fills it (a user click), and only
// the Comment layer of the pin's pane takes it, once and while still fresh.
export const VISUALIZE_PIN_OPEN_TTL_MS = 5_000;

let pinOpen: { sessionId: string; pinId: string; at: number } | null = null;

export function requestVisualizePinOpen(sessionId: string, pinId: string, now = performance.now()): void {
  pinOpen = { sessionId, pinId, at: now };
  for (const listener of listeners) listener();
}

/** The queued pin the pending request names, if it is in this tab (and pane, when given). */
function pendingPinOpen(sessionId: string, tabId: string, pane?: number): VisualizePin | null {
  if (!pinOpen || pinOpen.sessionId !== sessionId) return null;
  const { pinId } = pinOpen;
  const pin = visualizeFeedbackFor(sessionId).pins.find((candidate) => candidate.id === pinId);
  return pin && pin.tabId === tabId && (pane === undefined || pin.pane === pane) ? pin : null;
}

/** The pin a fresh request for this pane names, left pending (an element pin
 *  waits for its page to describe it); an expired request is dropped. */
export function peekVisualizePinOpen(
  sessionId: string,
  tabId: string,
  pane: number,
  now = performance.now()
): VisualizePin | null {
  const pin = pendingPinOpen(sessionId, tabId, pane);
  if (!pin || !pinOpen) return null;
  if (now - pinOpen.at <= VISUALIZE_PIN_OPEN_TTL_MS) return pin;
  pinOpen = null;
  for (const listener of listeners) listener();
  return null;
}

/** The pin to open, once, if the request is for this pane and still fresh. */
export function takeVisualizePinOpen(
  sessionId: string,
  tabId: string,
  pane: number,
  now = performance.now()
): VisualizePin | null {
  const pin = pendingPinOpen(sessionId, tabId, pane);
  const fresh = pinOpen !== null && now - pinOpen.at <= VISUALIZE_PIN_OPEN_TTL_MS;
  if (!pin) return null;
  pinOpen = null;
  for (const listener of listeners) listener();
  return fresh ? pin : null;
}

/** Re-renders when a request for a pin of this tab (and pane, when given) arrives. */
export function useVisualizePinOpenPending(sessionId: string, tabId: string, pane?: number): boolean {
  return useSyncExternalStore(
    subscribe,
    () => pendingPinOpen(sessionId, tabId, pane) !== null,
    () => false
  );
}

/** Test seam. */
export function resetVisualizeFeedback(): void {
  feedback = new Map();
  pinOpen = null;
  store(feedback);
  for (const listener of listeners) listener();
}

/** The numbered markers one pane's page draws (element pins and anchored
 *  regions), its region pins, and the number its next pin gets. */
export function visualizePaneMarkers(
  value: VisualizeFeedback,
  tabId: string,
  pane: number
): {
  markers: VisualizePageMarker[];
  regions: Array<{ n: number; pin: VisualizePin; target: VisualizeRegionTarget }>;
  next: number;
} {
  const markers: VisualizePageMarker[] = [];
  const regions: Array<{ n: number; pin: VisualizePin; target: VisualizeRegionTarget }> = [];
  value.pins.forEach((pin, index) => {
    if (pin.tabId !== tabId || pin.pane !== pane) return;
    const n = index + 1;
    if (pin.target.type === 'element') {
      markers.push({ n, selector: pin.target.selector });
      return;
    }
    regions.push({ n, pin, target: pin.target });
    const { anchor } = pin.target;
    if (anchor) markers.push({ n, selector: anchor.selector, region: { pin: pin.id, rect: anchor.rect } });
  });
  return { markers, regions, next: value.pins.length + 1 };
}

/** The pane's queued picks, for a page that (re)loads. */
export function visualizePaneChoices(
  value: VisualizeFeedback,
  tabId: string,
  pane: number
): Array<{ group: string; choice: string }> {
  return value.choices
    .filter((choice) => choice.tabId === tabId && choice.pane === pane)
    .map(({ group, choice }) => ({ group, choice }));
}

export function visualizePinChip(pin: VisualizePin, n: number): string {
  return `${n} · ${pin.label}`;
}

export function visualizeChoicesChip(choices: readonly VisualizeChoice[]): string {
  return `☑ ${choices.map((choice) => (choice.group ? `${choice.group}: ` : '') + (choice.label || choice.choice)).join(', ')}`;
}

/** `accent: #2f6fed (was #3b82f6), density: compact (was cozy)` */
export const visualizeTweakChangesText = (set: VisualizeTweakSet): string =>
  set.changes.map((change) => `${change.id}: ${change.value} (was ${change.was})`).join(', ');

/** Leads a tweaks line in message text; the transcript draws an icon instead (the emoji has no glyph on Windows). */
export const VISUALIZE_TWEAKS_MARK = '🎚';

export function visualizeTweaksLabel(tweaks: readonly VisualizeTweakSet[]): string {
  return tweaks.map(visualizeTweakChangesText).join('; ');
}

export function visualizeTweaksChip(tweaks: readonly VisualizeTweakSet[]): string {
  return `${VISUALIZE_TWEAKS_MARK} ${visualizeTweaksLabel(tweaks)}`;
}

export interface VisualizeFeedbackImage {
  id: number;
  name: string;
  kind: 'image';
  mimeType: string;
  data: string;
  token: '';
  metadataText: string;
}

const percent = (value: number): string => `${Math.round(value * 1000) / 10}%`;
const indent = (text: string): string => text.replace(/\r\n?/g, '\n').split('\n').join('\n    ');
const quoted = (text: string): string => JSON.stringify(text);

/** The message part the agent reads (structured text), the transcript line
 *  the user sees, and the crops as image attachments numbered from
 *  `firstImageId`. */
export function visualizeFeedbackPrompt(
  value: VisualizeFeedback,
  firstImageId: number
): { text: string; display: string; images: VisualizeFeedbackImage[] } {
  const lines = [
    '<visualize_feedback>',
    'The user left this feedback in the visualize panel. Pins are numbered; the image labelled "visualize pin N" is the crop of pin N.',
  ];
  const display: string[] = [];
  const images: VisualizeFeedbackImage[] = [];
  value.pins.forEach((pin, index) => {
    const n = index + 1;
    lines.push(`pin ${n} · ${pin.label}`);
    lines.push(`  note: ${indent(pin.note)}`);
    lines.push(`  tab: ${pin.tabId} ${quoted(pin.tabLabel)} · pane ${pin.pane + 1} · file: ${pin.file}`);
    lines.push(`  kind: ${pin.paneKind} ${pin.target.type}`);
    const { target } = pin;
    if (target.type === 'element') {
      const { selector, html, styles, box, path } = target;
      lines.push(`  selector: ${selector}`);
      if (path.length) lines.push(`  inside: ${path.join(' › ')}`);
      if (html) lines.push(`  html: ${html}`);
      const styleText = Object.entries(styles)
        .map(([key, style]) => `${key}: ${style}`)
        .join('; ');
      if (styleText) lines.push(`  styles: ${styleText}`);
      lines.push(`  box: x ${box.x}, y ${box.y}, ${box.width}×${box.height} (CSS px, page coordinates)`);
    } else {
      const { view, image, time, elements, anchor } = target;
      if (time !== undefined) lines.push(`  time: ${formatVisualizeTime(time)} (${time} s into the video)`);
      lines.push(
        `  region: x ${percent(view.x)}, y ${percent(view.y)}, ${percent(view.width)}×${percent(view.height)} of the pane's visible view`
      );
      if (anchor?.path?.length) lines.push(`  inside: ${anchor.path.join(' › ')}`);
      if (elements !== undefined) lines.push(`  elements: ${elements} wholly inside the region`);
      if (image) {
        const [area, space] = time !== undefined ? ['frame area', 'video px'] : ['image area', 'image px'];
        lines.push(`  ${area}: x ${image.x}, y ${image.y}, ${image.width}×${image.height} (${space})`);
      }
    }
    if (pin.image) {
      lines.push(`  crop: image "visualize pin ${n}"`);
      images.push({
        id: firstImageId + images.length,
        name: `visualize-pin-${n}.png`,
        kind: 'image',
        mimeType: pin.image.mimeType,
        data: pin.image.data,
        token: '',
        metadataText: `[Image: visualize pin ${n} · ${pin.label}, ${pin.image.width}x${pin.image.height}]`,
      });
    } else {
      lines.push('  crop: none');
    }
    display.push(`${visualizePinChip(pin, n)} — ${pin.note.replace(/\s+/g, ' ')}`);
  });
  if (value.choices.length) {
    lines.push('choices:');
    for (const choice of value.choices) {
      lines.push(
        `  - tab: ${choice.tabId} ${quoted(choice.tabLabel)} · file: ${choice.file} · group: ${choice.group ? quoted(choice.group) : '(none)'} → choice: ${quoted(choice.choice)}${choice.label ? ` (${quoted(choice.label)})` : ''}`
      );
    }
    display.push(visualizeChoicesChip(value.choices));
  }
  if (value.tweaks.length) {
    lines.push(
      "tweaks (the user adjusted these in the panel; make them the new defaults in the file — the CSS variable / data attribute named, or the control default in the page's mx-tweaks block):"
    );
    for (const set of value.tweaks) {
      lines.push(`  - tab: ${set.tabId} ${quoted(set.tabLabel)} · pane ${set.pane + 1} · file: ${set.file}`);
      for (const change of set.changes)
        lines.push(`    ${change.id} (${change.target}): ${change.value} (was ${change.was})`);
    }
    display.push(visualizeTweaksChip(value.tweaks));
  }
  lines.push('</visualize_feedback>');
  return { text: lines.join('\n'), display: display.join('\n'), images };
}
