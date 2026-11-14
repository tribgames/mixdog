/**
 * `host/browser/ref/mint`: the refs of the top-document nodes a CSS selector names, on a page whose refs come from the
 * accessibility tree. A node the snapshot lists keeps its ref; any other (a heading, a div, a node the tree does not consider
 * interactive) gets one minted in the page's ref table, bound to its backend node like a listed one, so `ref/call` and the
 * pointer resolve it the same way. Backend ids of the top document stay unique across every target of an observation, so the
 * minted ref is `<snapshot>-t<backendNodeId>`: a selector-local counter could alias two fields of a batch.
 */
import type { Precondition } from '../../../../../../packages/protocol/src/index.ts';
import { redactBrowserText } from '../../browser/redaction';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import type { EngineContext } from './context';
import { requireCurrentSnapshot } from './ref-call';
import { registerEngineMethod } from './registry';

export const HOST_BROWSER_REF_MINT = 'host/browser/ref/mint';

/** The longest role or name taken from a node's attributes. */
const ATTRIBUTE_MAX_CHARS = 120;

const compact = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

function invalid(message: string): HostRpcError {
  return new HostRpcError(HOST_INVALID_PARAMS, message);
}

export function registerRefMint(connection: HostConnection, ctx: EngineContext): void {
  registerEngineMethod(connection, ctx, HOST_BROWSER_REF_MINT, async (params, signal, page) => {
    const { snapshotId, selector, limit } = params;
    if (typeof snapshotId !== 'string' || !snapshotId) throw invalid('ref/mint needs a snapshotId.');
    if (typeof selector !== 'string' || !selector) throw invalid('ref/mint needs a selector.');
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) throw invalid('ref/mint needs a limit.');
    const expect = (params.expect ?? undefined) as Precondition | undefined;
    requireCurrentSnapshot(page.state, snapshotId);
    const accessibility = page.state.accessibilityRefs;
    if (accessibility?.snapshotId !== snapshotId) {
      throw invalid('ref/mint needs a page whose refs come from the accessibility tree.');
    }
    const cdp = <T>(method: string, args: Record<string, unknown>) =>
      page.guarded(expect, () => ctx.cdp.call<T>(page.guest, method, args, signal));

    const document = await cdp<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
    let nodeIds: number[];
    try {
      ({ nodeIds } = await cdp<{ nodeIds: number[] }>('DOM.querySelectorAll', { nodeId: document.root.nodeId, selector }));
    } catch (error) {
      if (signal.aborted) throw signal.reason || error;
      return { count: 0, matches: [], invalid: redactBrowserText((error as Error).message || String(error)) };
    }
    // Past the limit only the count is final: a truncated list would hide a second match.
    if (nodeIds.length > limit) return { count: nodeIds.length, matches: [] };

    const byBackend = new Map<number, string>();
    for (const [ref, target] of accessibility.refs) {
      if (!target.sessionId) byBackend.set(target.backendNodeId, ref);
    }
    const listed = page.state.refSet?.refs;
    const matches: Array<{ ref: string; role: string; name: string }> = [];
    for (const nodeId of nodeIds) {
      const described = await cdp<{ node: { backendNodeId: number; nodeName?: string; attributes?: string[] } }>(
        'DOM.describeNode',
        { nodeId }
      );
      const backendNodeId = described.node.backendNodeId;
      const known = byBackend.get(backendNodeId);
      const element = known ? listed?.get(known) : undefined;
      if (known && element) {
        matches.push({ ref: known, role: element.role, name: element.name });
        continue;
      }
      const attributes = described.node.attributes ?? [];
      const attribute = (wanted: string): string => {
        const index = attributes.findIndex((value, position) => position % 2 === 0 && value === wanted);
        return index >= 0 ? compact(attributes[index + 1]).slice(0, ATTRIBUTE_MAX_CHARS) : '';
      };
      const ref = `${snapshotId}-t${backendNodeId}`;
      accessibility.refs.set(ref, { backendNodeId });
      matches.push({
        ref,
        role: attribute('role') || String(described.node.nodeName || 'element').toLowerCase(),
        name: attribute('aria-label') || attribute('title') || attribute('id'),
      });
    }
    return { count: nodeIds.length, matches };
  });
}
