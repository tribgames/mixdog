import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import type { PendingFileChooser } from './host-types';
import type { createBrowserInputDriver } from './input';
import { type BrowserRefAccessHost, createBrowserRefAccess } from './ref-access';
import { createRefControlState } from './ref-control-state';
import { createBrowserRefSelection } from './ref-select';
import { createRefTextEntry } from './ref-text-entry';
import { createRefUpload } from './ref-upload';

/** callAccessibilityRef runs a function against the ref through the accessibility snapshot; evaluate is the
 *  page-side fallback for a ref the snapshot lost. */
export interface BrowserRefActionsHost extends BrowserRefAccessHost {
  /** The same expression in every attached frame. A drop zone can live in
   *  one, and its drop never reaches the top document's listeners. */
  evaluateInFrames<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T[]>;
  /** The same, with the frame id and execution context each value came from. */
  evaluateInFramesByFrame<T>(
    guest: WebContents,
    expression: string,
    signal?: AbortSignal
  ): Promise<Array<[frameId: string, value: T, executionContextId: number]>>;
  cdp: BrowserCdpPort;
  /** The accessibility snapshot's ref table, when this page still has one. */
  accessibilityRefs(guest: WebContents):
    | {
        refs: Map<string, { backendNodeId: number; sessionId?: string }>;
      }
    | undefined;
  /** The cross-origin frame sessions the page has attached, and where a
   *  session's frame sits on the top document; a browser-side hit test
   *  descends through them. Without them it stops at the top document. */
  frames?(guest: WebContents): Map<string, { frameId?: string }>;
  frameOffsetForSession?(
    guest: WebContents,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<{ x: number; y: number }>;
  /** Where the ref sits right now, refused when something covers it. */
  resolveRefPoint(guest: WebContents, ref: string, signal?: AbortSignal): Promise<{ x: number; y: number }>;
  input: Pick<ReturnType<typeof createBrowserInputDriver>, 'pressKey' | 'clickAt' | 'typeText' | 'dropFilesAt'>;
  pause(ms: number, signal?: AbortSignal): Promise<void>;
  /** The picker the page opened and nobody has answered yet. */
  pendingFileChooser(guest: WebContents): PendingFileChooser | null;
  clearFileChooser(guest: WebContents): void;
  /** How long a custom dropdown may take to render its options. */
  dropdownTimeoutMs: number;
  dropdownPollMs: number;
  rememberSecret?(guest: WebContents, value: string): void;
}

export function createBrowserRefActions(host: BrowserRefActionsHost) {
  const { prepareRef, callRef } = createBrowserRefAccess(host);
  const { selectRef, selectCustomRef } = createBrowserRefSelection(host);
  const text = createRefTextEntry(host, callRef);
  const controls = createRefControlState(host, callRef);
  const upload = createRefUpload(host);

  return {
    prepareRef,
    fillRef: text.fillRef,
    typeRef: text.typeRef,
    listSelectOptions: controls.listSelectOptions,
    selectCustomRef,
    selectRef,
    checkedRefState: controls.checkedRefState,
    setCheckedRef: controls.setCheckedRef,
    uploadRef: upload.uploadRef,
    uploadReceiver: upload.receiver,
    /** Redact `value` in every later reply of the page's session. */
    rememberSecret: (guest: WebContents, value: string) => host.rememberSecret?.(guest, value),
  };
}
