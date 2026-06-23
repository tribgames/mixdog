// NOTE: post-edit V4A fallback was removed.
//
// The removed V4A edit reroute used to emit every `old_string` line as a
// `-` with zero context_before/after,
// which meant the V4A matcher had to find the same byte slice the exact
// edit just failed on. Code 8 ("old_string not found") is by definition a
// byte/context mismatch (tab-vs-space drift, stale snapshot, fold-tier
// miss), so the V4A engine fails for the same reason and the user sees a
// noisy double-error block. The exact-unique byte path now handles large
// chunks natively, so the V4A pre-route is dead and has been removed.

export function planEditMutationRoute() {
    // Large-chunk V4A reroute removed: an EXACT-UNIQUE byte match is safe
    // at any size, so the edit-exact tier handles >=30-line chunks
    // natively (size gate now guards only the fold/fuzzy fallback). The
    // V4A pre-route used to fail anchor-not-found on bytes the exact tier
    // WOULD match, then priorResult short-circuited and surfaced a noisy
    // double-error block. Always route through edit-exact.
    return { engine: 'edit-exact', reason: 'default' };
}

export function isMutationPlanRoutable(plan) {
    return plan?.engine === 'v4a-patch' && plan?.patchArgs?.patch;
}

export function formatMutationRouteLine(plan = {}, extras = {}) {
    const source = plan.sourceTool || extras.sourceTool || 'unknown';
    const engine = plan.engine || extras.engine || 'unknown';
    const reason = plan.reason || extras.reason || 'unknown';
    const suffix = Object.entries(extras)
        .filter(([key, value]) => key !== 'sourceTool' && key !== 'engine' && key !== 'reason' && value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '-')}`)
        .join(' ');
    return `mutation_route: source=${source} engine=${engine} reason=${reason}${suffix ? ` ${suffix}` : ''}`;
}

export function wrapMutationRouteOutput(text, plan = {}, extras = {}) {
    const body = String(text ?? '');
    if (/^mutation_route:/i.test(body.trimStart())) return body;
    return `${formatMutationRouteLine(plan, extras)}\n${body}`;
}

export async function executeMutationPlan(plan, context = {}) {
    if (!isMutationPlanRoutable(plan)) return null;
    const { executePatchTool } = await import('./patch.mjs');
    let out;
    try {
        out = await executePatchTool('apply_patch', {
            base_path: context.workDir,
            ...plan.patchArgs,
        }, context.workDir, {
            ...context.options,
            readStateScope: context.readStateScope,
            sessionId: context.options?.sessionId,
            mutationPlan: plan,
        });
    } catch (err) {
        return { ok: false, text: err?.message || String(err), plan };
    }
    const text = String(out ?? '');
    if (/^Error:/i.test(text.trimStart())) {
        return { ok: false, text: out, plan };
    }
    return {
        ok: true,
        text: wrapMutationRouteOutput(text, plan),
        plan,
    };
}

export function appendMutationPlanFailure(originalResult, plannedResult) {
    if (!plannedResult || plannedResult.ok) return originalResult;
    const plan = plannedResult.plan || {};
    return `${originalResult}\nmutation_route: source=${plan.sourceTool || 'unknown'} engine=${plan.engine || 'unknown'} reason=${plan.reason || 'unknown'} failed\n${plannedResult.text}`;
}
