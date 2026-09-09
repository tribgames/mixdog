/**
 * Snapshot-free element targeting. A caller that already knows what it wants
 * ("the Save button", "the Email field") names it by role and accessible name
 * or by a CSS selector; the host takes the observation itself, insists on
 * exactly one match, and hands back a live ref. An ambiguous target fails
 * with the candidates and their fresh refs, so the next call can pick one
 * without another observation.
 */
import type { WebContents } from 'electron';

import type { BrowserSnapshotElement, BrowserSnapshotPayload } from './accessibility';
import type { BrowserCdpPort } from './cdp';
import type { BrowserCommand } from './command';
import type { BrowserGuestStateStore } from './guest-state';
import { redactBrowserText } from './redaction';
import { timedBrowserOperation } from './timing';

export interface BrowserTargetSpec {
  /** ARIA role as the snapshot prints it, e.g. button, link, textbox. */
  role?: string;
  /** Accessible name: label, placeholder, or visible text. Substring unless exact. */
  name?: string;
  /** CSS selector in the top document; matches need not be interactive. */
  selector?: string;
  exact?: boolean;
  /** 1-based pick among several matches, in snapshot order. */
  nth?: number;
}

export interface ResolvedBrowserTarget {
  ref: string;
  description: string;
}

const TARGET_FIELDS = new Set(['role', 'name', 'selector', 'exact', 'nth']);
const MAX_SELECTOR_MATCHES = 50;
const MAX_LISTED_CANDIDATES = 8;
const REGEX_SHAPED = /^\/.+\/[a-z]*$/s;

function compact(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeBrowserTarget(raw: unknown): BrowserTargetSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('target must be an object with role, name, and/or selector');
  }
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !TARGET_FIELDS.has(key));
  if (unknown.length) throw new Error(`target does not accept field(s): ${unknown.join(', ')}`);
  const text = (key: string, limit: number): string => {
    const value = input[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > limit) {
      throw new Error(`target.${key} must be a string of at most ${limit} characters`);
    }
    return compact(value);
  };
  const spec: BrowserTargetSpec = {};
  const role = text('role', 60).toLowerCase();
  if (role) spec.role = role;
  const name = text('name', 500);
  if (name) spec.name = name;
  const selector = text('selector', 4096);
  if (selector) spec.selector = selector;
  if (input.exact !== undefined) {
    if (typeof input.exact !== 'boolean') throw new Error('target.exact must be a boolean');
    spec.exact = input.exact;
  }
  if (input.nth !== undefined) {
    const nth = input.nth;
    if (!Number.isInteger(nth) || (nth as number) < 1 || (nth as number) > 500) {
      throw new Error('target.nth must be an integer from 1 to 500');
    }
    spec.nth = nth as number;
  }
  if (!spec.role && !spec.name && !spec.selector) {
    throw new Error('target requires role, name, and/or selector');
  }
  if (spec.exact && !spec.name) throw new Error('target.exact applies to target.name');
  return spec;
}

export function describeBrowserTarget(target: BrowserTargetSpec): string {
  const parts: string[] = [];
  if (target.role) parts.push(target.role);
  if (target.name) parts.push(JSON.stringify(redactBrowserText(target.name)) + (target.exact ? ' (exact)' : ''));
  if (target.selector) parts.push(`selector ${JSON.stringify(redactBrowserText(target.selector))}`);
  if (target.nth) parts.push(`#${target.nth}`);
  return parts.join(' ');
}

function candidateLine(element: BrowserSnapshotElement): string {
  const parts = [
    `[${element.ref}]${element.inViewport ? '*' : ''}`,
    redactBrowserText(element.role),
    JSON.stringify(redactBrowserText(element.name || '')),
  ];
  if (element.href) parts.push(`href=${redactBrowserText(element.href)}`);
  if (element.value) parts.push(`value=${JSON.stringify(redactBrowserText(element.value))}`);
  if (element.states?.length) parts.push(redactBrowserText(element.states.join(',')));
  return parts.join(' ');
}

function listCandidates(elements: BrowserSnapshotElement[]): string {
  const shown = elements.slice(0, MAX_LISTED_CANDIDATES).map(candidateLine);
  if (elements.length > shown.length) shown.push(`… and ${elements.length - shown.length} more`);
  return shown.join('\n');
}

