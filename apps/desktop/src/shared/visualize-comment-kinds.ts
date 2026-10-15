// The visualize panel's Comment (pin) feature, one entry per pane kind: how
// a pin is made on it (element click, dragged region), what anchors it, where
// its crop comes from, how its label reads, which icon stands in for a pin
// without a crop, and what the hint strip offers. The panel, the feedback
// store and the composer card read only this table; supporting a new pane
// kind is adding its entry here.
//
// Text here is English source text: the renderer passes its `t` as
// `translate` (the locale catalogs carry these keys), tests pass nothing.

import type { VisualizeInlineKind, VisualizePaneKind, VisualizePaneView } from './visualize';

/** How the user marks what a pin is about. */
export type VisualizeCommentSelect = 'element' | 'region';
/** What anchors a pin: an element's selector, a rectangle of the pane's view,
 *  or a rectangle of a video frame at a time. */
export type VisualizeCommentAnchor = 'selector' | 'rect' | 'rect+time';
/** Where a pin's crop comes from. `page`: a window capture of an HTML pane,
 *  secret fields re-read from the page and masked. `window`: a window capture
 *  (desktop only). `image` / `video-frame`: the area in the image's (the
 *  current frame's) own pixels, drawn from the element, or a window capture
 *  where the canvas may not read it. */
export type VisualizeCommentCrop = 'page' | 'window' | 'image' | 'video-frame';
/** Icon (lucide name) shown for a pin that has no crop. */
export type VisualizeCommentIcon = 'code' | 'file-text' | 'file' | 'image' | 'shapes' | 'film';
export type VisualizeTranslate = (key: string, values?: Record<string, string | number>) => string;

/** One hint strip entry: optional keys, then its text. */
export interface VisualizeCommentHint {
  id: 'click' | 'drag' | 'parent' | 'play' | 'seek';
  keys?: readonly string[];
  text: string;
}

/** What a label is built from: an element the page described, or a region
 *  (`time` in seconds on a video, `elements` = HTML elements inside it). */
export type VisualizeCommentSubject =
  | { type: 'element'; role: VisualizeElementRole; name: string }
  | { type: 'region'; time?: number; elements?: number };

export type VisualizeCommentPane = Pick<VisualizePaneView, 'kind'> & Partial<Pick<VisualizePaneView, 'inline'>>;

export interface VisualizeCommentKind {
  select: readonly VisualizeCommentSelect[];
  anchors: readonly VisualizeCommentAnchor[];
  crop: VisualizeCommentCrop;
  icon: VisualizeCommentIcon;
  hints: readonly VisualizeCommentHint[];
  /** The pane plays media: Comment mode pauses it and draws a timeline with
   *  the pins on it; Space plays/pauses and ←/→ seek. */
  media: boolean;
  /** The pane is a live page in a frame that runs the feedback page script:
   *  the panel attaches the script, answers its messages (ready, choices,
   *  tweaks) and mirrors Comment mode and pin numbers into it. */
  page: boolean;
  label(subject: VisualizeCommentSubject, pane: VisualizeCommentPane, translate: VisualizeTranslate): string;
}

/** `{{name}}` slots filled, no catalog: what a label reads without one. */
export const visualizeEnglish: VisualizeTranslate = (key, values) =>
  key.replace(/\{\{(\w+)\}\}/g, (slot, name: string) => (values && name in values ? String(values[name]) : slot));

/** Human element kinds the page reports, with their English nouns. */
export const VISUALIZE_ELEMENT_ROLES = {
  button: 'Button',
  link: 'Link',
  heading: 'Heading',
  image: 'Image',
  field: 'Field',
  checkbox: 'Checkbox',
  list: 'List',
  item: 'List item',
  table: 'Table',
  row: 'Row',
  form: 'Form',
  navigation: 'Navigation',
  header: 'Header',
  footer: 'Footer',
  section: 'Section',
  paragraph: 'Paragraph',
  text: 'Text',
  media: 'Media',
  box: 'Box',
} as const;
export type VisualizeElementRole = keyof typeof VISUALIZE_ELEMENT_ROLES;

/** Tag → kind (the page script also reads these tables). */
export const VISUALIZE_TAG_ROLES: Readonly<Record<string, VisualizeElementRole>> = {
  button: 'button',
  a: 'link',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'image',
  svg: 'image',
  picture: 'image',
  canvas: 'image',
  input: 'field',
  textarea: 'field',
  select: 'field',
  ul: 'list',
  ol: 'list',
  li: 'item',
  table: 'table',
  tr: 'row',
  form: 'form',
  nav: 'navigation',
  header: 'header',
  footer: 'footer',
  section: 'section',
  article: 'section',
  aside: 'section',
  main: 'section',
  p: 'paragraph',
  span: 'text',
  strong: 'text',
  em: 'text',
  b: 'text',
  i: 'text',
  small: 'text',
  label: 'text',
  video: 'media',
  audio: 'media',
};
/** `<input type>` → kind, before the tag's own. */
export const VISUALIZE_INPUT_ROLES: Readonly<Record<string, VisualizeElementRole>> = {
  checkbox: 'checkbox',
  radio: 'checkbox',
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
};
/** ARIA role → kind, before the input type and tag. */
export const VISUALIZE_ARIA_ROLES: Readonly<Record<string, VisualizeElementRole>> = {
  button: 'button',
  link: 'link',
  heading: 'heading',
  img: 'image',
  textbox: 'field',
  searchbox: 'field',
  combobox: 'field',
  checkbox: 'checkbox',
  switch: 'checkbox',
  radio: 'checkbox',
  list: 'list',
  listitem: 'item',
  table: 'table',
  grid: 'table',
  row: 'row',
  form: 'form',
  navigation: 'navigation',
  banner: 'header',
  contentinfo: 'footer',
  region: 'section',
  main: 'section',
};

