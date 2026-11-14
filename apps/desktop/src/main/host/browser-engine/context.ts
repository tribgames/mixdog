/**
 * What an engine method handler reaches the desktop through. The wiring task
 * builds one `EngineContext` from the live guest registry, the guest CDP and
 * the event router; the scaffold (registry.ts, precondition.ts) and the
 * handlers see only this seam, so each is testable against a fake.
 */
import type { WebContents } from 'electron';

import type { PageFacts } from '../../../../../../packages/protocol/src/index.ts';
import type { BrowserCdpPort } from '../../browser/cdp';
import type { BrowserGuestStateStore } from '../../browser/guest-state';
import type { TranscriptTap } from './transcript';

/** The record the host keeps for one guest page (browser/guest-state.ts). */
export type GuestState = ReturnType<BrowserGuestStateStore['for']>;

/** The guest CDP surface a handler sends through. */
export type CdpFacade = BrowserCdpPort;

export interface EnginePage {
  guest: WebContents;
  state: GuestState;
}

/** One agent session's view of the pages it owns. */
export interface EngineSession {
  readonly sessionId: string;
  pageIds(): string[];
}

export interface EngineContext {
  /** The live page, or undefined when it is closed or its session ended. */
  page(pageId: string): EnginePage | undefined;
  session(sessionId: string): EngineSession | undefined;
  cdp: CdpFacade;
  events: {
    /** Sends every event the page has queued as `host/browser/events`, before the call returns. */
    flush(pageId: string): void;
    /** The page's facts now, with their `seq`. */
    facts(pageId: string): PageFacts;
  };
  /** Masks the secrets typed into the page, in `text`. */
  redactKnown(pageId: string, text: string): string;
  /** The core drives the browser through the engine lane (it claimed `browserEngine`). */
  isEngineMode(): boolean;
  /** Present only in a development or test build with MIXDOG_BROWSER_TRANSCRIPT set. */
  transcript?: TranscriptTap;
}
