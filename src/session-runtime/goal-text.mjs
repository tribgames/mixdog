// Pure Goal text rendering. Shared by the idle continuation prompt and the
// post-compaction state reminder so both surfaces render one task format.
// No filesystem, no runtime coupling — values in, text out.

export function escapeGoalPromptText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const TASK_MARKS = Object.freeze({
  completed: 'x', in_progress: '~', dropped: '-', awaiting_approval: '?',
});

export function goalTaskLines(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return ['- No durable tasks recorded yet.'];
  return list.map((task) => {
    const mark = TASK_MARKS[String(task?.status || '')] || ' ';
    const kind = String(task?.kind || 'work');
    const text = escapeGoalPromptText(task?.text).replace(/\s+/g, ' ');
    return `- [${mark}] ${escapeGoalPromptText(task?.id)} (${kind}): ${text}`;
  });
}

// State-only reminder: the durable snapshot the model would otherwise lose.
// Behaviour rules stay in the tool description, which is already cached in the
// schema — repeating them here would re-pay for the same tokens on every
// injection, and this block is injected at the turn tail precisely so the
// cached prefix survives.
export function goalStateReminder(goal, { reason = '' } = {}) {
  if (!goal) return '';
  const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
  const completed = tasks.filter((task) => task?.status === 'completed').length;
  // Event-specific steering: what the model could not have learned from its own
  // tool results. Standing rules stay in the cached tool description.
  const lead = reason === 'compaction'
    ? 'Context was compacted, so this Goal\'s earlier tool results are no longer in context. Current durable snapshot:'
    : reason === 'paused'
      ? 'This Goal is paused and was waiting on the user, whose reply has now arrived. Resume it and continue, or abandon it if the user redirected away from this objective.'
      : reason === 'objective-updated'
        ? 'The user changed this Goal\'s objective. Re-align the durable tasks to the objective below before continuing.'
        : 'Current durable Goal snapshot:';
  return [
    '<system-reminder>',
    '<goal_state>',
    lead,
    '',
    `Objective: ${escapeGoalPromptText(goal.objective)}`,
    `Status: ${escapeGoalPromptText(goal.status)} · tasks ${completed}/${tasks.length}`,
    '',
    'Durable tasks:',
    ...goalTaskLines(tasks),
    '</goal_state>',
    '</system-reminder>',
  ].join('\n');
}
