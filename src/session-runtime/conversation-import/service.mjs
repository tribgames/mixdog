/**
 * "Import conversations from other apps": the runtime API (list / register /
 * start / status / cancel) and the background import jobs behind it.
 *
 * Jobs are process-wide, so a job keeps running and stays observable after the
 * dialog closes or the user switches conversations (each session runtime of
 * the daemon reads the same registry). Every file passes one serialized
 * admission lane shared by all jobs, where the "already imported" check is
 * repeated right before the session is created, against the session catalog
 * read once per batch and every commit of this process since.
 * An import key only counts as imported while its session still exists in
 * storage, so a deleted import can be imported again.
 * Cancel stops admitting further files; committed imports stay.
 */
import { randomUUID } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  buildImportOrigin,
  createImportedSession,
  importOriginKey,
} from '../../runtime/agent/orchestrator/session/conversation-import/imported-session.mjs';
import { IMPORT_WARNING_CWD_MISSING } from '../../runtime/agent/orchestrator/session/conversation-import/turns.mjs';
import { sessionPath } from '../../runtime/agent/orchestrator/session/store/session-paths.mjs';
import {
  cachedMeta,
  convertCandidateFile,
  displayTitle,
  getCandidate,
  importError,
  importedKeyMap,
  listConversations,
  loadStoredTitles,
  recordConversion,
  registerFile,
  resolveSourceCwd,
  resolveViewSelection,
} from './discovery.mjs';

const MAX_FINISHED_JOBS = 20;
const MAX_REQUEST_ID_LENGTH = 200;

const jobs = new Map(); // jobId → job (insertion order = start order)
const jobsByRequest = new Map(); // requestId → jobId
const pendingStarts = new Map(); // requestId → Promise<job> while a selection resolves
// import key → session id, imports of this process (summaries can lag a save).
const committedKeys = new Map();
let admissionTail = Promise.resolve();

/** Test seam: forget every job and committed key. */
export function resetConversationImportJobs() {
  jobs.clear();
  jobsByRequest.clear();
  pendingStarts.clear();
  committedKeys.clear();
  admissionTail = Promise.resolve();
}

const EXISTS_CONCURRENCY = 16;

const sessionFileExists = (id) =>
  access(sessionPath(id)).then(
    () => true,
    () => false
  );

/**
 * `get(key)` → the id of an existing session imported under `key`, else null.
 * Candidates come from this process's commits, then summaries; every candidate
 * id's existence is checked (asynchronously) once, up front. Committed ids
 * whose session no longer exists are dropped from the commit map.
 */
async function importedLookup(summaries, sessionExists) {
  const fromSummaries = importedKeyMap(summaries);
  const committedAtStart = new Map(committedKeys);
  const ids = [...new Set([...committedAtStart.values(), ...[...fromSummaries.values()].flat()])];
  const existing = new Set();
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      if (await sessionExists(id)) existing.add(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXISTS_CONCURRENCY, ids.length) }, worker));
  for (const [key, id] of committedAtStart) {
    if (!existing.has(id) && committedKeys.get(key) === id) committedKeys.delete(key);
  }
  const get = (key) => {
    const committed = committedAtStart.get(key);
    if (committed && existing.has(committed)) return committed;
    return (fromSummaries.get(key) || []).find((id) => existing.has(id)) || null;
  };
  return { get, has: (key) => get(key) !== null };
}

class FatalImportError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function admit(task) {
  const run = admissionTail.then(task, task);
  admissionTail = run.then(
    () => {},
    () => {}
  );
  return run;
}

function snapshot(job) {
  return {
    jobId: job.jobId,
    seq: job.seq,
    state: job.state,
    total: job.total,
    processed: job.imported + job.skippedAlreadyImported + job.failed,
    imported: job.imported,
    skippedAlreadyImported: job.skippedAlreadyImported,
    failed: job.failed,
    byProject: [...job.byProject.entries()].map(([projectPath, counts]) => ({ projectPath, ...counts })),
    results: job.results.map((result) => ({ ...result, warnings: [...result.warnings] })),
    current: job.current ? { ...job.current } : null,
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
  };
}

function touch(job, patch = {}) {
  Object.assign(job, patch);
  job.seq += 1;
}

const COUNTER = { imported: 'imported', alreadyImported: 'skippedAlreadyImported', failed: 'failed' };

const titlesFor = (candidate, context) => (candidate.source === 'codex' ? context.titles : null);

