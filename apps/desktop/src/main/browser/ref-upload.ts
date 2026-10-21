/**
 * Putting files on the page. A file-input ref takes them directly; any other
 * ref is clicked to open its picker, and a zone that never shows a picker
 * takes them as a drop; no ref answers a picker the page already opened.
 * Every route verifies the page accepted the files instead of assuming it.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { WebContents } from 'electron';

import {
  BROWSER_BOUND_DROP_GUARD_INSTALL,
  BROWSER_BOUND_DROP_GUARD_TAKE,
  BROWSER_DROP_GUARD_AIM,
  BROWSER_DROP_GUARD_INSTALL,
  BROWSER_DROP_GUARD_TAKE,
} from './file-drop';
import type { PendingFileChooser } from './guest-state';
import { browserRefElementSource } from './ref-access';
import type { BrowserRefActionsHost } from './ref-actions';

type RefUploadHost = Pick<
  BrowserRefActionsHost,
  | 'cdp'
  | 'accessibilityRefs'
  | 'resolveRefPoint'
  | 'input'
  | 'pause'
  | 'pendingFileChooser'
  | 'clearFileChooser'
  | 'evaluateInFrames'
  | 'evaluateInFramesByFrame'
  | 'frames'
  | 'frameOffsetForSession'
>;

/** How long a clicked button gets to open its picker. */
const FILE_CHOOSER_WAIT_MS = 3_000;
const FILE_CHOOSER_POLL_MS = 50;
const MAX_UPLOAD_FILES = 10;

interface RefObject {
  objectId: string;
  sessionId?: string;
}

/** The document that receives an upload: the CDP session it lives in and its
 *  URL. `key` is what an approval binds; `url` is what the card shows. */
export interface UploadReceiver {
  key: string;
  url: string;
}

const UPLOAD_TARGET_CHANGED = 'upload target changed; nothing was dispatched';

function releaseObject(host: RefUploadHost, guest: WebContents, object: RefObject): void {
  void host.cdp
    .guestDebugger(guest)
    .then((debug) => debug.sendCommand('Runtime.releaseObject', { objectId: object.objectId }, object.sessionId))
    .catch(() => undefined);
}

interface FrameTreeNode {
  frame?: { id?: string; loaderId?: string };
  childFrames?: FrameTreeNode[];
}

interface DescribedNode {
  frameId?: string;
  children?: DescribedNode[];
}

function loaderOfFrame(node: FrameTreeNode | undefined, frameId: string): string | undefined {
  if (!node) return undefined;
  if (node.frame?.id === frameId) return node.frame.loaderId;
  for (const child of node.childFrames || []) {
    const found = loaderOfFrame(child, frameId);
    if (found) return found;
  }
  return undefined;
}

/** The frame document an element belongs to, read from the element itself so a
 *  same-process iframe and a cross-origin one are told apart alike. The key is
 *  the CDP session, the frame id, the document's loader id (a reload, even to
 *  the same URL, is a new document) and its URL. */
async function receiverOfObject(
  host: RefUploadHost,
  guest: WebContents,
  object: RefObject,
  signal?: AbortSignal
): Promise<UploadReceiver> {
  const { key, url } = await frameOfObject(host, guest, object, signal);
  return { key, url };
}

