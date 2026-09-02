/**
 * Everything the host remembers about one guest page, in one place. Refs,
 * visual grounding, dialogs, console and network ledgers, crash state and the
 * remote-frame cache used to live in a dozen separate WeakMaps; a single
 * record per WebContents keeps their lifetimes aligned and makes "forget what
 * this page looked like" a one-line operation.
 */
import type { WebContents } from 'electron';

import { BrowserConsoleLedger } from './console';
import type { PendingBrowserDialog } from './dialog-report';
import { redactBrowserKnownSecrets, redactBrowserText } from './host-policy';
import { BrowserNetworkLedger } from './network';
import type { ActiveBrowserPerformanceTrace } from './performance';
import type { VisualGrounding } from './ref-points';
import type { BrowserRefSet } from './ref-recovery';
import type { AccessibilityRefSnapshot } from './snapshot-capture';

export interface CdpTargetSession {
  type: string;
  url: string;
  frameId: string;
  parentSessionId?: string;
  ready: Promise<void>;
}

export interface RemoteBrowserFrameCache {
  frameId: string;
  image: { mimeType: 'image/jpeg' | 'image/png'; data: string };
  width: number;
  height: number;
  url: string;
}

/** A native file picker the page asked for. Chromium hands it to the host
 *  instead of showing it, and `upload` answers it with the approved paths. */
export interface PendingFileChooser {
  mode: string;
  backendNodeId?: number;
  frameId?: string;
  sessionId?: string;
  openedAt: number;
}

/** The page-health view every report reads: what blocks it, what it logged,
 *  and which CDP child sessions currently belong to it. */
export interface BrowserDiagnostics {
  pendingDialog: PendingBrowserDialog | null;
  pendingFileChooser: PendingFileChooser | null;
  console: BrowserConsoleLedger;
  networkFailures: string[];
  network: BrowserNetworkLedger;
  cdpSessions: Map<string, CdpTargetSession>;
  fault: string;
}

export interface BrowserGuestState extends BrowserDiagnostics {
  readonly pageId: string;
  snapshotGeneration: number;
  /** When a snapshot last told the caller about this page's downloads. */
  downloadsReportedAt: number;
  /** Renderer death leaves a live WebContents whose document is gone: CDP
   *  calls and every ref bound to that document fail until the page reloads. */
  crashed: boolean;
  accessibilityRefs?: AccessibilityRefSnapshot;
  refSet?: BrowserRefSet;
  visualGrounding?: VisualGrounding;
  performanceTrace?: ActiveBrowserPerformanceTrace;
  /** Secrets typed into this document; redacted from every reply. */
  sensitiveValues?: Set<string>;
  remoteFrame?: RemoteBrowserFrameCache;
}

/** A WeakMap-shaped window onto one field of every guest's state, so modules
 *  that only care about (say) the ref table keep a narrow dependency. */
export interface GuestSlot<T> {
  get(guest: WebContents): T | undefined;
  set(guest: WebContents, value: T): unknown;
  has(guest: WebContents): boolean;
  delete(guest: WebContents): boolean;
}

type OptionalKeys = {
  [K in keyof BrowserGuestState]-?: undefined extends BrowserGuestState[K] ? K : never;
}[keyof BrowserGuestState];

export class BrowserGuestStateStore {
  private readonly states = new WeakMap<WebContents, BrowserGuestState>();
  private nextPageId = 0;

  /** The record for a guest, created on first touch. */
  for(guest: WebContents): BrowserGuestState {
    const existing = this.states.get(guest);
    if (existing) return existing;
    const created: BrowserGuestState = {
      pageId: `p${++this.nextPageId}`,
      snapshotGeneration: 0,
      downloadsReportedAt: 0,
      crashed: false,
      pendingDialog: null,
      pendingFileChooser: null,
      console: new BrowserConsoleLedger((value) => this.redactText(guest, value)),
      networkFailures: [],
      network: new BrowserNetworkLedger(),
      cdpSessions: new Map(),
      fault: '',
    };
    this.states.set(guest, created);
    return created;
  }

  peek(guest: WebContents): BrowserGuestState | undefined {
    return this.states.get(guest);
  }

  pageId(guest: WebContents): string {
    return this.for(guest).pageId;
  }

  nextSnapshotId(guest: WebContents): string {
    const state = this.for(guest);
    state.snapshotGeneration += 1;
    return `${state.pageId}-s${state.snapshotGeneration}`;
  }

  /** Forget everything bound to the current document: refs, image grounding
   *  and the remote frame. Called whenever the page may have changed. */
  invalidateInteraction(guest: WebContents): void {
    const state = this.states.get(guest);
    if (!state) return;
    state.accessibilityRefs = undefined;
    state.refSet = undefined;
    state.visualGrounding = undefined;
    state.remoteFrame = undefined;
  }

  markCrashed(guest: WebContents, fault: string): void {
    const state = this.for(guest);
    state.fault = fault;
    state.crashed = true;
    this.invalidateInteraction(guest);
  }

  /** Report and clear the crash flag in one step. */
  takeCrashed(guest: WebContents): boolean {
    const state = this.states.get(guest);
    if (!state?.crashed) return false;
    state.crashed = false;
    return true;
  }

  rememberSecret(guest: WebContents, secret: string): Set<string> {
    const state = this.for(guest);
    state.sensitiveValues ??= new Set();
    state.sensitiveValues.add(secret);
    return state.sensitiveValues;
  }

  forgetSecret(guest: WebContents, secret: string): void {
    const state = this.states.get(guest);
    if (!state?.sensitiveValues) return;
    state.sensitiveValues.delete(secret);
    if (!state.sensitiveValues.size) state.sensitiveValues = undefined;
  }

  forgetSecrets(guest: WebContents): void {
    const state = this.states.get(guest);
    if (state) state.sensitiveValues = undefined;
  }

  /** A new document is loading: typed secrets and a picker the old document
   *  asked for no longer apply. */
  beginDocument(guest: WebContents): void {
    const state = this.states.get(guest);
    if (!state) return;
    state.sensitiveValues = undefined;
    state.pendingFileChooser = null;
  }

  /** Text bound for the caller, minus the page's known secrets. */
  redactText(guest: WebContents, value: unknown): string {
    return redactBrowserKnownSecrets(
      redactBrowserText(value),
      this.states.get(guest)?.sensitiveValues || [],
    );
  }

  slot<K extends OptionalKeys>(key: K): GuestSlot<NonNullable<BrowserGuestState[K]>> {
    return {
      get: (guest) => this.states.get(guest)?.[key] as NonNullable<BrowserGuestState[K]> | undefined,
      set: (guest, value) => {
        this.for(guest)[key] = value;
      },
      has: (guest) => this.states.get(guest)?.[key] !== undefined,
      delete: (guest) => {
        const state = this.states.get(guest);
        if (!state || state[key] === undefined) return false;
        state[key] = undefined;
        return true;
      },
    };
  }
}

/** Append to a capped diagnostic list, redacting and trimming the entry. */
export function pushBounded(target: string[], value: string, max = 30): void {
  target.push(redactBrowserText(String(value).slice(0, 4_000)));
  if (target.length > max) target.splice(0, target.length - max);
}