/** Which record a result is about: its title and source file name, for the failure report. */
function describeCandidate(candidateId, context) {
  const candidate = getCandidate(candidateId);
  return {
    title: candidate ? displayTitle(cachedMeta(candidate), titlesFor(candidate, context)) : null,
    sourceName: candidate ? basename(candidate.path) : null,
  };
}

function record(job, { projectPath = null, ...result }) {
  const counter = COUNTER[result.status];
  job[counter] += 1;
  const counts = job.byProject.get(projectPath) || { imported: 0, skippedAlreadyImported: 0, failed: 0 };
  counts[counter] += 1;
  job.byProject.set(projectPath, counts);
  job.results.push(result);
  touch(job);
}

function pruneFinishedJobs() {
  const finished = [...jobs.values()].filter((job) => job.state !== 'running' && job.state !== 'stopping');
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
    jobs.delete(job.jobId);
    if (jobsByRequest.get(job.requestId) === job.jobId) jobsByRequest.delete(job.requestId);
  }
}

const failed = (candidateId, errorCode, projectPath = null, warnings = []) => ({
  candidateId,
  status: 'failed',
  errorCode,
  warnings,
  projectPath,
});

async function importOne(candidateId, context) {
  const candidate = getCandidate(candidateId);
  if (!candidate) return failed(candidateId, 'unknownCandidate');
  // The chat keeps the title the user picked it by: a long file's listing
  // title comes from its prefix and can differ from the converted branch.
  // Codex's own stored title, when it has one, names the chat first.
  const listedTitle = cachedMeta(candidate)?.title ?? null;
  let conversion;
  try {
    const info = await stat(candidate.path);
    if (!info.isFile()) return failed(candidateId, 'unreadable');
    candidate.size = info.size;
    candidate.mtimeMs = info.mtimeMs;
    conversion = await convertCandidateFile(candidate, { ...context.limits, env: context.env });
  } catch {
    return failed(candidateId, 'unreadable');
  }
  const title = displayTitle(
    { foreignSessionId: conversion.foreignSessionId, title: listedTitle || conversion.title },
    titlesFor(candidate, context)
  );
  if (title) conversion = { ...conversion, title };
  recordConversion(candidate, conversion);
  const cwdInfo = await resolveSourceCwd(conversion.cwd);
  const projectPath = cwdInfo.exists ? cwdInfo.path : null;
  if (conversion.errorCode) return failed(candidateId, conversion.errorCode, projectPath, conversion.warnings);
  const warnings = [...conversion.warnings, ...(projectPath ? [] : [IMPORT_WARNING_CWD_MISSING])];
  const key = importOriginKey(candidate.source, conversion.foreignSessionId, candidate.path);
  // The batch's catalog snapshot, then commits made since (by any job; the
  // admission lane serializes them).
  let existing = context.imported.get(key);
  const committed = committedKeys.get(key);
  if (!existing && committed && (await context.sessionExists(committed))) existing = committed;
  if (existing) return { candidateId, status: 'alreadyImported', sessionId: existing, warnings, projectPath };
  if (!context.leadOptions) {
    try {
      context.leadOptions = await context.prepareLeadOptions();
    } catch (error) {
      throw new FatalImportError(error?.code || 'noModelRoute');
    }
  }
  let session;
  try {
    session = await context.createImportedSession({
      leadOptions: context.leadOptions,
      conversation: conversion,
      origin: buildImportOrigin({
        source: candidate.source,
        sourcePath: candidate.path,
        foreignSessionId: conversion.foreignSessionId,
        sourceCwd: conversion.cwd,
        importedAt: Date.now(),
      }),
      cwd: projectPath,
      desktopSession: projectPath
        ? { classification: 'project', projectPath }
        : { classification: 'task', projectPath: null },
    });
  } catch (error) {
    return failed(candidateId, typeof error?.code === 'string' ? error.code : 'importFailed', projectPath, warnings);
  }
  committedKeys.set(key, session.id);
  return { candidateId, status: 'imported', sessionId: session.id, warnings, projectPath };
}

async function runJob(job, candidateIds, context) {
  try {
    // One catalog read per batch; later commits are seen through committedKeys.
    context.imported = await context.importedLookup();
    context.titles = await context.loadTitles();
    for (const candidateId of candidateIds) {
      if (job.cancelRequested) break;
      let result;
      try {
        result = await admit(async () => {
          // A cancel that arrived while queued behind other jobs wins here.
          if (job.cancelRequested) return null;
          touch(job, { current: { candidateId, title: describeCandidate(candidateId, context).title } });
          try {
            return await importOne(candidateId, context);
          } finally {
            job.current = null;
          }
        });
      } catch (error) {
        if (error instanceof FatalImportError) throw error;
        result = failed(candidateId, 'importFailed');
      }
      if (result === null) break;
      record(job, { ...result, ...describeCandidate(candidateId, context) });
    }
    touch(job, { state: job.cancelRequested ? 'stopped' : 'completed' });
  } catch (error) {
    touch(job, { state: 'failed', current: null, errorCode: error?.code || 'importFailed' });
  }
  pruneFinishedJobs();
}