/** The receiver, with the frame id and loader id it names. */
async function frameOfObject(
  host: RefUploadHost,
  guest: WebContents,
  object: RefObject,
  signal?: AbortSignal
): Promise<UploadReceiver & { frameId: string; loaderId: string }> {
  const unidentified = () => new Error(UNIDENTIFIED_RECEIVER);
  const call = <T>(method: string, params: Record<string, unknown>) =>
    host.cdp.call<T>(guest, method, params, signal, { sessionId: object.sessionId });
  const reply = await call<{ result?: { value?: { url?: string } }; exceptionDetails?: unknown }>(
    'Runtime.callFunctionOn',
    {
      objectId: object.objectId,
      functionDeclaration: `function() {
          const doc = this.ownerDocument || this;
          return { url: String((doc.location && doc.location.href) || '') };
        }`,
      returnByValue: true,
    }
  );
  const url = reply.result?.value?.url;
  if (reply.exceptionDetails || !url) throw unidentified();
  const owner = await call<{ result?: { objectId?: string } }>('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function() { return this.ownerDocument || this; }',
    returnByValue: false,
  });
  const documentObject = owner.result?.objectId
    ? { objectId: owner.result.objectId, sessionId: object.sessionId }
    : null;
  if (!documentObject) throw unidentified();
  let frameId: string | undefined;
  try {
    // Chromium reports a document's frame on its root element, not on the
    // #document node itself (Electron 41), so one level of children is read.
    const { node } = await call<{ node?: DescribedNode }>('DOM.describeNode', {
      objectId: documentObject.objectId,
      depth: 1,
    });
    frameId = node?.frameId || node?.children?.find((child) => child.frameId)?.frameId;
  } finally {
    releaseObject(host, guest, documentObject);
  }
  const tree = await call<{ frameTree?: FrameTreeNode }>('Page.getFrameTree', {});
  const loaderId = frameId ? loaderOfFrame(tree.frameTree, frameId) : undefined;
  if (!frameId || !loaderId) throw unidentified();
  return { key: `${object.sessionId || ''}\n${frameId}\n${loaderId}\n${url}`, url, frameId, loaderId };
}

/** The approved drop target as the browser identifies it. */
interface DropTarget {
  sessionId?: string;
  frameId: string;
  loaderId: string;
  backendNodeId: number;
  /** The approved frame's observation world: untouched by page scripts. */
  executionContextId: number;
}

/** True when `this` is the hit node or one of its flat-tree ancestors. Runs in
 *  an isolated world, so page overrides of DOM accessors do not apply. */
const CONTAINS_HIT = `function(hit) {
  for (let node = hit; node; node = node.parentNode || (node.nodeType === 11 ? node.host : null)) {
    if (node === this) return true;
  }
  return false;
}`;

/** Refuses unless the topmost node at the drop point, hit-tested by the
 *  browser itself (no page script takes part), is the approved target or a
 *  descendant of it, in the approved frame and document. Chromium hands a
 *  drop to the frame of that node, so a frame laid or swapped over the point
 *  never receives the files. Hit testing descends into each cross-origin
 *  frame whose owner element is hit. */
