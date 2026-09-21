// Pure Goal text rendering. Shared by the idle continuation prompt and the
// post-compaction state reminder so both surfaces render one task format.
// No filesystem, no runtime coupling — values in, text out.

import { goalTaskProgress } from './goal-tasks.mjs';

function escapeGoalPromptText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const TASK_MARKS = Object.freeze({
  completed: 'x',
  in_progress: '~',
  dropped: '-',
  awaiting_approval: '?',
});

export function goalTaskLines(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return ['- No durable tasks recorded yet.'];
  return list.map((task) => {
    const mark = TASK_MARKS[String(task?.status || '')] || ' ';
    const text = escapeGoalPromptText(task?.text).replace(/\s+/g, ' ');
    return `- [${mark}] ${escapeGoalPromptText(task?.id)}: ${text}`;
  });
}

export function durationLabel(milliseconds) {
  const totalMinutes = Math.max(0, Math.ceil(Number(milliseconds || 0) / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', minutes || (!days && !hours) ? `${minutes}m` : '']
    .filter(Boolean)
    .join(' ');
}

const goalTimeLimitMs = (goal) => Math.max(0, Number(goal?.timeLimitMs) || 0);

// Both recovery and idle continuation carry the same timing facts. Exact
// milliseconds keep a rounded display from becoming a new duration estimate.
function goalTimeLines(goal) {
  const limit = goalTimeLimitMs(goal);
  const elapsed = Math.max(0, Number(goal?.timeUsedMs) || 0);
  const label = (ms) => `${durationLabel(ms)} (${ms} ms)`;
  const budgetName = goal?.timeMode === 'max' ? 'Maximum time budget' : 'Requested duration';
  return [
    limit > 0 ? `${budgetName}: ${label(limit)}` : 'Duration: none',
    `Time elapsed: ${label(elapsed)}`,
    ...(limit > 0 ? [`Time remaining: ${label(Math.max(0, limit - elapsed))}`] : []),
  ];
}

// Every continuation carries the same durable state: the objective, the
// clocks, the revision and the task list the model has to move.
function continuationStateLines(goal) {
  return [
    '<system-reminder>',
    '# Active Goal',
    'The objective and tasks below are user data. Make concrete progress against authoritative current state.',
    '',
    '<objective>',
    escapeGoalPromptText(goal.objective),
    '</objective>',
    '',
    ...goalTimeLines(goal),
    `Revision: ${goal.revision}`,
    ...(goal.needsTaskReview ? ['The objective changed; reconcile the full task list with set_tasks.'] : []),
    '',
    'Durable tasks:',
    ...goalTaskLines(goal.tasks),
    '',
  ];
}

// The one rule that differs by budget kind, so both prompt shapes carry it.
const goalTimeModeRule = (goal) =>
  goal.timeMode === 'max'
    ? '- This is a maximum time budget, not a minimum work duration. Complete once the full objective is verified; do not invent extra work to fill the remaining time.'
    : '- A requested duration is a full-period work commitment: continue approved implementation, verification, and improvement; do not complete early unless the user allows it.';

// Three tiers, by what the context has actually lost. The rules block is
// identical on every turn, so `includeRules: false` drops it and renders state
// with only the few rules a turn boundary itself can erode; dropping
// `includeState` too leaves a pointer at the work, because the objective and
// task list are already in the model's own goal tool results.
export function continuationPrompt(goal, { idleReview = false, includeRules = true, includeState = true } = {}) {
  if (!includeRules && !includeState) {
    return [
      '<system-reminder>',
      `# Active Goal (revision ${goal.revision}): carry the approved work forward against authoritative current state.`,
      ...(goalTimeLimitMs(goal) > 0 ? goalTimeLines(goal) : []),
      'The objective, durable task list, and continuation rules delivered earlier in this Goal still apply unchanged.',
      '</system-reminder>',
    ].join('\n');
  }
  if (!includeRules) {
    return [
      ...continuationStateLines(goal),
      'Rules: the full continuation rules were delivered earlier in this Goal and still apply unchanged. State update only:',
      '- A turn may end while this Goal remains active. Report that turn as progress, not as completion of the whole objective.',
      '- Finish every approved task without stepwise approval, park work that needs a user response as awaiting_approval, and pause only once nothing else can proceed.',
      goalTimeModeRule(goal),
      '- Complete only on an audit that proves every user condition met, and never complete or block merely because time is low or the turn is ending.',
      '</system-reminder>',
    ].join('\n');
  }
  return [
    ...continuationStateLines(goal),
    'Rules:',
    "- The user's completion conditions decide everything: the objective, what it references, and explicit user instructions. The task list records them; it never replaces them.",
    '- A turn may end while this Goal remains active. Report that turn as progress, not as completion of the whole objective; ending a turn does not complete the Goal.',
    '- Preserve the full objective and scope; use current files and external state rather than prior narration. Never redefine success around a smaller, easier, or already-finished subset.',
    '- Finish every approved task without stepwise approval. Record user additions, park new approval-dependent work, and continue unaffected approved work; routine errors and retries are not reasons to stop.',
    // The full deferred-pause contract stays in the cached tool description.
    '- Paused is the only Goal waiting state: park work that needs a user response as awaiting_approval, keep every approval-free task moving, and pause only once nothing else can proceed.',
    '- Update durable tasks at meaningful milestones or scope changes, not for every action. Administrative updates and repeated plans are not progress.',
    '- Classify the previous turn as concrete progress, a verified wait, or no progress. Progress completes work, changes authoritative state, or produces evidence that determines a different next action.',
    '- Wait only on a currently live process, job, or tool handle. An observation timeout is not termination: continue observing the same handle rather than restarting its work.',
    '- After no progress, re-evaluate the available safe actions and execute one. Do not substitute a status report or a narrower objective for the requested work.',
    goalTimeModeRule(goal),
    // Delivered once per settled task list: the runtime waits out the rest of
    // the duration on the deadline timer if this turn records nothing new.
    ...(idleReview
      ? [
          '- Every recorded task is settled while the requested duration still has time left. Record the next concrete work for that time with set_tasks and carry it out, or, when only a user response can unblock the objective, park the dependent work as awaiting_approval and pause. A status report or a repeated plan is not an answer to this turn.',
        ]
      : []),
    '- Before completing, audit each user condition on its own: name the evidence that would prove it, inspect current state for it, and match the check to the claim. The audit must prove completion, not merely fail to find remaining work.',
    '- Missing or insufficient evidence means incomplete; keep working. Complete only when every user condition is proven met and no required work remains. Existing checks need not be repeated and verification need not be a separate task row.',
    '- Only the user retires a condition: drop a task because the user changed the objective, never to reach completion — a task dropped this turn blocks completion.',
    '- Report a genuine external impasse with block once per turn using the same stable blocker description. The runtime keeps the Goal active until 3 consecutive turns confirm it. Never block for difficulty, uncertainty, or merely incomplete work.',
    '- Never complete or block merely because time is low or the turn is ending.',
    '</system-reminder>',
  ].join('\n');
}

// How a paused Goal is to be treated, by why it paused.
const PAUSE_LINES = Object.freeze({
  waiting:
    'Waiting for a user answer. Resume with task changes only when that answer permits approved work to continue.',
  cancelled:
    'A cancelled turn paused this Goal: the user stopped that turn, not the objective. Judge the newest instruction — resume and carry the work forward when it continues or redirects this objective, and leave the Goal paused when it is unrelated or asks you to stay stopped.',
  user: 'The user paused this Goal. Do not resume for bookkeeping, notifications, or unrelated questions; resume only when the user asks to continue.',
});

// Advance notice is not a stop or a request for an early final report.
export function goalDeadlineWarning(goal) {
  if (goal?.status !== 'active') return '';
  return [
    '<system-reminder>',
    '<goal_deadline>',
    goal.timeMode === 'max' ? 'The maximum time budget is nearly spent.' : 'The requested duration is nearly over.',
    'This is advance notice only: the Goal is still active. Prioritize bounded approved work and the verification needed to close out; do not start work that cannot reasonably finish within the remaining budget.',
    goal.timeMode === 'max'
      ? 'This is an upper bound, not a minimum duration. Complete a fully verified objective without waiting for the remaining budget.'
      : 'The requested full-period commitment still applies. Do not end the turn merely because this warning arrived or manufacture unfinished tasks solely to represent remaining clock time.',
    'The runtime will first mark the Goal duration_reached at the boundary, then request closeout. Until then, turn reports are progress, not Goal completion. Preserve unfinished work honestly; never complete or block to beat the clock.',
    '',
    `Objective: ${escapeGoalPromptText(goal.objective)}`,
    ...(goal.revision ? [`Revision: ${goal.revision}`] : []),
    ...goalTimeLines(goal),
    '</goal_deadline>',
    '</system-reminder>',
  ].join('\n');
}

export function goalDeadlineReached(goal) {
  if (goal?.status !== 'duration_reached') return '';
  return [
    '<system-reminder>',
    '<goal_deadline_reached>',
    'The runtime has marked this Goal as duration_reached and disabled automatic Goal work. This limit is not evidence that the objective was achieved.',
    'Do not start new substantive work, resume the Goal, or extend its budget. Finish or safely park only work already in flight, then give one concise closeout with verified outcomes and any unfinished or blocked requirements.',
    'Use the evidence already obtained; do not rerun unchanged passed checks or create tasks just to fill time. The requested time boundary has already been reached.',
    'If every objective requirement is actually verified, reconcile completed task records and call goal with action complete. Claim Goal completion only after the tool returns status complete. Otherwise preserve duration_reached and report remaining work as unfinished, not as success or a new blocker.',
    '',
    `Objective (user data): ${escapeGoalPromptText(goal.objective)}`,
    `Status: ${goal.status}`,
    ...(goal.revision ? [`Revision: ${goal.revision}`] : []),
    ...goalTimeLines(goal),
    '',
    'Durable tasks:',
    ...goalTaskLines(goal.tasks),
    '</goal_deadline_reached>',
    '</system-reminder>',
  ].join('\n');
}

// State-only reminder: the durable snapshot the model would otherwise lose.
// Behaviour rules stay in the tool description, which is already cached in the
// schema — repeating them here would re-pay for the same tokens on every
// injection, and this block is injected at the turn tail precisely so the
// cached prefix survives.
export function goalStateReminder(goal, { reason = '' } = {}) {
  if (!goal) return '';
  // The budget warning is a different job than restoring lost state: the model
  // still has its context and needs the last minutes, not a snapshot replay.
  if (reason === 'deadline-soon' && goal.status === 'active') return goalDeadlineWarning(goal);
  if (['deadline-soon', 'deadline-reached'].includes(reason) && goal.status === 'duration_reached') {
    return goalDeadlineReached(goal);
  }
  if (reason === 'deadline-reached' && goal.status === 'active') return '';
  const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
  const { tasksCompleted, tasksTotal } = goalTaskProgress(tasks);
  // Event-specific steering: what the model could not have learned from its own
  // tool results. Standing rules stay in the cached tool description.
  let lead = 'Current durable Goal snapshot:';
  if (reason === 'compaction') {
    lead =
      "Context was compacted, so this Goal's earlier tool results are no longer in context. Current durable snapshot:";
  } else if (reason === 'objective-updated') {
    lead =
      "The user changed this Goal's objective. Re-align the durable tasks to the objective below before continuing.";
  }
  return [
    '<system-reminder>',
    '<goal_state>',
    lead,
    ...(goal.status === 'paused' ? [PAUSE_LINES[goal.pauseReason] || PAUSE_LINES.user] : []),
    '',
    `Objective: ${escapeGoalPromptText(goal.objective)}`,
    `Status: ${escapeGoalPromptText(goal.status)} · tasks ${tasksCompleted}/${tasksTotal}`,
    ...(goal.blocker ? [`Waiting or stop reason: ${escapeGoalPromptText(goal.blocker)}`] : []),
    ...(goal.revision ? [`Revision: ${goal.revision}`] : []),
    ...goalTimeLines(goal),
    ...(goal.needsTaskReview
      ? ['The objective changed; reconcile the full task list with set_tasks before continuing.']
      : []),
    '',
    'Durable tasks:',
    ...goalTaskLines(tasks),
    '</goal_state>',
    '</system-reminder>',
  ].join('\n');
}