/** Candidate ids of a selection; a `viewId` resolves the view's complete membership. */
async function selectionIds(selection, imported) {
  if (!selection || typeof selection !== 'object') throw new TypeError('selection is required.');
  if (Array.isArray(selection.ids)) {
    if (!selection.ids.every((id) => typeof id === 'string' && id)) throw new TypeError('selection.ids must be ids.');
    return [...new Set(selection.ids)];
  }
  if (typeof selection.viewId === 'string') {
    if (selection.excludeIds !== undefined && !Array.isArray(selection.excludeIds)) {
      throw new TypeError('selection.excludeIds must be ids.');
    }
    return resolveViewSelection(selection.viewId, selection.excludeIds, await imported());
  }
  throw new TypeError('selection must carry ids or a viewId.');
}

function requireParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('expected one object.');
  return params;
}

/**
 * Runtime API slice. deps:
 *   listSessionSummaries()  async session summary rows (carrying `importKey`), read once per listing/batch
 *   prepareLeadOptions()    async createSession options of a Lead session on the current route
 *   createSession(opts)     the session manager's createSession
 *   sessionExists(id)       async: whether a session is still in storage (default: its file exists)
 *   ingestSession(session)  content-search ingestion of an imported session (default: ingestSessionTurn)
 *   limits                  convertCandidateFile limits (maxFileBytes, maxLineBytes, maxTranscriptChars, …)
 */
export function createConversationImportApi({
  listSessionSummaries,
  prepareLeadOptions,
  createSession,
  env,
  sessionExists = sessionFileExists,
  ingestSession,
  limits,
}) {
  const summaries = async () => (await listSessionSummaries?.()) || [];
  const imported = async () => importedLookup(await summaries(), sessionExists);
  return {
    async listImportableConversations(params) {
      return listConversations(requireParams(params), { imported: await imported(), env });
    },
    async registerConversationImportFile(params) {
      return registerFile(requireParams(params), { imported: await imported(), limits, env });
    },
    getConversationImportJobs(params = {}) {
      const { jobId } = requireParams(params ?? {});
      const list = [...jobs.values()].filter((job) => jobId === undefined || jobId === null || job.jobId === jobId);
      return { jobs: list.map(snapshot) };
    },
    async startConversationImport(params) {
      const { requestId, selection } = requireParams(params);
      if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > MAX_REQUEST_ID_LENGTH) {
        throw new TypeError('requestId is required.');
      }
      const existing = jobs.get(jobsByRequest.get(requestId));
      if (existing) return snapshot(existing);
      let pending = pendingStarts.get(requestId);
      if (!pending) {
        pending = (async () => {
          const candidateIds = await selectionIds(selection, imported);
          const job = {
            jobId: randomUUID(),
            requestId,
            seq: 0,
            state: 'running',
            total: candidateIds.length,
            imported: 0,
            skippedAlreadyImported: 0,
            failed: 0,
            byProject: new Map(),
            results: [],
            current: null,
            errorCode: null,
            cancelRequested: false,
          };
          jobs.set(job.jobId, job);
          jobsByRequest.set(requestId, job.jobId);
          void runJob(job, candidateIds, {
            importedLookup: imported,
            imported: null,
            titles: null,
            loadTitles: () => loadStoredTitles('codex', env),
            sessionExists,
            limits,
            env,
            prepareLeadOptions,
            leadOptions: null,
            createImportedSession: (args) =>
              createImportedSession({
                ...args,
                ...(createSession ? { createSessionFn: createSession } : {}),
                ...(ingestSession ? { ingestFn: ingestSession } : {}),
              }),
          });
          return job;
        })();
        pendingStarts.set(requestId, pending);
        pending.then(
          () => pendingStarts.delete(requestId),
          () => pendingStarts.delete(requestId)
        );
      }
      return snapshot(await pending);
    },
    cancelConversationImport(params) {
      const { jobId } = requireParams(params);
      const job = typeof jobId === 'string' ? jobs.get(jobId) : null;
      if (!job) throw importError('jobNotFound');
      if (job.state === 'running') {
        job.cancelRequested = true;
        touch(job, { state: 'stopping' });
      }
      return snapshot(job);
    },
  };
}
