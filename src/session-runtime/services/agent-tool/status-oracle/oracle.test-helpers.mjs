// The reference the status sets are tested against: the status read exactly
// as it was before them. agent-list.mjs, job-render.mjs and tag-lookup.mjs in
// this folder are `git show <pre-status-sets HEAD>:` copies, verbatim, of
// job-views/agent-list.mjs, job-views/job-render.mjs and
// tag-registry/tag-lookup.mjs (the modules the status sets changed or
// extracted builders from); the read below is that HEAD's statusFor
// (agent-tool.mjs) over HEAD's createJobViews composition. Everything else it
// reads (the worker index, the tag maps, session records, session progress,
// background tasks) is the live state the tool itself holds. Test-only.
import { callerSessionForContext, terminalPidForContext } from '../helpers.mjs';
import { createAgentList } from './agent-list.mjs';
import { createJobRender } from './job-render.mjs';
import { createTagLookup } from './tag-lookup.mjs';
import { createSessionProgress, liveAgentStatusRow } from './session-progress.mjs';

const NOT_READY_STATUS = Object.freeze({ workers: [], jobs: [], scope: null });

/** `internals`: the agent tool's `_statusInternalsForTest`. */
export function createStatusOracle({ mgr, tags, readWorkerRows, reaper, getLiveSession, refreshTagsFromSessions, sessionRecords, isKeychainPrewarmReady }) {
  const { agentSessionEntries } = createTagLookup({
    tags,
    mgr,
    readWorkerRows,
    reaper,
    getLiveSession,
    refreshTagsFromSessions,
    sessionRecords,
  });
  const progress = createSessionProgress({ mgr, sessionRecords });
  const views = {
    list: createAgentList({ mgr, refreshTagsFromSessions, agentSessionEntries, progress }),
    listJobs: createJobRender({ progress }).listJobs,
  };

  // HEAD agent-tool.mjs statusFor (its prewarm watch only schedules a re-read).
  return function statusFor(scopedContext) {
    if (!isKeychainPrewarmReady()) {
      return NOT_READY_STATUS;
    }
    const ownerSession = callerSessionForContext(scopedContext);
    const pid = terminalPidForContext(scopedContext);
    let scope = { allTerminals: true };
    if (ownerSession) scope = { sessionId: ownerSession };
    else if (pid) scope = { clientHostPid: pid };
    return {
      workers: views.list({ scanSessions: false, context: scopedContext, memoryOnly: true }).map(liveAgentStatusRow),
      jobs: views.listJobs(scopedContext, { memoryOnly: true }).map(liveAgentStatusRow),
      scope,
    };
  };
}
