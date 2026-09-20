// The recall search plan: every flag and bound the search / browse legs read,
// derived once from the caller's args (query intent, period, sort, caps,
// expansion opt-ins, project scope). Pure — no DB access.
import { inferRecallPeriod, parsePeriod } from './recall-format.mjs';
import {
  hasLatestRecallIntent,
  hasRecallEntity,
  hasTimelineIntent,
  latestRecallSearchTerms,
} from './query-ranking.mjs';
import { RECALL_LIMIT_CAP, RECALL_OFFSET_CAP } from './recall-limits.mjs';

export function resolveQueryProjectScope(args, resolveProjectScope) {
  if (typeof args?.projectScope === 'string' && args.projectScope) return args.projectScope;
  const projectId = resolveProjectScope(typeof args?.cwd === 'string' && args.cwd ? args.cwd : null);
  return projectId !== null ? projectId : 'common';
}

function resolvePageBounds(args) {
  const requestedLimit = Number(args.limit);
  const requestedOffset = Number(args.offset);
  let limit = Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 10);
  let offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);
  const recallCapNotes = [];
  if (Number.isFinite(requestedLimit) && requestedLimit > RECALL_LIMIT_CAP) {
    limit = RECALL_LIMIT_CAP;
    recallCapNotes.push(`limit capped to ${RECALL_LIMIT_CAP} (requested ${requestedLimit})`);
  } else {
    limit = Math.min(RECALL_LIMIT_CAP, limit);
  }
  if (Number.isFinite(requestedOffset) && requestedOffset > RECALL_OFFSET_CAP) {
    offset = RECALL_OFFSET_CAP;
    recallCapNotes.push(`offset capped to ${RECALL_OFFSET_CAP} (requested ${requestedOffset})`);
  } else {
    offset = Math.min(RECALL_OFFSET_CAP, offset);
  }
  const recallCapPrefix = recallCapNotes.length ? `${recallCapNotes.join('; ')}\n` : '';
  return { requestedLimit, limit, offset, recallCapPrefix };
}

export function resolveSearchPlan(args, resolveProjectScope) {
  const query = String(args.query ?? '').trim();
  const queryPeriod = inferRecallPeriod(query);
  const period = String(args.period ?? '').trim() || queryPeriod;
  const timelineMode = args.sort == null && hasTimelineIntent(query);
  const latestIntent = hasLatestRecallIntent(query) || queryPeriod === '3h';
  const latestSearchTerms = latestIntent ? latestRecallSearchTerms(query) : [];
  const retrievalQuery = latestSearchTerms.length > 0 ? latestSearchTerms.join(' ') : query;
  const latestEntityMode = args.sort == null && latestIntent && hasRecallEntity(query);
  const latestRootMode =
    args.sort == null &&
    !timelineMode &&
    !latestEntityMode &&
    ((Boolean(queryPeriod) && !hasRecallEntity(query)) || latestIntent);
  const structuredTimeMode = timelineMode || latestRootMode;
  const { requestedLimit, limit, offset, recallCapPrefix } = resolvePageBounds(args);
  // Recent-browsing default: a query-less recall is a "show me the latest
  // messages" browse, not a relevance search — chronological order is the
  // only ordering that makes sense there, so sort defaults to 'date' when
  // no query is present (explicit args.sort still wins). Query recalls keep
  // the importance default.
  const hasQueryForSort = Array.isArray(args.query)
    ? args.query.some((v) => String(v || '').trim())
    : String(args.query ?? '').trim() !== '';
  const defaultSort = hasQueryForSort ? 'importance' : 'date';
  const sort = args.sort != null ? String(args.sort) : defaultSort;
  // Root summaries are the compact default recall output. Chunk members and
  // unchunked raw/episode rows are explicit expansion legs for callers that
  // need the underlying transcript evidence.
  const includeMembers = args.includeMembers === true;
  const includeRaw = args.includeRaw === true;
  const includeArchived = args.includeArchived !== false;
  const category = args.category;
  const temporal = parsePeriod(period, Boolean(query));
  const boundedHistoricalMode = Boolean(
    query &&
      sort !== 'date' &&
      !latestIntent &&
      !timelineMode &&
      Number.isFinite(Number(temporal?.startMs)) &&
      Number.isFinite(Number(temporal?.endMs)) &&
      Number(temporal.endMs) < Date.now() - 60 * 60 * 1000
  );
  const deepHistoricalMode = boundedHistoricalMode && Number(temporal.endMs) < Date.now() - 3 * 24 * 60 * 60 * 1000;
  // A period bounds the candidate set; it does not imply chronology. Topic
  // queries keep relevance ordering even inside a date window, while
  // query-less browsing stays newest-first through the default above.
  // Callers asking for a timeline can pin sort:'date' explicitly.

  // Derive projectScope from caller cwd (falls back to process.cwd()).
  // Explicit args.projectScope (string) takes priority so callers can
  // override to 'all', 'common', or a specific slug.
  const projectScope = resolveQueryProjectScope(args, resolveProjectScope);
  return {
    query,
    retrievalQuery,
    timelineMode,
    latestIntent,
    latestEntityMode,
    latestRootMode,
    structuredTimeMode,
    requestedLimit,
    limit,
    offset,
    recallCapPrefix,
    sort,
    includeMembers,
    includeRaw,
    includeArchived,
    category,
    temporal,
    excludeStatuses: includeArchived ? [] : ['archived'],
    boundedHistoricalMode,
    deepHistoricalMode,
    projectScope,
  };
}