/** The one element a target names among the candidates. Several matches are
 *  accepted only when exactly one carries the name verbatim or nth picks. */
export function selectBrowserTarget(
  target: BrowserTargetSpec,
  elements: BrowserSnapshotElement[],
  scope: { unfiltered?: number } = {},
): BrowserSnapshotElement {
  const wantedName = target.name ? target.name.toLowerCase() : '';
  const byRole = target.role
    ? elements.filter((element) => compact(element.role).toLowerCase() === target.role)
    : elements;
  const matches = byRole.filter((element) => {
    if (!wantedName) return true;
    const name = compact(element.name).toLowerCase();
    return target.exact ? name === wantedName : name.includes(wantedName);
  });
  const described = describeBrowserTarget(target);
  if (!matches.length) {
    const sameRole = target.role && byRole.length
      ? ` Elements with role ${target.role}: ${byRole.slice(0, MAX_LISTED_CANDIDATES)
        .map((element) => JSON.stringify(redactBrowserText(element.name || ''))).join(', ')}${
        byRole.length > MAX_LISTED_CANDIDATES ? ', …' : ''}.`
      : '';
    throw new Error(
      `no element matched target ${described} among ${scope.unfiltered ?? elements.length} candidate element(s).`
      + `${sameRole} Loosen the target or take a snapshot to read the page.`,
    );
  }
  if (target.nth) {
    if (target.nth > matches.length) {
      throw new Error(
        `target ${described} asked for match #${target.nth} but only ${matches.length} matched:\n${listCandidates(matches)}`,
      );
    }
    return matches[target.nth - 1];
  }
  if (matches.length === 1) return matches[0];
  const verbatim = wantedName
    ? matches.filter((element) => compact(element.name).toLowerCase() === wantedName)
    : [];
  if (verbatim.length === 1) return verbatim[0];
  throw new Error(
    `target ${described} matched ${matches.length} elements; add nth, exact:true, or a role, `
    + `or act on one of these refs from the fresh snapshot:\n${listCandidates(matches)}`,
  );
}

