import {
  rankBrowserSemanticMatch,
  type BrowserSemanticMatchField,
} from './browser-semantic-query';

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
  query: string;
  warnings?: string[];
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
  nodes: AccessibilityNode[];
  bounds: Map<number, number[]>;
  error?: string;
  layoutError?: string;
}

export interface AccessibilityPageInfo {
  url: string;
  title: string;
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  text: string;
}

export interface AccessibilitySnapshotRef {
  ref: string;
  backendNodeId: number;
  sessionId?: string;
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'tab', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox',
  'slider', 'spinbutton', 'switch', 'textbox', 'treeitem',
]);

const NON_ACTIONABLE_FOCUSABLE_ROLES = new Set([
  'rootwebarea', 'webarea', 'document', 'generic', 'group', 'main', 'navigation',
]);

const CROSS_FRAME_TEXT_ROLES = new Set([
  'statictext', 'paragraph', 'heading', 'listitem', 'cell', 'rowheader', 'columnheader', 'note',
]);

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

export function buildAccessibilitySnapshot(options: {
  pageInfo: AccessibilityPageInfo;
  targets: AccessibilityTargetSnapshot[];
  snapshotId: string;
  query?: string;
  viewportOnly?: boolean;
  maxElements: number;
  textChars: number;
}): { payload: BrowserSnapshotPayload; refs: AccessibilitySnapshotRef[] } {
  const query = String(options.query || '').trim().toLowerCase();
  const headings: string[] = [];
  const warnings: string[] = [];
  const crossFrameText: string[] = [];
  const seenCrossFrameText = new Set<string>();
  const candidates: Array<{
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
  }> = [];
  let scanned = 0;

  for (const target of options.targets) {
    if (target.error) warnings.push(`Accessibility target unavailable: ${target.error}`);
    if (target.layoutError) warnings.push(`Layout metadata unavailable: ${target.layoutError}`);
    const byId = new Map(
      target.nodes
        .filter((node) => node.nodeId)
        .map((node) => [String(node.nodeId), node]),
    );
    for (const node of target.nodes) {
      scanned += 1;
      if (node.ignored) continue;
      const role = String(node.role?.value || '').trim().toLowerCase();
      const name = String(node.name?.value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (role === 'heading' && name && headings.length < 30) headings.push(`heading ${name}`);
      if (target.sessionId && CROSS_FRAME_TEXT_ROLES.has(role) && name && !seenCrossFrameText.has(name)) {
        seenCrossFrameText.add(name);
        crossFrameText.push(name);
      }
      const backendNodeId = Number(node.backendDOMNodeId);
      const focusable = axProperty(node, 'focusable') === true;
      const actionable = INTERACTIVE_ROLES.has(role)
        || (focusable && !NON_ACTIONABLE_FOCUSABLE_ROLES.has(role));
      if (!Number.isFinite(backendNodeId) || !actionable) continue;
      const sensitive = axProperty(node, 'protected') === true;
      const value = sensitive
        ? ''
        : String(node.value?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const href = String(axProperty(node, 'url') || '').slice(0, 240);
      const states: string[] = [];
      for (const property of ['disabled', 'checked', 'selected', 'expanded', 'pressed', 'required', 'readonly', 'focused']) {
        const state = axProperty(node, property);
        if (state === true) states.push(property);
        else if (state === false && property === 'checked') states.push('unchecked');
        else if (state !== undefined && state !== false && state !== '') states.push(`${property}=${String(state)}`);
      }
      const box = target.bounds.get(backendNodeId);
      const inViewport = box
        ? box[0] + box[2] > 0
          && box[1] + box[3] > (target.sessionId ? 0 : options.pageInfo.scrollY)
          && box[0] < options.pageInfo.viewportWidth
          && box[1] < (target.sessionId
            ? options.pageInfo.viewportHeight
            : options.pageInfo.scrollY + options.pageInfo.viewportHeight)
        : undefined;
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
  }

  candidates.sort(
    (left, right) => right.matchScore - left.matchScore
      || Number(right.inViewport === true) - Number(left.inViewport === true)
      || left.order - right.order,
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
      scrollY: options.pageInfo.scrollY,
      scrollHeight: options.pageInfo.scrollHeight,
      viewportWidth: options.pageInfo.viewportWidth,
      viewportHeight: options.pageInfo.viewportHeight,
      elements,
      totalElements: candidates.length,
      scanned,
      scanCapped: false,
      crossOriginFrames: Math.max(0, options.targets.filter((target) => target.sessionId).length),
      headings,
      text,
      query,
      ...(warnings.length ? { warnings } : {}),
    },
    refs,
  };
}