export function visualizeElementRole(value: unknown): VisualizeElementRole {
  return typeof value === 'string' && Object.hasOwn(VISUALIZE_ELEMENT_ROLES, value)
    ? (value as VisualizeElementRole)
    : 'box';
}

/** Every kind's noun in the UI language (the page draws its hover label with them). */
export function visualizeElementNouns(
  translate: VisualizeTranslate = visualizeEnglish
): Record<VisualizeElementRole, string> {
  const nouns = {} as Record<VisualizeElementRole, string>;
  for (const [role, noun] of Object.entries(VISUALIZE_ELEMENT_ROLES))
    nouns[role as VisualizeElementRole] = translate(noun);
  return nouns;
}

/** "Button · Save", or "Button" without a name. */
export function visualizeElementName(
  node: { role: VisualizeElementRole; name: string },
  translate: VisualizeTranslate = visualizeEnglish
): string {
  const noun = translate(VISUALIZE_ELEMENT_ROLES[node.role]);
  return node.name ? `${noun} · ${node.name}` : noun;
}

/** `m:ss` (`h:mm:ss` past an hour). */
export function formatVisualizeTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const INLINE_NAMES: Record<VisualizeInlineKind, string> = {
  mermaid: 'Mermaid',
  svg: 'SVG',
  chart: 'ECharts',
  html: 'HTML',
  markdown: 'Markdown',
};

const HINT_CLICK: VisualizeCommentHint = { id: 'click', text: 'Click element' };
const HINT_DRAG: VisualizeCommentHint = { id: 'drag', text: 'Drag area' };
const HINT_PARENT: VisualizeCommentHint = { id: 'parent', keys: ['Alt', '↑'], text: 'Parent element' };
const HINT_PLAY: VisualizeCommentHint = { id: 'play', keys: ['Space'], text: 'Play/pause' };
const HINT_SEEK: VisualizeCommentHint = { id: 'seek', keys: ['←', '→'], text: 'Seek' };

/** "<what> · Region" for the region kinds. */
function regionKind(
  what: (pane: VisualizeCommentPane, subject: VisualizeCommentSubject, translate: VisualizeTranslate) => string,
  overrides: Partial<VisualizeCommentKind> = {}
): VisualizeCommentKind {
  return {
    select: ['region'],
    anchors: ['rect'],
    crop: 'window',
    icon: 'file',
    hints: [HINT_DRAG],
    media: false,
    page: false,
    label: (subject, pane, translate) => `${what(pane, subject, translate)} · ${translate('Region')}`,
    ...overrides,
  };
}

/** Every pane kind; null = no comments on it. */
export const VISUALIZE_COMMENT_KINDS: Readonly<Record<VisualizePaneKind, VisualizeCommentKind | null>> = {
  html: {
    select: ['element', 'region'],
    anchors: ['selector', 'rect'],
    crop: 'page',
    icon: 'code',
    hints: [HINT_CLICK, HINT_DRAG, HINT_PARENT],
    media: false,
    page: true,
    label(subject, _pane, translate) {
      if (subject.type === 'element') return visualizeElementName(subject, translate);
      if (!subject.elements) return translate('Region');
      return subject.elements === 1
        ? translate('Region · 1 element')
        : translate('Region · {{n}} elements', { n: subject.elements });
    },
  },
  document: regionKind((_pane, _subject, translate) => translate('Document'), { icon: 'file-text' }),
  pdf: regionKind(() => 'PDF', { icon: 'file-text' }),
  image: regionKind((_pane, _subject, translate) => translate('Image'), { crop: 'image', icon: 'image' }),
  inline: regionKind(
    (pane, _subject, translate) => (pane.inline ? INLINE_NAMES[pane.inline.kind] : translate('Image')),
    {
      icon: 'shapes',
    }
  ),
  video: regionKind(
    (_pane, subject, translate) =>
      translate('Video {{time}}', { time: formatVisualizeTime(subject.type === 'region' ? (subject.time ?? 0) : 0) }),
    { anchors: ['rect+time'], crop: 'video-frame', icon: 'film', hints: [HINT_DRAG, HINT_PLAY, HINT_SEEK], media: true }
  ),
  audio: null,
};

export function visualizeCommentKind(kind: string): VisualizeCommentKind | null {
  return Object.hasOwn(VISUALIZE_COMMENT_KINDS, kind) ? VISUALIZE_COMMENT_KINDS[kind as VisualizePaneKind] : null;
}

/** A pin's human label ("Button · Save", "Region · 2 elements", "Video 0:12 · Region"). */
export function visualizeCommentLabel(
  subject: VisualizeCommentSubject,
  pane: VisualizeCommentPane,
  translate: VisualizeTranslate = visualizeEnglish
): string {
  const kind = visualizeCommentKind(pane.kind);
  return kind ? kind.label(subject, pane, translate) : translate('Region');
}

/** Whether panes of this kind are live pages running the feedback page script. */
export function visualizeCommentPage(kind: string): boolean {
  return visualizeCommentKind(kind)?.page ?? false;
}

/** The icon for a pin of this pane kind that has no crop. */
export function visualizeCommentIcon(kind: string): VisualizeCommentIcon {
  return visualizeCommentKind(kind)?.icon ?? 'file';
}

/** The hint strip's actions for these pane kinds, each once, in order. */
export function visualizeCommentHints(kinds: readonly string[]): VisualizeCommentHint[] {
  const hints = new Map<string, VisualizeCommentHint>();
  for (const kind of kinds) for (const hint of visualizeCommentKind(kind)?.hints ?? []) hints.set(hint.id, hint);
  return [...hints.values()];
}