async function assertDropLandsOn(
  host: RefUploadHost,
  guest: WebContents,
  point: { x: number; y: number },
  target: DropTarget,
  signal?: AbortSignal
): Promise<void> {
  const changed = () => new Error(UPLOAD_TARGET_CHANGED);
  const frames = host.frames?.(guest) ?? new Map<string, { frameId?: string }>();
  let sessionId: string | undefined;
  let local = { x: point.x, y: point.y };
  let hit: { backendNodeId?: number; frameId?: string } | undefined;
  for (let depth = 0; depth < 16; depth++) {
    try {
      hit = await host.cdp.call<{ backendNodeId?: number; frameId?: string }>(
        guest,
        'DOM.getNodeForLocation',
        { x: Math.round(local.x), y: Math.round(local.y), includeUserAgentShadowDOM: false },
        signal,
        { sessionId }
      );
    } catch {
      signal?.throwIfAborted();
      throw changed();
    }
    if (!hit?.backendNodeId) throw changed();
    const { node } = await host.cdp.call<{ node?: { nodeName?: string; frameId?: string } }>(
      guest,
      'DOM.describeNode',
      { backendNodeId: hit.backendNodeId },
      signal,
      { sessionId }
    );
    // A frame owner reports its content frame; a document's root element
    // reports its own frame, so only owner elements are descended into.
    const owner = /^(I?FRAME|OBJECT|EMBED|FENCEDFRAME|PORTAL)$/i.test(node?.nodeName || '') ? node?.frameId : '';
    const child = owner ? [...frames].find(([, frame]) => frame.frameId === owner)?.[0] : undefined;
    if (!child) break;
    const offset = host.frameOffsetForSession ? await host.frameOffsetForSession(guest, child, signal) : null;
    if (!offset) throw changed();
    sessionId = child;
    local = { x: point.x - offset.x, y: point.y - offset.y };
  }
  if (!hit?.backendNodeId || (sessionId || '') !== (target.sessionId || '') || hit.frameId !== target.frameId) {
    throw changed();
  }
  const call = <T>(method: string, params: Record<string, unknown>) =>
    host.cdp.call<T>(guest, method, params, signal, { sessionId });
  const tree = await call<{ frameTree?: FrameTreeNode }>('Page.getFrameTree', {});
  if (loaderOfFrame(tree.frameTree, target.frameId) !== target.loaderId) throw changed();
  const resolve = (backendNodeId: number) =>
    call<{ object?: { objectId?: string } }>('DOM.resolveNode', {
      backendNodeId,
      executionContextId: target.executionContextId,
    });
  const [approved, topmost] = [await resolve(target.backendNodeId), await resolve(hit.backendNodeId)];
  try {
    if (!approved.object?.objectId || !topmost.object?.objectId) throw changed();
    const contains = await call<{ result?: { value?: boolean }; exceptionDetails?: unknown }>(
      'Runtime.callFunctionOn',
      {
        objectId: approved.object.objectId,
        functionDeclaration: CONTAINS_HIT,
        arguments: [{ objectId: topmost.object.objectId }],
        returnByValue: true,
      }
    );
    if (contains.exceptionDetails || contains.result?.value !== true) throw changed();
  } finally {
    for (const object of [approved.object?.objectId, topmost.object?.objectId]) {
      if (object) releaseObject(host, guest, { objectId: object, sessionId });
    }
  }
}

const UNIDENTIFIED_RECEIVER = 'the frame receiving the upload could not be identified';

/** The ref element as the approved frame's observation world sees it, so its
 *  drop guard can be aimed there. */
async function backendNodeOf(
  host: RefUploadHost,
  guest: WebContents,
  ref: string,
  object: RefObject,
  signal?: AbortSignal
): Promise<number> {
  const known = host.accessibilityRefs(guest)?.refs.get(ref)?.backendNodeId;
  if (known) return known;
  const described = await host.cdp.call<{ node?: { backendNodeId?: number } }>(
    guest,
    'DOM.describeNode',
    { objectId: object.objectId },
    signal,
    { sessionId: object.sessionId }
  );
  const backendNodeId = described.node?.backendNodeId;
  if (!backendNodeId) throw new Error(UNIDENTIFIED_RECEIVER);
  return backendNodeId;
}

/** A drop of approved files. The approved frame is re-identified now, and the
 *  browser hit-tests the drop point before the payload is announced and again
 *  right before the drop (`assertDropLandsOn`): anything but the approved
 *  target there and nothing is dropped. The in-page guards (every frame
 *  refuses, the approved frame admits only the ref) stay as defence in depth
 *  for what changes after that last check; being page-world listeners, they
 *  are not the boundary. */
