// The user's visualize feedback waiting for the next message, per session:
// numbered pins (an element of an HTML pane, or a dragged region of a PDF or
// image pane) and `data-choice` picks. The composer shows them as chips and
// sends them with the next user message; the panes draw the pins' numbers.
// A pin's number is its position in the session's list, so removing one
// renumbers the rest in the chips and on the pages alike.
import { useSyncExternalStore } from 'react';

import type { VisualizePaneView } from '../shared/visualize';
import type { VisualizeFeedbackRect } from '../shared/visualize-feedback';
import type { VisualizeTweakChange } from '../shared/visualize-tweaks';

/** The file a pin names: project-relative on the desktop (`file`), and the
 *  host's path-free target on a remote client. */
export function visualizePaneFile(pane: VisualizePaneView): string {
  const file = pane.file ?? pane.target;
  return pane.version === undefined ? file : `${file} (kept version v${pane.version}, read-only)`;
}

/** Pane kinds that take a dragged region instead of an element. */
export function visualizeRegionPane(kind: string): boolean {
  return kind === 'pdf' || kind === 'document' || kind === 'image';
}

export interface VisualizePinImage {
  /** Base64 PNG of the pinned area (secret fields painted over). */
  data: string;
  mimeType: 'image/png';
  width: number;
  height: number;
}

export interface VisualizeElementPin {
  selector: string;
  html: string;
  styles: Record<string, string>;
  /** Page (document) CSS px. */
  box: VisualizeFeedbackRect;
}

export interface VisualizeRegionPin {
  /** Fractions (0-1) of the pane's visible view. */
  view: VisualizeFeedbackRect;
  /** Image panes: the same area in the image's own pixels. */
  image?: VisualizeFeedbackRect;
}

export interface VisualizePin {
  id: string;
  tabId: string;
  tabLabel: string;
  pane: number;
  paneKind: string;
  /** Project-relative file of the pane (never a host path on a remote client). */
  file: string;
  note: string;
  /** Chip label: `tag#id.class` for an element, `<file> region` for a region. */
  label: string;
  element?: VisualizeElementPin;
  region?: VisualizeRegionPin;
  image?: VisualizePinImage;
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
        // A queue stored before tweaks existed has none.
        .map(([id, value]): [string, VisualizeFeedback] => [id, { ...value, tweaks: Array.isArray(value.tweaks) ? value.tweaks : [] }])
    );
  } catch {
    return new Map();
  }
}

/** Pin ids stay unique past the restored ones. */
const lastPinNumber = (map: Map<string, VisualizeFeedback>): number =>
  Math.max(0, ...[...map.values()].flatMap((value) => value.pins.map((pin) => Number(pin.id.slice(1)) || 0)));

function store(map: Map<string, VisualizeFeedback>): void {
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
 *  while it travelled stays for the next one). */
export function consumeVisualizeFeedback(sessionId: string, sent: VisualizeFeedback): void {
  const pins = new Set(sent.pins.map((pin) => pin.id));
  const choices = new Set(sent.choices);
  const tweaks = new Set(sent.tweaks);
  const current = visualizeFeedbackFor(sessionId);
  update(sessionId, {
    pins: current.pins.filter((pin) => !pins.has(pin.id)),
    choices: current.choices.filter((choice) => !choices.has(choice)),
    tweaks: current.tweaks.filter((set) => !tweaks.has(set)),
  });
}

/** Test seam. */
export function resetVisualizeFeedback(): void {
  feedback = new Map();
  store(feedback);
  for (const listener of listeners) listener();
}

/** The numbered markers one pane draws, and the number its next pin gets. */
export function visualizePaneMarkers(
  value: VisualizeFeedback,
  tabId: string,
  pane: number
): { markers: Array<{ n: number; selector: string }>; regions: Array<{ n: number; pin: VisualizePin }>; next: number } {
  const markers: Array<{ n: number; selector: string }> = [];
  const regions: Array<{ n: number; pin: VisualizePin }> = [];
  value.pins.forEach((pin, index) => {
    if (pin.tabId !== tabId || pin.pane !== pane) return;
    if (pin.element) markers.push({ n: index + 1, selector: pin.element.selector });
    else if (pin.region) regions.push({ n: index + 1, pin });
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
  return `📌 ${n} · ${pin.label}`;
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
    lines.push(`  tab: ${pin.tabId} ${quoted(pin.tabLabel)} · pane ${pin.pane + 1} (${pin.paneKind}) · file: ${pin.file}`);
    if (pin.element) {
      const { selector, html, styles, box } = pin.element;
      lines.push(`  selector: ${selector}`);
      if (html) lines.push(`  html: ${html}`);
      const styleText = Object.entries(styles)
        .map(([key, style]) => `${key}: ${style}`)
        .join('; ');
      if (styleText) lines.push(`  styles: ${styleText}`);
      lines.push(`  box: x ${box.x}, y ${box.y}, ${box.width}×${box.height} (CSS px, page coordinates)`);
    }
    if (pin.region) {
      const { view, image } = pin.region;
      lines.push(
        `  region: x ${percent(view.x)}, y ${percent(view.y)}, ${percent(view.width)}×${percent(view.height)} of the pane's visible view`
      );
      if (image) {
        lines.push(`  image area: x ${image.x}, y ${image.y}, ${image.width}×${image.height} (image px)`);
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
      'tweaks (the user adjusted these in the panel; make them the new defaults in the file — the CSS variable / data attribute named, or the control default in the page\'s mx-tweaks block):'
    );
    for (const set of value.tweaks) {
      lines.push(`  - tab: ${set.tabId} ${quoted(set.tabLabel)} · pane ${set.pane + 1} · file: ${set.file}`);
      for (const change of set.changes) lines.push(`    ${change.id} (${change.target}): ${change.value} (was ${change.was})`);
    }
    display.push(visualizeTweaksChip(value.tweaks));
  }
  lines.push('</visualize_feedback>');
  return { text: lines.join('\n'), display: display.join('\n'), images };
}
