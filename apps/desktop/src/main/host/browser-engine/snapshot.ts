/**
 * `host/browser/snapshot`: one observation of the page, as the payload only
 * (the accessibility tree is never sent). The capture itself is the desktop's
 * existing one (`createBrowserSnapshotCapture`: the accessibility trees of the
 * page and its cross-origin frames merged, the DOM fallback when CDP has none),
 * so the payload is the same the in-process path produced; this handler turns
 * the engine params into that capture's command and the result into the
 * method's shape. The refs the capture mints stay in the page's guest state,
 * which is what `host/browser/ref/call` and a screenshot clip resolve them by.
 * Known secrets in names and values are masked by the registry on the way out.
 */
import type { WebContents } from 'electron';

import type {
  BrowserSnapshotMode,
  BrowserSnapshotPayload,
  FrameRef,
  HostBrowserSnapshotResult,
} from '../../../../../../packages/protocol/src/index.ts';
import type { BrowserCommand } from '../../browser/command';
import { parseBrowserQuery } from '../../browser/semantic-query';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import type { EngineContext } from './context';
import { documentIdOf } from './precondition';
import { registerEngineMethod } from './registry';

export const HOST_BROWSER_SNAPSHOT = 'host/browser/snapshot';

/** What the snapshot handler needs of the desktop's snapshot capture. */
export interface SnapshotHost {
  /** `createBrowserSnapshotCapture(...).captureSnapshotPayload`, bound to the live guest registry. */
  captureSnapshotPayload(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal
  ): Promise<BrowserSnapshotPayload>;
}

const MODES: ReadonlySet<string> = new Set<BrowserSnapshotMode>(['full', 'interactive', 'query', 'viewport']);
const UINT32 = 2 ** 32;

function invalid(message: string): HostRpcError {
  return new HostRpcError(HOST_INVALID_PARAMS, message);
}

function optionalCount(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw invalid(`snapshot ${name} must be a positive number.`);
  }
  return value;
}

/**
 * The document revision the capture stamped on the ref set, as the u32 the
 * result carries: the sum of every frame's DOM-change counter (the seventh
 * field of the observation revision, documents.ts BROWSER_OBSERVATION_REVISION),
 * so it moves when a document or a control's value changes and not on a
 * pointer press, a key or a scroll. 0 when the page could not be asked.
 */
export function revisionNumber(revision: string | undefined): number {
  if (!revision) return 0;
  let total = 0;
  for (const frame of revision.split('|')) {
    const dom = Number(frame.split(':')[6]);
    if (Number.isFinite(dom)) total += dom;
  }
  return total % UINT32;
}

function parseFrame(value: unknown): FrameRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('snapshot frame must be an object.');
  const { sessionId, frameId } = value as FrameRef;
  if (sessionId !== undefined && typeof sessionId !== 'string') {
    throw invalid('snapshot frame.sessionId must be a string.');
  }
  if (frameId !== undefined && typeof frameId !== 'string') throw invalid('snapshot frame.frameId must be a string.');
  return sessionId || frameId ? { sessionId, frameId } : undefined;
}

export function registerSnapshot(connection: HostConnection, ctx: EngineContext, host: SnapshotHost): void {
  registerEngineMethod(connection, ctx, HOST_BROWSER_SNAPSHOT, async (params, signal, page) => {
    const { mode, query } = params;
    if (typeof mode !== 'string' || !MODES.has(mode)) {
      throw invalid('snapshot mode must be full, interactive, query or viewport.');
    }
    if (query !== undefined && query !== null && typeof query !== 'string') {
      throw invalid('snapshot query must be a string.');
    }
    try {
      parseBrowserQuery(query);
    } catch (error) {
      throw invalid((error as Error).message);
    }
    const maxElements = optionalCount(params.maxElements, 'maxElements');
    const textChars = optionalCount(params.textChars, 'textChars');
    const frame = parseFrame(params.frame);
    const command: BrowserCommand = {
      action: 'snapshot',
      ...(typeof query === 'string' && query.trim() ? { query } : {}),
      ...(mode === 'viewport' ? { viewportOnly: true } : {}),
      ...(maxElements !== undefined ? { maxElements } : {}),
      ...(textChars !== undefined ? { maxChars: textChars } : {}),
    };
    const payload = { ...(await host.captureSnapshotPayload(page.guest, command, signal)) };
    const warnings = [...(payload.warnings ?? [])];
    if (frame?.sessionId) {
      // Refs bind a node to the CDP target session that produced it, so a
      // cross-origin frame is cut out by its session.
      const refs = page.state.accessibilityRefs?.refs;
      payload.elements = payload.elements.filter((element) => refs?.get(element.ref)?.sessionId === frame.sessionId);
      payload.totalElements = payload.elements.length;
      warnings.push(`This snapshot lists only the elements of frame session ${frame.sessionId}.`);
    } else if (frame?.frameId) {
      warnings.push('A frame named by frameId alone cannot narrow a snapshot; the whole page is listed.');
    }
    if (warnings.length) payload.warnings = warnings;
    const result: Omit<HostBrowserSnapshotResult, 'facts'> = {
      snapshotId: payload.snapshotId,
      documentId: documentIdOf(page.state),
      revision: revisionNumber(page.state.refSet?.revision),
      // The whole observation revision, for the core's "no observable change" judgement (documents.ts browserDocumentChanged).
      ...(page.state.refSet?.revision ? { observation: page.state.refSet.revision } : {}),
      payload,
      warnings,
    };
    return result;
  });
}
