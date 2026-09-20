/**
 * Reading the accessibility tree of every CDP target a page has attached —
 * the main target plus its cross-origin frames — together with the layout
 * bounds and file-input facts only the DOM snapshot knows. Reads settle
 * independently so one broken frame degrades the observation instead of
 * failing it; the caller learns how much was left out.
 */
import type { WebContents } from 'electron';

import type { AccessibilityNode, AccessibilityTargetSnapshot, FileInputFacts } from './accessibility';
import type { BrowserCdpPort } from './cdp';
import { createBrowserReadPool, settleBrowserReads } from './parallel-read';
import { redactBrowserText } from './redaction';

export const MAX_ACCESSIBILITY_TARGETS = 32;
const MAX_FRAME_DOCUMENTS = 64;

export interface DomSnapshotDocument {
  frameId?: number;
  nodes?: {
    backendNodeId?: number[];
    nodeName?: number[];
    attributes?: number[][];
  };
  layout?: { nodeIndex?: number[]; bounds?: number[][] };
}

interface DomSnapshot {
  documents?: DomSnapshotDocument[];
  strings?: string[];
}

/** A CDP target session the page has attached, as the debugger tracks it. */
export interface BrowserTargetSession {
  frameId?: string;
  parentSessionId?: string;
  ready?: Promise<unknown>;
}

export interface AccessibilityTargetsRead {
  snapshots: AccessibilityTargetSnapshot[];
  /** Cross-origin targets beyond the per-snapshot cap. */
  omittedTargets: number;
  /** Same-process frame documents beyond the per-target cap. */
  omittedFrames: number;
}

/** File inputs by backend node, read from the DOM snapshot's attributes: the
 *  accessibility tree calls them buttons, which hides that `upload` is the
 *  gesture they want and whether they take one file or several. */
export function fileInputsFromDomSnapshot(
  strings: string[],
  documents: DomSnapshotDocument[]
): Map<number, FileInputFacts> {
  const fileInputs = new Map<number, FileInputFacts>();
  for (const document of documents) {
    const backendNodeIds = document.nodes?.backendNodeId || [];
    const nodeNames = document.nodes?.nodeName || [];
    const attributes = document.nodes?.attributes || [];
    nodeNames.forEach((nameIndex, nodeIndex) => {
      if (String(strings[nameIndex] || '').toUpperCase() !== 'INPUT') return;
      const pairs = attributes[nodeIndex] || [];
      let type = '';
      let accept = '';
      let multiple = false;
      for (let index = 0; index + 1 < pairs.length; index += 2) {
        const attributeName = String(strings[pairs[index]] || '').toLowerCase();
        const attributeValue = String(strings[pairs[index + 1]] ?? '');
        if (attributeName === 'type') type = attributeValue.trim().toLowerCase();
        else if (attributeName === 'accept') accept = attributeValue.replace(/\s+/g, ' ').trim();
        else if (attributeName === 'multiple') multiple = true;
      }
      const backendNodeId = backendNodeIds[nodeIndex];
      if (type === 'file' && Number.isFinite(backendNodeId)) {
        fileInputs.set(backendNodeId, { accept, multiple });
      }
    });
  }
  return fileInputs;
}

/** Layout boxes by backend node, from the DOM snapshot's layout tree. */
function layoutBoundsFromDomSnapshot(documents: DomSnapshotDocument[]): Map<number, number[]> {
  const bounds = new Map<number, number[]>();
  for (const document of documents) {
    const backendNodeIds = document.nodes?.backendNodeId || [];
    const nodeIndexes = document.layout?.nodeIndex || [];
    const boxes = document.layout?.bounds || [];
    nodeIndexes.forEach((nodeIndex, index) => {
      const backendNodeId = backendNodeIds[nodeIndex];
      const box = boxes[index];
      if (Number.isFinite(backendNodeId) && Array.isArray(box) && box.length >= 4) {
        bounds.set(backendNodeId, box);
      }
    });
  }
  return bounds;
}

function redactedMessage(error: unknown): string {
  return redactBrowserText((error as Error).message || String(error));
}

