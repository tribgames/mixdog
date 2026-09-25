import { rankBrowserSemanticMatch, type BrowserSemanticMatchField } from './semantic-query';

export interface BrowserSnapshotElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  href?: string;
  value?: string;
  sensitive?: boolean;
  states?: string[];
  inViewport?: boolean;
  depth?: number;
  matchField?: BrowserSemanticMatchField;
}

export interface BrowserSnapshotPayload {
  snapshotId: string;
  url: string;
  title: string;
  scrollY: number;
  scrollHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  elements: BrowserSnapshotElement[];
  totalElements: number;
  scanned: number;
  scanCapped: boolean;
  crossOriginFrames: number;
  headings: string[];
  text: string;
  /** The page holds more text than this excerpt carries. */
  textClipped?: boolean;
  query: string;
  /** Interactive elements on the page before the query filter, so a filter
   *  that matched nothing can say what it was filtering. */
  unfilteredElements?: number;
  warnings?: string[];
}

/** What a file input accepts, read from the DOM because the accessibility
 *  tree only reports it as a button. */
export interface FileInputFacts {
  accept: string;
  multiple: boolean;
}

export interface AccessibilityNode {
  nodeId?: string;
  parentId?: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  backendDOMNodeId?: number;
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
}

export interface AccessibilityTargetSnapshot {
  sessionId?: string;
  /** A same-process child document, addressed through its owning session. */
  frameId?: string;
  nodes: AccessibilityNode[];
  bounds: Map<number, number[]>;
  fileInputs?: Map<number, FileInputFacts>;
  error?: string;
  layoutError?: string;
}

/** States that tell an agent to reach a file input through `upload`. */
function fileInputStates(facts: FileInputFacts | undefined): string[] {
  if (!facts) return [];
  const states = ['file-input'];
  if (facts.accept) states.push(`accept=${facts.accept.slice(0, 120)}`);
  if (facts.multiple) states.push('multiple');
  return states;
}

export interface AccessibilityPageInfo {
  url: string;
  title: string;
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  text: string;
  /** The body holds more text than this excerpt carries. */
  textClipped?: boolean;
}

export interface AccessibilitySnapshotRef {
  ref: string;
  backendNodeId: number;
  sessionId?: string;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'textbox',
  'treeitem',
]);

const NON_ACTIONABLE_FOCUSABLE_ROLES = new Set([
  'rootwebarea',
  'webarea',
  'document',
  'generic',
  'group',
  'main',
  'navigation',
]);

const CROSS_FRAME_TEXT_ROLES = new Set([
  'statictext',
  'paragraph',
  'heading',
  'listitem',
  'cell',
  'rowheader',
  'columnheader',
  'note',
]);
const MAX_ACCESSIBILITY_SCAN = 20_000;

function axProperty(node: AccessibilityNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value?.value;
}

function nodeDepth(node: AccessibilityNode, byId: Map<string, AccessibilityNode>): number {
  let parentId = node.parentId;
  let depth = 0;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId) && depth < 20) {
    seen.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentId;
  }
  return depth;
}

interface AccessibilityCandidate {
  backendNodeId: number;
  sessionId?: string;
  role: string;
  name: string;
  value: string;
  href: string;
  sensitive: boolean;
  states: string[];
  inViewport?: boolean;
  order: number;
  depth: number;
  matchField?: BrowserSemanticMatchField;
  matchScore: number;
}

const AX_STATE_PROPERTIES = [
  'disabled',
  'checked',
  'selected',
  'expanded',
  'pressed',
  'required',
  'readonly',
  'focused',
];

/** Unicode private-use code points, where icon fonts keep their glyphs. */
const ICON_GLYPHS = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

// Whitespace-collapsed text, capped before and after collapsing so one
// pathological node cannot make the collapse itself expensive.
function compactAxText(text: string, rawCap: number, cap: number): string {
  return text.slice(0, rawCap).replace(/\s+/g, ' ').trim().slice(0, cap);
}

function axStates(node: AccessibilityNode): string[] {
  const states: string[] = [];
  for (const property of AX_STATE_PROPERTIES) {
    const state = axProperty(node, property);
    if (state === true) states.push(property);
    else if (state === false && property === 'checked') states.push('unchecked');
    else if (state !== undefined && state !== false && state !== '') {
      states.push(`${property}=${compactAxText(String(state), 320, 80)}`);
    }
  }
  return states;
}

// A frame or OOPIF session reports viewport-relative boxes; the top
// document reports page coordinates that the scroll offset shifts.
function axInViewport(
  box: ReturnType<AccessibilityTargetSnapshot['bounds']['get']>,
  framed: boolean,
  pageInfo: AccessibilityPageInfo
): boolean | undefined {
  if (!box) return undefined;
  const viewportTop = framed ? 0 : pageInfo.scrollY;
  const viewportBottom = framed ? pageInfo.viewportHeight : pageInfo.scrollY + pageInfo.viewportHeight;
  return (
    box[0] + box[2] > 0 && box[1] + box[3] > viewportTop && box[0] < pageInfo.viewportWidth && box[1] < viewportBottom
  );
}

function snapshotElement(candidate: AccessibilityCandidate, ref: string): BrowserSnapshotElement {
  return {
    ref,
    role: candidate.role,
    name: candidate.name,
    tag: 'ax',
    depth: candidate.depth,
    ...(candidate.href ? { href: candidate.href } : {}),
    ...(candidate.value ? { value: candidate.value } : {}),
    ...(candidate.sensitive ? { sensitive: true } : {}),
    ...(candidate.states.length ? { states: candidate.states } : {}),
    ...(candidate.inViewport !== undefined ? { inViewport: candidate.inViewport } : {}),
    ...(candidate.matchField ? { matchField: candidate.matchField } : {}),
  };
}

