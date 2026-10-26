/** Agent-only visual output checks. User presentation and historical frames
 * stay untouched; an unsafe new capture is discarded before publication. */
import type { WebContents } from 'electron';
import { BROWSER_DOCUMENT_ROOTS, browserDocumentChanged, type createBrowserDocuments } from './documents';
import type { BrowserCdpPort } from './cdp';
import type { BrowserGuestStateStore } from './guest-state';

/** The backend nodes of the elements the host filled a secret into (a password,
 *  every box of a one-time code), per guest: bounded, in memory only. A
 *  capture is refused while one of them holds a value, so a code split over
 *  one box per digit — no single input holds all of it — is protected by the
 *  elements themselves, not by matching values. */
const protectedNodes = new WeakMap<WebContents, Set<number>>();
const MAX_PROTECTED_NODES = 64;

export function protectSecretNodes(guest: WebContents, nodes: readonly number[]): void {
  const set = protectedNodes.get(guest) ?? new Set<number>();
  for (const node of nodes) {
    set.delete(node);
    set.add(node);
  }
  while (set.size > MAX_PROTECTED_NODES) set.delete(set.values().next().value as number);
  protectedNodes.set(guest, set);
}

/** CDP's answer when a backend node no longer exists (DOM.resolveNode). */
const NODE_GONE =
  /No node with given id found|Could not find node with given id|Node with given id does not belong to the document/i;
const HOLDS_VALUE =
  'function() { return this instanceof HTMLInputElement && this.isConnected && String(this.value || "") !== ""; }';

export type BrowserVisualPrivacy = (guest: WebContents, signal?: AbortSignal) => Promise<() => Promise<void>>;

const VISIBLE_PLAIN_VALUES = `(() => {
  const values = [];
  for (const root of (${BROWSER_DOCUMENT_ROOTS})()) {
    for (const field of root.querySelectorAll('input,textarea')) {
      if (field.type === 'password' || !field.getClientRects().length) continue;
      const style = getComputedStyle(field);
      if (style.visibility === 'hidden' || style.visibility === 'collapse') continue;
      values.push(String(field.value || ''));
    }
  }
  return values;
})()`;

/** Whether a password field holds focus in any document (secret input). */
const PASSWORD_FIELD_FOCUSED = `(() => {
  for (const root of (${BROWSER_DOCUMENT_ROOTS})()) {
    const active = root.activeElement;
    if (active && active.tagName === 'INPUT' && String(active.type).toLowerCase() === 'password') return true;
  }
  return false;
})()`;

export function createBrowserVisualPrivacy(host: {
  state: Pick<BrowserGuestStateStore, 'peek'>;
  documents: Pick<ReturnType<typeof createBrowserDocuments>, 'pageText' | 'collect' | 'revision'>;
  /** Resolves the protected nodes (absent: none are checked). */
  cdp?: Pick<BrowserCdpPort, 'call'>;
}): BrowserVisualPrivacy {
  const secretsFor = (guest: WebContents) => [...(host.state.peek(guest)?.sensitiveValues || [])].filter(Boolean);
  const withheld = () =>
    new Error(
      'Visual output withheld to protect a registered credential. Use a semantic snapshot or read; no image or PDF was returned.'
    );
  return async (guest, signal) => {
    const secrets = secretsFor(guest);
    const unchangedSecrets = () => {
      const current = secretsFor(guest);
      return current.length === secrets.length && current.every((value) => secrets.includes(value));
    };
    /** Whether an element the host filled a secret into still holds a value. */
    const checkProtected = async () => {
      const nodes = [...(protectedNodes.get(guest) || [])];
      if (!host.cdp || !nodes.length) return;
      const objectGroup = 'mixdog-visual-privacy';
      try {
        for (const backendNodeId of nodes) {
          let objectId = '';
          try {
            const resolved = await host.cdp.call<{ object?: { objectId?: string } }>(
              guest,
              'DOM.resolveNode',
              { backendNodeId, objectGroup },
              signal
            );
            objectId = String(resolved.object?.objectId || '');
          } catch (error) {
            // Only CDP's own answer that the node no longer exists lets a
            // node go; a cancelled capture stops, and any other failure
            // withholds the capture (the node may still hold the secret).
            if (signal?.aborted) throw error;
            if (!NODE_GONE.test(String((error as Error)?.message || error))) throw withheld();
            continue;
          }
          if (!objectId) throw withheld();
          let answer: { result?: { value?: unknown }; exceptionDetails?: unknown };
          try {
            answer = await host.cdp.call(
              guest,
              'Runtime.callFunctionOn',
              { objectId, functionDeclaration: HOLDS_VALUE, returnByValue: true },
              signal
            );
          } catch (error) {
            if (signal?.aborted) throw error;
            throw withheld();
          }
          // Only a plain "no value" (or a node that is no longer connected,
          // which the function answers the same way) clears the node.
          if (answer.exceptionDetails || answer.result?.value !== false) throw withheld();
        }
      } finally {
        void host.cdp.call(guest, 'Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
      }
    };
    // A focused password field (registered or not) may show what is typed: no agent capture.
    const checkFocus = async () => {
      await checkProtected();
      const focused = await host.documents.collect<boolean>(guest, PASSWORD_FIELD_FOCUSED, signal);
      if ((Array.isArray(focused) ? focused : [focused]).flat().some((value) => value === true)) throw withheld();
    };
    if (!secrets.length) {
      await checkFocus();
      return async () => {
        if (!unchangedSecrets()) throw withheld();
        await checkFocus();
      };
    }
    const checkText = async () => {
      await checkFocus();
      const text = await host.documents.pageText(guest, signal);
      const values = (await host.documents.collect<string[]>(guest, VISIBLE_PLAIN_VALUES, signal)).flat();
      if (secrets.some((secret) => text.includes(secret) || values.some((value) => value.includes(secret)))) {
        throw withheld();
      }
    };
    const before = await host.documents.revision(guest, signal);
    await checkText();
    return async () => {
      if (!unchangedSecrets()) throw withheld();
      await checkText();
      const after = await host.documents.revision(guest, signal);
      if (browserDocumentChanged(before, after, { includeScroll: true }) !== false) throw withheld();
    };
  };
}
