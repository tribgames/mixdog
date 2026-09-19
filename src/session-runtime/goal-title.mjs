/**
 * goal-title.mjs — background title generation for a Goal objective. One job
 * per session; a newer objective supersedes the running job, and the title
 * only lands when the stored Goal still has the objective it was drawn from.
 */
import { compactSessionTitle, SESSION_TITLE_TIMEOUT_MS } from './session-title.mjs';
import { assertSessionId } from './goal-state.mjs';
import { clean } from '../runtime/shared/clean.mjs';
import { runAbortable } from '../runtime/shared/abort-race.mjs';

export function createGoalTitleScheduler(ctx) {
  const { titleJobs, now, generateTitle } = ctx;
  return (sessionId, goal) => {
    if (ctx.closed || typeof generateTitle !== 'function' || !goal) return;
    const id = assertSessionId(sessionId);
    const goalId = clean(goal.id);
    const objective = clean(goal.objective);
    titleJobs.get(id)?.abort.abort(new Error('Goal title generation superseded.'));
    const abort = new AbortController();
    const job = { abort };
    titleJobs.set(id, job);
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Goal title generation timed out.');
        abort.abort(error);
        reject(error);
      }, SESSION_TITLE_TIMEOUT_MS);
      timer.unref?.();
    });
    const superseded = () => ctx.closed || abort.signal.aborted || titleJobs.get(id) !== job;
    void Promise.race([runAbortable(abort.signal, () => generateTitle(objective, { signal: abort.signal })), timeout])
      .then((rawTitle) => {
        if (superseded()) return;
        const title = compactSessionTitle(rawTitle);
        if (!title || title === goal.title) return;
        return ctx.withMutation(id, async () => {
          if (superseded()) return;
          const current = ctx.readRecord(id).goal;
          if (!current || current.id !== goalId || current.objective !== objective) return;
          current.title = title;
          current.updatedAt = now();
          await ctx.commit(id, current);
        });
      })
      .catch(() => {})
      .finally(() => {
        if (timer) clearTimeout(timer);
        if (titleJobs.get(id) === job) titleJobs.delete(id);
      });
  };
}
