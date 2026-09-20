/**
 * aggregate-card.mjs — the collapsed model of a tool GROUP card ("Read 3
 * files, searched 2"): category counts in the header, one detail row.
 */
import { formatAggregateHeader } from '../tool-surface.mjs';
import { commonCardFields } from './card-input.mjs';
import { normalizeCountMap, safeInlineText } from './inline-text.mjs';
import { resultTerminalStatus } from './terminal-status.mjs';

function countOf(value) {
  return value && typeof value === 'object' ? Number(value.count || 0) : Number(value || 0);
}

function aggregateLabel(base) {
  const { args, categories, doneCategories, headerPending } = base;
  const displayCategories = normalizeCountMap(categories || {});
  const normalizedDone = doneCategories ? normalizeCountMap(doneCategories) : displayCategories;
  const hasDoneCounts = Object.values(normalizedDone || {}).some((v) => countOf(v) > 0);
  const displayDone = hasDoneCounts ? normalizedDone : displayCategories;
  const headerOrder = Array.isArray(args?.categoryOrder) ? args.categoryOrder : null;
  const loadingTargets = [
    ...new Set(
      (Array.isArray(args?.loadingTargets) ? args.loadingTargets : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  const loadingVerb = headerPending ? 'Loading' : 'Loaded';
  const headerCategories = (headerPending ? displayCategories : displayDone) || {};
  return safeInlineText(
    loadingTargets.length
      ? `${loadingVerb} ${loadingTargets.join(', ')}`
      : formatAggregateHeader(headerCategories, { pending: headerPending, order: headerOrder })
  );
}

export function deriveAggregateCardModel(base) {
  const { args, isError, rt, pending, hasResult, failedCount } = base;
  const detailText = hasResult ? safeInlineText(rt) : '';
  const failedOrCompleted = isError || failedCount > 0 ? 'failed' : 'completed';
  const terminalStatus = pending ? 'running' : resultTerminalStatus(rt) || failedOrCompleted;
  return {
    aggregate: true,
    ...commonCardFields(base, terminalStatus),
    labelText: aggregateLabel(base),
    summaryText: '',
    headerFailureText: '',
    detailLine: detailText || (pending ? 'Running' : 'Finished'),
    detailIsPlaceholder: !detailText,
    displayedResultBodyText: rt || '',
    firstResultLine: detailText,
    totalLines: detailText ? 1 : 0,
    resultSummary: detailText || null,
    toolArgPath: '',
    normalizedName: '',
    label: '',
    parsedArgs: args,
    isShellSurface: false,
    isSkillSurface: false,
    isAgentSurfaceCard: false,
    isAgentResponse: false,
    isBackgroundResponse: false,
    isBackgroundMetadataResult: false,
    backgroundMeta: null,
  };
}
