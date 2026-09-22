import { errorLine } from '../../runtime/shared/err-text.mjs';
import { createSendDispatch } from './execute-send.mjs';
import { createSpawnDispatch } from './execute-spawn.mjs';
import { agentScope, clean } from './helpers.mjs';
import { renderResult } from './render.mjs';

// The agent tool's request dispatch: list/status/read/cleanup/cancel/close/
// send/spawn. The dead-tag send fallback lives in execute-send.mjs and
// explicit-tag spawn resolution in execute-spawn.mjs.
export function createAgentExecute({
  mgr,
  defaultCwd,
  awaitKeychainPrewarm,
  registry,
  views,
  spawnFlow,
  sendFlow,
  closeFlow,
  terminalTrace,
}) {
  const spawnResult = (job) => renderResult(views.renderJob(job, false));

  async function readJob(args, scopedContext) {
    const job = views.getJobOrWorker(args, scopedContext);
    if (job?.taskId == null && typeof mgr.readSessionHandoff === 'function') {
      const handoff = await mgr.readSessionHandoff(job.meta?.sessionId);
      if (handoff) job.result = handoff;
    }
    return renderResult(views.renderJob(job, true));
  }

  const { send } = createSendDispatch({ registry, defaultCwd, sendFlow, spawnFlow, spawnResult });
  const { spawn } = createSpawnDispatch({ registry, terminalTrace, sendFlow, spawnFlow, spawnResult });

  return async function execute(args = {}, context = {}) {
    try {
      await awaitKeychainPrewarm();
      const type = clean(args.type) || 'spawn';
      const request = {
        callerCwd: clean(context.cwd || context.callerCwd),
        scopedContext: agentScope(args, context),
        context,
        notifyContext: context,
      };
      const { scopedContext } = request;
      if (typeof mgr.rehydrateAgentSessions === 'function') {
        await mgr.rehydrateAgentSessions();
        // Rebuild tag ownership from canonical records even if a daemon crash
        // happened before the auxiliary worker row was flushed.
        registry.refreshTagsFromSessions({ scanSessions: true, context: scopedContext });
      }
      switch (type) {
        case 'status':
        case 'list':
          if (type === 'status' && (clean(args.task_id) || clean(args.tag) || clean(args.sessionId))) {
            return renderResult(views.renderJob(views.getJobOrWorker(args, scopedContext), false), {
              includeDiagnostics: true,
            });
          }
          // Targetless status is the same compact overview as list.
          return renderResult({
            workers: views.list({ scanSessions: registry.wantsSessionScan(args), context: scopedContext }),
            jobs: views.listJobs(scopedContext),
          });
        case 'read':
          return await readJob(args, scopedContext);
        case 'cleanup':
          return renderResult(closeFlow.cleanup(args, scopedContext));
        case 'cancel':
        case 'close':
          return renderResult(await closeFlow.close(args, scopedContext));
        case 'send':
          return await send(args, request);
        case 'spawn':
          return await spawn(args, request);
        default:
          throw new Error(`agent: unknown type "${type}"`);
      }
    } catch (err) {
      return errorLine(err, { surface: 'agent' });
    }
  };
}
