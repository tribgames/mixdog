/**
 * The agent's note on a new worktree's preparation, given with its first
 * turn and never shown as a card: the main checkout it was made from, what
 * creation copied (env files, .worktreeinclude) and linked, what the first
 * turn installed, what failed (with the output tail) and what was skipped.
 */
import { outputTail } from './setup-commands.mjs';

const SKIP_REASONS = {
  'include-missing': 'not in the main checkout',
  'include-exists': 'already in the checkout',
  'include-skipped': 'not allowed',
};

function skipLine(warning) {
  const [code, ...rest] = String(warning).split(':');
  const subject = rest.join(':');
  if (code === 'include-invalid') {
    return subject === 'patterns'
      ? '.worktreeinclude patterns (git could not use them)'
      : `.worktreeinclude line ${subject} (invalid)`;
  }
  if (code === 'include-truncated') return `.worktreeinclude patterns (${subject} matches; nothing copied)`;
  return SKIP_REASONS[code] ? `${subject} (${SKIP_REASONS[code]})` : null;
}

const ENDED = { 'timed-out': 'timed out', cancelled: 'was cancelled', failed: 'failed' };

function failureLines(run) {
  if (!run || run.status === 'completed') return [];
  const last = run.steps.at(-1);
  if (!last) return [`Stopped: ${ENDED[run.status] ?? run.status}.`];
  const exit = last.exitCode === null ? '' : `, exit ${last.exitCode}`;
  const where = last.label ? ` [${last.label}]` : '';
  const tail = outputTail(last.output);
  return [`Failed: ${last.command}${where} (${ENDED[last.status] ?? last.status}${exit})`, ...(tail ? [tail] : [])];
}

/** One line per install the stop left unrun: its folder and the command to run there. */
function pendingLines(run) {
  return (run?.pending || []).map(
    (step) => `Skipped (not run after the stop): ${step.label || step.command} — run \`${step.command}\` in ${step.cwd}`
  );
}

function completed(run) {
  return (run?.steps || []).filter((step) => step.status === 'completed');
}

/**
 * @param {{ root?: string, prepared?: object|null, dependencyNotes?: string[], installs?: object|null,
 *   notes?: string[] }} report `installs`: the runner report (setup-commands.mjs).
 * @returns {string} One system-reminder block.
 */
export function worktreePreparationNote({
  root = '',
  prepared = null,
  dependencyNotes = [],
  installs = null,
  notes = [],
}) {
  const lines = [
    `This worktree was made from the main checkout at ${root || prepared?.root || 'an unknown path'}; ignored files there (build output, caches) are not here unless listed below.`,
  ];
  const list = (label, items) => {
    if (items?.length) lines.push(`${label}: ${items.join(', ')}`);
  };
  list('Copied from the main checkout', prepared?.copied);
  list('Linked from the main checkout', prepared?.linked);
  lines.push(...dependencyNotes);
  list(
    'Installed',
    completed(installs).map((step) => step.label || step.command)
  );
  lines.push(...failureLines(installs), ...pendingLines(installs));
  list('Skipped', (prepared?.skipped || []).map(skipLine).filter(Boolean));
  lines.push(...notes);
  return `<system-reminder>\n# Worktree Preparation\n${lines.join('\n')}\n</system-reminder>`;
}
