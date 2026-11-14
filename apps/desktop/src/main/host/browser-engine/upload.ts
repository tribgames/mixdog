/**
 * `host/browser/upload`: the files an approved upload hands to the page. The
 * approval binds the receiving frame and the page state, so the host checks
 * both in the same synchronous step as each dispatch (the `DOM.setFileInputFiles`
 * that gives the files to the page, the click that opens its picker, the drop):
 * a refused check throws -32010 and nothing is sent. The routes themselves
 * (a file input, the picker a click opens, a drop, the picker the page already
 * opened) are `ref-upload.ts`'s; this adds the binding and the verification.
 *
 * `receiverKey` is what the approval bound. For the open chooser it is the key
 * the page facts carry (`pendingFileChooser.receiverKey`); for a ref it is the
 * frame document key `ref-upload.ts` `receiver()` reads. An empty key binds
 * nothing (the receiver could not be confirmed when the person was asked).
 */
import type { WebContents } from 'electron';

import type {
  BrowserUploadReceiver,
  Precondition,
} from '../../../../../../packages/protocol/src/index.ts';
import type { PendingFileChooser } from '../../browser/host-types';
import { createRefUpload } from '../../browser/ref-upload';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import type { EngineContext } from './context';
import { preconditionFailed } from './errors';
import { checkPrecondition, receiverKeyOf } from './precondition';
import { requireCurrentSnapshot } from './ref-call';
import { registerEngineMethod } from './registry';

type UploadHost = Parameters<typeof createRefUpload>[0];

const ROUTES = ['fileInput', 'chooser', 'drop', 'pickerClick'] as const;

export interface UploadDeps {
  /** The ref actions' host: ref table, point resolution, input driver, chooser slot, frames. */
  host: UploadHost;
  /** The files changed the page, so refs the agent holds are no longer safe. */
  invalidateInteractionState(guest: WebContents): void;
}

function invalid(message: string): HostRpcError {
  return new HostRpcError(HOST_INVALID_PARAMS, message);
}

interface ReceiverTarget {
  backendNodeId: number;
  sessionId?: string;
}