async function dropApprovedFilesOnRef(
  host: RefUploadHost,
  guest: WebContents,
  ref: string,
  paths: string[],
  approvedReceiver: string,
  signal?: AbortSignal
): Promise<void> {
  const point = await host.resolveRefPoint(guest, ref, signal);
  const frames = await host.evaluateInFramesByFrame<boolean>(guest, BROWSER_BOUND_DROP_GUARD_INSTALL, signal);
  let outcomes: Array<{ accepted: boolean; strayed: boolean }> = [];
  try {
    const object = await resolveRefObject(host, guest, ref, signal);
    let dropTarget: DropTarget;
    try {
      const receiver = await frameOfObject(host, guest, object, signal);
      if (receiver.key !== approvedReceiver) throw new Error(UPLOAD_TARGET_CHANGED);
      const context = frames.find(([frameId]) => frameId === receiver.frameId)?.[2];
      if (context === undefined) throw new Error(UNIDENTIFIED_RECEIVER);
      dropTarget = {
        sessionId: object.sessionId,
        frameId: receiver.frameId,
        loaderId: receiver.loaderId,
        backendNodeId: await backendNodeOf(host, guest, ref, object, signal),
        executionContextId: context,
      };
      const target = await host.cdp.call<{ object?: { objectId?: string } }>(
        guest,
        'DOM.resolveNode',
        { backendNodeId: dropTarget.backendNodeId, executionContextId: context },
        signal,
        { sessionId: object.sessionId }
      );
      const aimed = target.object?.objectId
        ? await host.cdp.call<{ result?: { value?: boolean } }>(
            guest,
            'Runtime.callFunctionOn',
            { objectId: target.object.objectId, functionDeclaration: BROWSER_DROP_GUARD_AIM, returnByValue: true },
            signal,
            { sessionId: object.sessionId }
          )
        : null;
      if (target.object?.objectId)
        releaseObject(host, guest, { objectId: target.object.objectId, sessionId: object.sessionId });
      if (aimed?.result?.value !== true) throw new Error(UNIDENTIFIED_RECEIVER);
    } finally {
      releaseObject(host, guest, object);
    }
    await host.input.dropFilesAt(guest, point, paths, signal, () =>
      assertDropLandsOn(host, guest, point, dropTarget, signal)
    );
  } finally {
    outcomes = (
      await host
        .evaluateInFramesByFrame<{ accepted: boolean; strayed: boolean }>(guest, BROWSER_BOUND_DROP_GUARD_TAKE, signal)
        .catch(() => [] as Array<[string, { accepted: boolean; strayed: boolean }, number]>)
    ).map(([, value]) => value);
  }
  if (outcomes.some((outcome) => outcome.strayed)) {
    throw new Error('the drop landed outside the approved upload target; it was blocked and no files were delivered');
  }
  if (!outcomes.some((outcome) => outcome.accepted)) {
    throw new Error(
      `ref ${ref} is not a file input, clicking it opened no file chooser within ${FILE_CHOOSER_WAIT_MS}ms, ` +
        "and it did not accept a file drop; upload through the page's own file input"
    );
  }
}

/** The element behind the file chooser the page opened. */
async function chooserObject(
  host: RefUploadHost,
  guest: WebContents,
  chooser: PendingFileChooser,
  signal?: AbortSignal
): Promise<RefObject> {
  if (!chooser.backendNodeId) throw new Error(UPLOAD_TARGET_CHANGED);
  const resolved = await host.cdp.call<{ object?: { objectId?: string } }>(
    guest,
    'DOM.resolveNode',
    { backendNodeId: chooser.backendNodeId },
    signal,
    { sessionId: chooser.sessionId }
  );
  if (!resolved.object?.objectId) throw new Error(UPLOAD_TARGET_CHANGED);
  return { objectId: resolved.object.objectId, sessionId: chooser.sessionId };
}

async function receiverOfChooser(
  host: RefUploadHost,
  guest: WebContents,
  chooser: PendingFileChooser,
  signal?: AbortSignal
): Promise<UploadReceiver> {
  const object = await chooserObject(host, guest, chooser, signal);
  try {
    return await receiverOfObject(host, guest, object, signal);
  } finally {
    releaseObject(host, guest, object);
  }
}

async function assertUploadPaths(paths: string[]): Promise<void> {
  if (!paths.length || paths.length > MAX_UPLOAD_FILES) throw new Error('upload requires 1–10 file paths');
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`upload path must be absolute: ${path}`);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`upload path is not a file: ${path}`);
  }
}

/** The live DOM object behind a ref: through the accessibility snapshot
 *  when the page still has one, otherwise through the page-side ref table. */