export interface BrowserTargetResolverHost {
  captureSnapshotPayload(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserSnapshotPayload>;
  state: BrowserGuestStateStore;
  cdp: BrowserCdpPort;
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T>;
}

export function createBrowserTargetResolver(host: BrowserTargetResolverHost) {
  /** Elements a CSS selector names, addressed through the same ref table as
   *  the snapshot. A match the accessibility tree does not consider
   *  interactive gets a ref minted for it. */
  async function selectorCandidates(
    guest: WebContents,
    selector: string,
    payload: BrowserSnapshotPayload,
    signal?: AbortSignal,
  ): Promise<BrowserSnapshotElement[]> {
    const record = host.state.for(guest);
    const byRef = new Map(payload.elements.map((element) => [element.ref, element]));
    const invalid = (reason: string) => new Error(
      `target.selector is not a valid CSS selector: ${redactBrowserText(reason)}`,
    );
    const mint = (
      role: string,
      name: string,
      register: (ref: string) => void,
      index: number,
    ): BrowserSnapshotElement => {
      const ref = `${payload.snapshotId}-t${index}`;
      register(ref);
      record.refSet?.refs.set(ref, {
        ref, snapshotId: payload.snapshotId, url: payload.url, role, name, href: '',
      });
      return { ref, role, name, tag: 'css' };
    };
    const accessibility = record.accessibilityRefs;
    if (accessibility && accessibility.snapshotId === payload.snapshotId) {
      const document = await host.cdp.call<{ root: { nodeId: number } }>(
        guest, 'DOM.getDocument', { depth: 0 }, signal,
      );
      let nodeIds: number[];
      try {
        ({ nodeIds } = await host.cdp.call<{ nodeIds: number[] }>(
          guest, 'DOM.querySelectorAll', { nodeId: document.root.nodeId, selector }, signal,
        ));
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        throw invalid((error as Error).message || String(error));
      }
      const byBackend = new Map<number, string>();
      for (const [ref, target] of accessibility.refs) {
        if (!target.sessionId) byBackend.set(target.backendNodeId, ref);
      }
      const out: BrowserSnapshotElement[] = [];
      let minted = 0;
      for (const nodeId of (nodeIds || []).slice(0, MAX_SELECTOR_MATCHES)) {
        const described = await host.cdp.call<{
          node: { backendNodeId: number; nodeName?: string; attributes?: string[] };
        }>(guest, 'DOM.describeNode', { nodeId }, signal);
        const backendNodeId = described.node.backendNodeId;
        const known = byBackend.get(backendNodeId);
        const element = known ? byRef.get(known) : undefined;
        if (element) {
          out.push(element);
          continue;
        }
        const attributes = described.node.attributes || [];
        const attribute = (wanted: string) => {
          const index = attributes.findIndex((value, position) => position % 2 === 0 && value === wanted);
          return index >= 0 ? compact(attributes[index + 1]).slice(0, 120) : '';
        };
        out.push(mint(
          attribute('role') || String(described.node.nodeName || 'element').toLowerCase(),
          attribute('aria-label') || attribute('title') || attribute('id'),
          (ref) => accessibility.refs.set(ref, { backendNodeId }),
          ++minted,
        ));
      }
      return out;
    }
    const found = await host.evaluate<{
      error?: string;
      matches?: Array<{ ref: string; role: string; name: string; minted: boolean }>;
    }>(guest, `(() => {
      const snapshot = window.__mixdogAgentSnapshot;
      if (!snapshot || snapshot.id !== ${JSON.stringify(payload.snapshotId)}) return { error: 'stale' };
      let nodes;
      try { nodes = document.querySelectorAll(${JSON.stringify(selector)}); } catch (error) { return { error: 'invalid:' + String(error && error.message || error) }; }
      const compact = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim().slice(0, 120);
      const matches = [];
      for (const element of Array.from(nodes).slice(0, ${MAX_SELECTOR_MATCHES})) {
        let ref = null;
        for (const [key, record] of snapshot.refs) {
          if ((record && record.element) === element || record === element) { ref = key; break; }
        }
        let minted = false;
        if (!ref) {
          snapshot.minted = (snapshot.minted || 0) + 1;
          ref = snapshot.id + '-t' + snapshot.minted;
          snapshot.refs.set(ref, { element, frames: [] });
          minted = true;
        }
        matches.push({
          ref,
          minted,
          role: compact(element.getAttribute('role') || element.tagName).toLowerCase(),
          name: compact(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.id),
        });
      }
      return { matches };
    })()`, signal);
    if (found?.error === 'stale') throw new Error('the page changed while resolving the target; try again');
    if (found?.error) throw invalid(found.error.replace(/^invalid:/, ''));
    return (found?.matches || []).map((match) => {
      const element = byRef.get(match.ref);
      if (element) return element;
      record.refSet?.refs.set(match.ref, {
        ref: match.ref, snapshotId: payload.snapshotId, url: payload.url, role: match.role, name: match.name, href: '',
      });
      return { ref: match.ref, role: match.role, name: match.name, tag: 'css' };
    });
  }

  /** Resolve every target against ONE fresh observation. A lone name-only
   *  target narrows the observation with its own name as the query. */
  async function resolveTargetRefs(
    guest: WebContents,
    rawTargets: unknown[],
    signal?: AbortSignal,
  ): Promise<ResolvedBrowserTarget[]> {
    const targets = rawTargets.map(normalizeBrowserTarget);
    const single = targets.length === 1 ? targets[0] : null;
    const query = single?.name && !single.selector && !REGEX_SHAPED.test(single.name)
      ? single.name
      : undefined;
    const payload = await host.captureSnapshotPayload(
      guest,
      { action: 'snapshot', maxElements: 500, ...(query ? { query } : {}) },
      signal,
    );
    const resolved: ResolvedBrowserTarget[] = [];
    for (const target of targets) {
      const pool = target.selector
        ? await selectorCandidates(guest, target.selector, payload, signal)
        : payload.elements;
      const chosen = selectBrowserTarget(target, pool, {
        unfiltered: target.selector ? pool.length : payload.unfilteredElements,
      });
      resolved.push({ ref: chosen.ref, description: describeBrowserTarget(target) });
    }
    return resolved;
  }

  return { resolveTargetRefs: timedBrowserOperation('target', resolveTargetRefs) };
}