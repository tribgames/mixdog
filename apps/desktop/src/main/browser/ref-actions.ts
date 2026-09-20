/**
 * Every gesture that addresses one element by ref: filling and typing, both
 * kinds of dropdown, checkbox state, and file upload. Each one runs the same
 * two-step contract — reach the element through the accessibility snapshot,
 * fall back to the page-side ref table, and report what the element actually
 * holds afterwards. The host keeps the tab graph; this keeps the gestures.
 */
import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import type { PendingFileChooser } from './guest-state';
import type { createBrowserInputDriver } from './input';
import { createBrowserRefAccess } from './ref-access';
import { createRefControlState } from './ref-control-state';
import { createBrowserRefSelection } from './ref-select';
import { createRefTextEntry } from './ref-text-entry';
import { createRefUpload } from './ref-upload';

export interface BrowserRefActionsHost {
  /** Run a function against the ref through the accessibility snapshot. */
  callAccessibilityRef<T>(
    guest: WebContents,
    ref: string,
    functionDeclaration: string,
    args: unknown[],
    signal?: AbortSignal
  ): Promise<{ handled: false } | { handled: true; value: T }>;
  /** The page-side fallback for a ref the accessibility snapshot lost. */
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T>;
  /** The same expression in every attached frame. A drop zone can live in
   *  one, and its drop never reaches the top document's listeners. */
  evaluateInFrames<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T[]>;
  cdp: BrowserCdpPort;
  /** The accessibility snapshot's ref table, when this page still has one. */
  accessibilityRefs(guest: WebContents):
    | {
        refs: Map<string, { backendNodeId: number; sessionId?: string }>;
      }
    | undefined;
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
  };
}