async function resolveRefObject(
  host: RefUploadHost,
  guest: WebContents,
  ref: string,
  signal?: AbortSignal
): Promise<RefObject> {
  const accessibilitySnapshot = host.accessibilityRefs(guest);
  if (accessibilitySnapshot) {
    const target = accessibilitySnapshot.refs.get(ref);
    if (!target) throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
    const resolved = await host.cdp.call<{ object?: { objectId?: string } }>(
      guest,
      'DOM.resolveNode',
      { backendNodeId: target.backendNodeId },
      signal,
      { sessionId: target.sessionId }
    );
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error(`ref ${ref} is stale or detached; take a fresh snapshot first`);
    return { objectId, sessionId: target.sessionId };
  }
  const response = await host.cdp.call<{
    result?: { objectId?: string };
    exceptionDetails?: unknown;
  }>(
    guest,
    'Runtime.evaluate',
    {
      expression: `(() => {
        ${browserRefElementSource(ref)}
        return element;
      })()`,
      returnByValue: false,
      userGesture: true,
    },
    signal
  );
  const objectId = response.result?.objectId;
  if (!objectId || response.exceptionDetails) {
    throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
  }
  return { objectId };
}

async function isFileInput(
  host: RefUploadHost,
  guest: WebContents,
  object: RefObject,
  signal?: AbortSignal
): Promise<boolean> {
  const validation = await host.cdp.call<{
    result?: { value?: { valid?: boolean } };
    exceptionDetails?: unknown;
  }>(
    guest,
    'Runtime.callFunctionOn',
    {
      objectId: object.objectId,
      functionDeclaration: `function() {
          return {
            valid: (this.tagName || '').toLowerCase() === 'input'
              && String(this.type || '').toLowerCase() === 'file',
          };
        }`,
      returnByValue: true,
    },
    signal,
    { sessionId: object.sessionId }
  );
  return !validation.exceptionDetails && validation.result?.value?.valid === true;
}

/** Hand the approved files to the picker the page opened. */
async function answerFileChooser(
  host: RefUploadHost,
  guest: WebContents,
  chooser: PendingFileChooser,
  paths: string[],
  signal?: AbortSignal,
  beforeDispatch?: () => void,
  verifyReceiver?: () => Promise<void>
): Promise<void> {
  if (!chooser.backendNodeId) {
    host.clearFileChooser(guest);
    throw new Error('the open file chooser has no target element; take a fresh snapshot and upload by ref');
  }
  if (chooser.mode === 'selectSingle' && paths.length > 1) {
    throw new Error('the open file chooser accepts a single file');
  }
  await verifyReceiver?.();
  await host.cdp.call(guest, 'DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId }, signal, {
    sessionId: chooser.sessionId,
    beforeDispatch: () => {
      beforeDispatch?.();
      if (host.pendingFileChooser(guest) !== chooser)
        throw new Error('Browser file chooser changed; files were not sent.');
      // Claim before dispatch so a concurrent answer cannot send twice.
      host.clearFileChooser(guest);
    },
  });
  if (host.pendingFileChooser(guest) === chooser) host.clearFileChooser(guest);
}

/** Click an element that is not itself a file input and wait for the
 *  picker it opens — the common pattern of a styled button over a hidden
 *  input. */
async function openFileChooserVia(
  host: RefUploadHost,
  guest: WebContents,
  ref: string,
  signal?: AbortSignal
): Promise<PendingFileChooser | null> {
  host.clearFileChooser(guest);
  const point = await host.resolveRefPoint(guest, ref, signal);
  await host.input.clickAt(guest, point.x, point.y, 1, 'left', 0, signal);
  const deadline = Date.now() + FILE_CHOOSER_WAIT_MS;
  for (;;) {
    const chooser = host.pendingFileChooser(guest);
    if (chooser) return chooser;
    if (Date.now() >= deadline) return null;
    await host.pause(FILE_CHOOSER_POLL_MS, signal);
  }
}

/** The upload zones that never show a picker take their files as a drop.
 *  The guard neutralises a drop the page does not take, so a refusal costs
 *  the caller a clear error instead of a navigation to the file. */
