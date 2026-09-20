/**
 * Putting files on the page. A file-input ref takes them directly; any other
 * ref is clicked to open its picker, and a zone that never shows a picker
 * takes them as a drop; no ref answers a picker the page already opened.
 * Every route verifies the page accepted the files instead of assuming it.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { WebContents } from 'electron';

import { BROWSER_DROP_GUARD_INSTALL, BROWSER_DROP_GUARD_TAKE } from './file-drop';
import type { PendingFileChooser } from './guest-state';
import { browserRefElementSource } from './ref-access';
import type { BrowserRefActionsHost } from './ref-actions';

export type RefUploadHost = Pick<
  BrowserRefActionsHost,
  | 'cdp'
  | 'accessibilityRefs'
  | 'resolveRefPoint'
  | 'input'
  | 'pause'
  | 'pendingFileChooser'
  | 'clearFileChooser'
  | 'evaluateInFrames'
>;

/** How long a clicked button gets to open its picker. */
const FILE_CHOOSER_WAIT_MS = 3_000;
const FILE_CHOOSER_POLL_MS = 50;
const MAX_UPLOAD_FILES = 10;

interface RefObject {
  objectId: string;
  sessionId?: string;
}

async function assertUploadPaths(paths: string[]): Promise<void> {
  if (!paths.length || paths.length > MAX_UPLOAD_FILES) throw new Error('upload requires 1–10 file paths');
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`upload path must be absolute: ${path}`);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`upload path is not a file: ${path}`);
  }
}

export function createRefUpload(host: RefUploadHost) {
  const {
    accessibilityRefs,
    cdp,
    resolveRefPoint,
    input: browserInput,
    pause,
    pendingFileChooser,
    clearFileChooser,
  } = host;

  /** The live DOM object behind a ref: through the accessibility snapshot
   *  when the page still has one, otherwise through the page-side ref table. */
  async function resolveRefObject(guest: WebContents, ref: string, signal?: AbortSignal): Promise<RefObject> {
    const accessibilitySnapshot = accessibilityRefs(guest);
    if (accessibilitySnapshot) {
      const target = accessibilitySnapshot.refs.get(ref);
      if (!target) throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
      const resolved = await cdp.call<{ object?: { objectId?: string } }>(
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
    const response = await cdp.call<{
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

  async function isFileInput(guest: WebContents, object: RefObject, signal?: AbortSignal): Promise<boolean> {
    const validation = await cdp.call<{
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
    guest: WebContents,
    chooser: PendingFileChooser,
    paths: string[],
    signal?: AbortSignal,
    beforeDispatch?: () => void
  ): Promise<void> {
    if (!chooser.backendNodeId) {
      clearFileChooser(guest);
      throw new Error('the open file chooser has no target element; take a fresh snapshot and upload by ref');
    }
    if (chooser.mode === 'selectSingle' && paths.length > 1) {
      throw new Error('the open file chooser accepts a single file');
    }
    await cdp.call(guest, 'DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId }, signal, {
      sessionId: chooser.sessionId,
      beforeDispatch: () => {
        beforeDispatch?.();
        if (pendingFileChooser(guest) !== chooser)
          throw new Error('Browser file chooser changed; files were not sent.');
        // Claim before dispatch so a concurrent answer cannot send twice.
        clearFileChooser(guest);
      },
    });
    if (pendingFileChooser(guest) === chooser) clearFileChooser(guest);
  }

  /** Click an element that is not itself a file input and wait for the
   *  picker it opens — the common pattern of a styled button over a hidden
   *  input. */
  async function openFileChooserVia(
    guest: WebContents,
    ref: string,
    signal?: AbortSignal
  ): Promise<PendingFileChooser | null> {
    clearFileChooser(guest);
    const point = await resolveRefPoint(guest, ref, signal);
    await browserInput.clickAt(guest, point.x, point.y, 1, 'left', 0, signal);
    const deadline = Date.now() + FILE_CHOOSER_WAIT_MS;
    for (;;) {
      const chooser = pendingFileChooser(guest);
      if (chooser) return chooser;
      if (Date.now() >= deadline) return null;
      await pause(FILE_CHOOSER_POLL_MS, signal);
    }
  }

  /** The upload zones that never show a picker take their files as a drop.
   *  The guard neutralises a drop the page does not take, so a refusal costs
   *  the caller a clear error instead of a navigation to the file. */
  async function dropFilesOnRef(guest: WebContents, ref: string, paths: string[], signal?: AbortSignal): Promise<void> {
    const point = await resolveRefPoint(guest, ref, signal);
    await host.evaluateInFrames<boolean>(guest, BROWSER_DROP_GUARD_INSTALL, signal);
    let accepted = false;
    try {
      await browserInput.dropFilesAt(guest, point, paths, signal);
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
  async function setFilesDirectly(guest: WebContents, ref: string, paths: string[], signal?: AbortSignal) {
    const object = await resolveRefObject(guest, ref, signal);
    try {
      const direct = await isFileInput(guest, object, signal);
      if (direct) {
        await cdp.call(guest, 'DOM.setFileInputFiles', { files: paths, objectId: object.objectId }, signal, {
          sessionId: object.sessionId,
        });
      }
      return direct;
    } finally {
      void cdp
        .guestDebugger(guest)
        .then((debug) => debug.sendCommand('Runtime.releaseObject', { objectId: object.objectId }, object.sessionId))
        .catch(() => undefined);
    }
  }

  async function uploadRef(
    guest: WebContents,
    ref: string | undefined,
    paths: string[],
    signal?: AbortSignal,
    beforeDispatch?: () => void
  ): Promise<void> {
    await assertUploadPaths(paths);
    if (!ref) {
      const chooser = pendingFileChooser(guest);
      if (!chooser) throw new Error('upload requires ref unless the page has opened a file chooser');
      await answerFileChooser(guest, chooser, paths, signal, beforeDispatch);
      return;
    }
    if (await setFilesDirectly(guest, ref, paths, signal)) return;
    const chooser = await openFileChooserVia(guest, ref, signal);
    if (!chooser) {
      await dropFilesOnRef(guest, ref, paths, signal);
      return;
    }
    await answerFileChooser(guest, chooser, paths, signal);
  }

  return { uploadRef };
}