/** What the page shows of the element the files went to, and whether it holds them. */
async function readReceiver(
  host: UploadHost,
  guest: WebContents,
  target: ReceiverTarget | undefined,
  count: number,
  signal: AbortSignal
): Promise<{ receiver?: BrowserUploadReceiver; verified: boolean }> {
  if (!target) return { verified: false };
  const options = { sessionId: target.sessionId };
  try {
    const resolved = await host.cdp.call<{ object?: { objectId?: string } }>(
      guest,
      'DOM.resolveNode',
      { backendNodeId: target.backendNodeId },
      signal,
      options
    );
    const objectId = resolved.object?.objectId;
    if (!objectId) return { verified: false };
    try {
      const reply = await host.cdp.call<{
        result?: { value?: { tag: string; type: string; accept?: string; multiple?: boolean; files: number } };
        exceptionDetails?: unknown;
      }>(
        guest,
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function() {
            const tag = String(this.tagName || '').toLowerCase();
            return {
              tag,
              type: String(this.type || '').toLowerCase(),
              accept: this.accept ? String(this.accept) : undefined,
              multiple: this.multiple === true,
              files: this.files ? this.files.length : -1,
            };
          }`,
          returnByValue: true,
        },
        signal,
        options
      );
      const read = reply.result?.value;
      if (reply.exceptionDetails || !read) return { verified: false };
      const receiver: BrowserUploadReceiver = {
        tag: read.tag,
        ...(read.accept ? { accept: read.accept } : {}),
        multiple: read.multiple === true,
      };
      return { receiver, verified: read.tag === 'input' && read.type === 'file' && read.files === count };
    } finally {
      host.cdp.releaseObject(guest, objectId, target.sessionId);
    }
  } catch {
    signal.throwIfAborted();
    // The page could not be asked: the files were handed over, nothing confirms them.
    return { verified: false };
  }
}

/**
 * Whether the element the ref names is a file input. The route the approval named has to be the way the files are handed over:
 * `fileInput` is a file input itself, `pickerClick` and `drop` are an element that is not one (the files of a file input go
 * straight to it, which is not the gesture that was approved). A page that cannot be asked is not a verdict: the dispatch's
 * own checks stand.
 */
async function isFileInputRef(
  host: UploadHost,
  guest: WebContents,
  target: ReceiverTarget,
  signal: AbortSignal
): Promise<boolean | undefined> {
  const options = { sessionId: target.sessionId };
  try {
    const resolved = await host.cdp.call<{ object?: { objectId?: string } }>(
      guest,
      'DOM.resolveNode',
      { backendNodeId: target.backendNodeId },
      signal,
      options
    );
    const objectId = resolved.object?.objectId;
    if (!objectId) return undefined;
    try {
      const reply = await host.cdp.call<{ result?: { value?: { valid?: boolean } }; exceptionDetails?: unknown }>(
        guest,
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function() {
            return {
              valid: (this.tagName || '').toLowerCase() === 'input'
                && String(this.type || '').toLowerCase() === 'file',
            };
          }`,
          returnByValue: true,
        },
        signal,
        options
      );
      if (reply.exceptionDetails || typeof reply.result?.value?.valid !== 'boolean') return undefined;
      return reply.result.value.valid;
    } finally {
      host.cdp.releaseObject(guest, objectId, target.sessionId);
    }
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

/**
 * `host/browser/upload/receiver`: the frame document that would receive an upload now, as `ref-upload.ts` `receiver()` reads it
 * from the element itself: `key` (CDP session, frame id, loader id and URL) is what an approval binds and `upload` compares again
 * before it dispatches; `url` is what the approval card shows. Without a `ref` it names the picker the page already opened.
 */
function registerUploadReceiver(connection: HostConnection, ctx: EngineContext, deps: UploadDeps): void {
  registerEngineMethod(connection, ctx, 'host/browser/upload/receiver', async (params, signal, page) => {
    const ref = typeof params.ref === 'string' && params.ref ? params.ref : undefined;
    if (ref) {
      if (typeof params.snapshotId !== 'string' || !params.snapshotId) throw invalid('upload/receiver needs a snapshotId');
      requireCurrentSnapshot(page.state, params.snapshotId);
    }
    const expect = (params.expect ?? undefined) as Precondition | undefined;
    const { key, url } = await page.guarded(expect, () => createRefUpload(deps.host).receiver(page.guest, ref, signal));
    return { key, url };
  });
}

export function registerUpload(connection: HostConnection, ctx: EngineContext, deps: UploadDeps): void {
  registerUploadReceiver(connection, ctx, deps);
  registerEngineMethod(connection, ctx, 'host/browser/upload', async (params, signal, page) => {
    const route = ROUTES.find((candidate) => candidate === params.route);
    if (!route) throw invalid(`upload route must be ${ROUTES.join(', ')}`);
    if (!Array.isArray(params.files) || !params.files.length || params.files.some((file) => typeof file !== 'string')) {
      throw invalid('upload needs files');
    }
    const files = params.files as string[];
    if (typeof params.receiverKey !== 'string') throw invalid('upload needs a receiverKey');
    const receiverKey = params.receiverKey;
    if (params.expect === undefined || params.expect === null) throw invalid('upload needs an expect');
    const ref = typeof params.ref === 'string' && params.ref ? params.ref : undefined;
    if (route === 'chooser' && ref) throw invalid('the chooser route takes no ref');
    if (route !== 'chooser' && !ref) throw invalid(`the ${route} route needs a ref`);

    // The state the upload was decided against, as one check run before every dispatch.
    const decided = params.expect as Precondition;
    const bound: Precondition = {
      ...decided,
      ...(decided.snapshotId === undefined && typeof params.snapshotId === 'string'
        ? { snapshotId: params.snapshotId }
        : {}),
    };
    const chooser: PendingFileChooser | null = page.state.pendingFileChooser;
    const check = () => {
      checkPrecondition(bound, page, page.facts);
      if (route === 'chooser' && receiverKey && (!chooser || receiverKeyOf(chooser) !== receiverKey)) {
        throw preconditionFailed('receiver', page.facts());
      }
    };

    const { host } = deps;
    const guarded: UploadHost = {
      ...host,
      cdp: {
        ...host.cdp,
        call: ((guest, method, callParams, callSignal, options) =>
          host.cdp.call(
            guest,
            method,
            callParams,
            callSignal,
            method === 'DOM.setFileInputFiles'
              ? {
                  ...options,
                  beforeDispatch: () => {
                    check();
                    options?.beforeDispatch?.();
                  },
                }
              : options
          )) as UploadHost['cdp']['call'],
      },
      input: {
        ...host.input,
        clickAt: (...args) => {
          check();
          return host.input.clickAt(...args);
        },
        dropFilesAt: (...args) => {
          check();
          return host.input.dropFilesAt(...args);
        },
      },
    };

    const target: ReceiverTarget | undefined =
      route === 'chooser'
        ? chooser?.backendNodeId
          ? { backendNodeId: chooser.backendNodeId, sessionId: chooser.sessionId }
          : undefined
        : (() => {
            const known = host.accessibilityRefs(page.guest)?.refs.get(ref as string);
            return known ? { backendNodeId: known.backendNodeId, sessionId: known.sessionId } : undefined;
          })();

    // The route is the approved one: a ref of another kind is refused before anything is sent.
    check();
    if (route !== 'chooser' && target) {
      const fileInput = await isFileInputRef(host, page.guest, target, signal);
      if (fileInput !== undefined && fileInput !== (route === 'fileInput')) throw preconditionFailed('receiver', page.facts());
    }
    check();
    await createRefUpload(guarded).uploadRef(
      page.guest,
      ref,
      files,
      signal,
      undefined,
      route !== 'chooser' && receiverKey ? receiverKey : undefined
    );
    deps.invalidateInteractionState(page.guest);
    const { receiver, verified } = await readReceiver(host, page.guest, target, files.length, signal);
    return { dispatched: true, verified, ...(receiver ? { receiver } : {}) };
  });
}