async function dropFilesOnRef(
  host: RefUploadHost,
  guest: WebContents,
  ref: string,
  paths: string[],
  signal?: AbortSignal
): Promise<void> {
  const point = await host.resolveRefPoint(guest, ref, signal);
  await host.evaluateInFrames<boolean>(guest, BROWSER_DROP_GUARD_INSTALL, signal);
  let accepted = false;
  try {
    await host.input.dropFilesAt(guest, point, paths, signal);
  } finally {
    const answers = await host
      .evaluateInFrames<boolean>(guest, BROWSER_DROP_GUARD_TAKE, signal)
      .catch(() => [] as boolean[]);
    accepted = answers.some(Boolean);
  }
  if (!accepted) {
    throw new Error(
      `ref ${ref} is not a file input, clicking it opened no file chooser within ${FILE_CHOOSER_WAIT_MS}ms, ` +
        "and it did not accept a file drop; upload through the page's own file input"
    );
  }
}

/** Files set straight on a file input; false when the ref is not one. */
async function setFilesDirectly(
  host: RefUploadHost,
  guest: WebContents,
  ref: string,
  paths: string[],
  signal?: AbortSignal,
  approvedReceiver?: string
) {
  const object = await resolveRefObject(host, guest, ref, signal);
  try {
    const direct = await isFileInput(host, guest, object, signal);
    if (direct) {
      if (approvedReceiver && (await receiverOfObject(host, guest, object, signal)).key !== approvedReceiver) {
        throw new Error(UPLOAD_TARGET_CHANGED);
      }
      await host.cdp.call(guest, 'DOM.setFileInputFiles', { files: paths, objectId: object.objectId }, signal, {
        sessionId: object.sessionId,
      });
    }
    return direct;
  } finally {
    releaseObject(host, guest, object);
  }
}

export function createRefUpload(host: RefUploadHost) {
  /** The frame document that would receive an upload to `ref` (or to the
   *  chooser the page already opened, without a ref). */
  async function receiver(guest: WebContents, ref: string | undefined, signal?: AbortSignal): Promise<UploadReceiver> {
    if (!ref) {
      const chooser = host.pendingFileChooser(guest);
      if (!chooser) throw new Error('upload requires ref unless the page has opened a file chooser');
      return receiverOfChooser(host, guest, chooser, signal);
    }
    const object = await resolveRefObject(host, guest, ref, signal);
    try {
      return await receiverOfObject(host, guest, object, signal);
    } finally {
      releaseObject(host, guest, object);
    }
  }

  /** Refuse unless the files would still land in the frame that was approved. */
  async function assertReceiver(approved: string | undefined, current: () => Promise<UploadReceiver>): Promise<void> {
    if (approved && (await current()).key !== approved) throw new Error(UPLOAD_TARGET_CHANGED);
  }

  /** `approvedReceiver` is the frame the person approved (see `receiver`): it is
   *  checked again immediately before each way of handing the files over. */
  async function uploadRef(
    guest: WebContents,
    ref: string | undefined,
    paths: string[],
    signal?: AbortSignal,
    beforeDispatch?: () => void,
    approvedReceiver?: string
  ): Promise<void> {
    await assertUploadPaths(paths);
    const chooserReceiver = (chooser: PendingFileChooser) => () =>
      assertReceiver(approvedReceiver, () => receiverOfChooser(host, guest, chooser, signal));
    if (!ref) {
      const chooser = host.pendingFileChooser(guest);
      if (!chooser) throw new Error('upload requires ref unless the page has opened a file chooser');
      await answerFileChooser(host, guest, chooser, paths, signal, beforeDispatch, chooserReceiver(chooser));
      return;
    }
    if (await setFilesDirectly(host, guest, ref, paths, signal, approvedReceiver)) return;
    await assertReceiver(approvedReceiver, () => receiver(guest, ref, signal));
    const chooser = await openFileChooserVia(host, guest, ref, signal);
    if (!chooser) {
      if (approvedReceiver) await dropApprovedFilesOnRef(host, guest, ref, paths, approvedReceiver, signal);
      else await dropFilesOnRef(host, guest, ref, paths, signal);
      return;
    }
    await answerFileChooser(host, guest, chooser, paths, signal, undefined, chooserReceiver(chooser));
  }

  return { uploadRef, receiver };
}