async function readFrameTree(
  cdp: BrowserCdpPort,
  guest: WebContents,
  sessionId: string | undefined,
  frameId: string | undefined,
  shared: { bounds: Map<number, number[]>; fileInputs: Map<number, FileInputFacts> },
  signal?: AbortSignal
): Promise<AccessibilityTargetSnapshot> {
  const { bounds, fileInputs } = shared;
  try {
    if (!frameId) throw new Error('frame document has no frame identity');
    const tree = await cdp.call<{ nodes?: AccessibilityNode[] }>(
      guest,
      'Accessibility.getFullAXTree',
      { frameId },
      signal,
      { sessionId }
    );
    return { sessionId, frameId, nodes: tree.nodes || [], bounds, fileInputs };
  } catch (error) {
    return { sessionId, frameId, nodes: [], bounds, error: redactedMessage(error) };
  }
}

/** The main-frame tree of one target plus every same-process frame document
 *  the DOM snapshot lists; `getFullAXTree` only covers the main frame by
 *  default, so frames are read one by one. */
async function readTargetTrees(
  cdp: BrowserCdpPort,
  guest: WebContents,
  sessionId: string | undefined,
  readFrame: ReturnType<typeof createBrowserReadPool>,
  omitted: { frames: number },
  signal?: AbortSignal
): Promise<AccessibilityTargetSnapshot[]> {
  let layoutError = '';
  const [axTree, domSnapshot] = await Promise.all([
    cdp.call<{ nodes?: AccessibilityNode[] }>(guest, 'Accessibility.getFullAXTree', {}, signal, { sessionId }),
    cdp
      .call<DomSnapshot>(
        guest,
        'DOMSnapshot.captureSnapshot',
        { computedStyles: [], includeDOMRects: true, includePaintOrder: true },
        signal,
        { sessionId }
      )
      .catch((error) => {
        layoutError = redactedMessage(error);
        return { documents: [], strings: [] } as DomSnapshot;
      }),
  ]);
  const documents = domSnapshot.documents || [];
  const shared = {
    bounds: layoutBoundsFromDomSnapshot(documents),
    fileInputs: fileInputsFromDomSnapshot(domSnapshot.strings || [], documents),
  };
  const mainSnapshot: AccessibilityTargetSnapshot = {
    sessionId,
    nodes: axTree.nodes || [],
    ...shared,
    ...(layoutError ? { layoutError } : {}),
  };
  omitted.frames += Math.max(0, documents.length - MAX_FRAME_DOCUMENTS);
  const frameSnapshots = await settleBrowserReads(
    documents.slice(1, MAX_FRAME_DOCUMENTS).map((document) =>
      readFrame(() => {
        const frameId = document.frameId === undefined ? undefined : domSnapshot.strings?.[document.frameId];
        return readFrameTree(cdp, guest, sessionId, frameId, shared, signal);
      })
    )
  );
  return [mainSnapshot, ...frameSnapshots];
}

/** Every attached target's trees, main target first, each target waiting for
 *  its own debugger attach before it is read. A target that cannot be read at
 *  all still yields one empty snapshot carrying its error. */
export async function readAccessibilityTargets(
  cdp: BrowserCdpPort,
  guest: WebContents,
  sessions: Map<string, BrowserTargetSession>,
  signal?: AbortSignal
): Promise<AccessibilityTargetsRead> {
  const childTargets = [...sessions.entries()];
  const omittedTargets = Math.max(0, childTargets.length - (MAX_ACCESSIBILITY_TARGETS - 1));
  const targets: { sessionId: string | undefined; ready?: Promise<unknown> }[] = [
    { sessionId: undefined, ready: Promise.resolve() },
    ...childTargets.slice(0, MAX_ACCESSIBILITY_TARGETS - 1).map(([sessionId, target]) => ({
      sessionId,
      ready: target.ready,
    })),
  ];
  const omitted = { frames: 0 };
  const read = createBrowserReadPool();
  const readFrame = createBrowserReadPool();
  const snapshots = (
    await settleBrowserReads(
      targets.map(async ({ sessionId, ready }) => {
        try {
          await ready;
          return await read(() => readTargetTrees(cdp, guest, sessionId, readFrame, omitted, signal));
        } catch (error) {
          return [
            {
              sessionId,
              nodes: [],
              bounds: new Map<number, number[]>(),
              error: redactedMessage(error),
            } satisfies AccessibilityTargetSnapshot,
          ];
        }
      })
    )
  ).flat();
  return { snapshots, omittedTargets, omittedFrames: omitted.frames };
}