export function buildAccessibilitySnapshot(options: {
  pageInfo: AccessibilityPageInfo;
  targets: AccessibilityTargetSnapshot[];
  snapshotId: string;
  query?: string;
  viewportOnly?: boolean;
  maxElements: number;
  textChars: number;
}): { payload: BrowserSnapshotPayload; refs: AccessibilitySnapshotRef[] } {
  const query = String(options.query || '').trim();
  const headings: string[] = [];
  const warnings: string[] = [];
  const crossFrameText: string[] = [];
  const seenCrossFrameText = new Set<string>();
  let crossFrameTextChars = 0;
  let unfilteredElements = 0;
  const candidates: AccessibilityCandidate[] = [];
  let scanned = 0;

  for (const target of options.targets) {
    if (target.error) warnings.push(`Accessibility target unavailable: ${target.error.slice(0, 500)}`);
    if (target.layoutError) {
      warnings.push(`Layout metadata unavailable: ${target.layoutError.slice(0, 500)}`);
    }
    const nodes = target.nodes.slice(0, Math.max(0, MAX_ACCESSIBILITY_SCAN - scanned));
    const byId = new Map<string, AccessibilityNode>();
    for (const node of nodes) {
      if (node.nodeId) byId.set(String(node.nodeId), node);
    }
    const framed = Boolean(target.sessionId || target.frameId);
    for (const node of nodes) {
      scanned += 1;
      if (node.ignored) continue;
      const role = String(node.role?.value || '')
        .trim()
        .toLowerCase();
      // Icon fonts put private-use glyphs into the computed name through
      // ::before content; they paint as a symbol, read as nothing, and would
      // make an exact name miss what the page visibly says.
      const name = compactAxText(String(node.name?.value || '').replace(ICON_GLYPHS, ''), 640, 160);
      if (role === 'heading' && name && headings.length < 30) headings.push(`heading ${name}`);
      if (
        framed &&
        CROSS_FRAME_TEXT_ROLES.has(role) &&
        name &&
        !seenCrossFrameText.has(name) &&
        crossFrameTextChars < options.textChars * 2
      ) {
        seenCrossFrameText.add(name);
        crossFrameText.push(name);
        crossFrameTextChars += name.length;
      }
      const backendNodeId = Number(node.backendDOMNodeId);
      const focusable = axProperty(node, 'focusable') === true;
      const actionable = INTERACTIVE_ROLES.has(role) || (focusable && !NON_ACTIONABLE_FOCUSABLE_ROLES.has(role));
      if (!Number.isFinite(backendNodeId) || !actionable) continue;
      const sensitive = axProperty(node, 'protected') === true;
      const value = sensitive ? '' : compactAxText(String(node.value?.value ?? ''), 480, 120);
      const href = String(axProperty(node, 'url') || '').slice(0, 240);
      const states = axStates(node);
      states.push(...fileInputStates(target.fileInputs?.get(backendNodeId)));
      unfilteredElements += 1;
      const inViewport = axInViewport(target.bounds.get(backendNodeId), framed, options.pageInfo);
      const match = rankBrowserSemanticMatch(query, { role, name, value, href });
      if (query && !match) continue;
      if (options.viewportOnly === true && inViewport === false) continue;
      candidates.push({
        backendNodeId,
        sessionId: target.sessionId,
        role,
        name,
        value,
        href,
        sensitive,
        states,
        inViewport,
        order: scanned,
        depth: nodeDepth(node, byId),
        ...(query && match ? { matchField: match.field } : {}),
        matchScore: match?.score || 0,
      });
    }
    if (scanned >= MAX_ACCESSIBILITY_SCAN) break;
  }

  candidates.sort(
    (left, right) =>
      right.matchScore - left.matchScore ||
      Number(right.inViewport === true) - Number(left.inViewport === true) ||
      left.order - right.order
  );
  const selected = candidates.slice(0, options.maxElements);
  const refs: AccessibilitySnapshotRef[] = [];
  const elements = selected.map((candidate, index): BrowserSnapshotElement => {
    const ref = `${options.snapshotId}-e${index + 1}`;
    refs.push({
      ref,
      backendNodeId: candidate.backendNodeId,
      sessionId: candidate.sessionId,
    });
    return snapshotElement(candidate, ref);
  });
  const text = [options.pageInfo.text, ...crossFrameText]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, options.textChars);
  return {
    payload: {
      snapshotId: options.snapshotId,
      url: options.pageInfo.url,
      title: options.pageInfo.title,
      textClipped: options.pageInfo.textClipped === true,
      scrollY: options.pageInfo.scrollY,
      scrollHeight: options.pageInfo.scrollHeight,
      viewportWidth: options.pageInfo.viewportWidth,
      viewportHeight: options.pageInfo.viewportHeight,
      elements,
      totalElements: candidates.length,
      scanned,
      scanCapped: options.targets.reduce((total, target) => total + target.nodes.length, 0) > scanned,
      crossOriginFrames: options.targets.filter((target) => target.sessionId).length,
      headings,
      text,
      query,
      unfilteredElements,
      ...(warnings.length ? { warnings } : {}),
    },
    refs,
  };
}
