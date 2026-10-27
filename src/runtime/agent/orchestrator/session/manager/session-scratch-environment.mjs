// manager/session-scratch-environment.mjs
// A session record that was copied from another session (a clear archive)
// still names the SOURCE's scratch directory in its generated environment,
// while its shell commands use its own. This rewrites only that line.
import {
  BP3_PART_SEPARATOR,
  bp3SystemMessage,
  bpEnvSystemMessage,
  replaceSystemMessageContent,
  replaceWorkspaceEnvironment,
} from './prompt-utils.mjs';
import { scratchEnvironmentLine } from './session-prompt-composition.mjs';

const SCRATCH_LINE = /^- Scratch: .*$/m;

function withLine(text, line) {
  return typeof text === 'string' ? text.replace(SCRATCH_LINE, () => line) : text;
}

// Only the generated environment facts (the first part of the environment
// tail) hold the line; memory and instruction files never do.
function tailWithLine(tail, line) {
  if (typeof tail !== 'string') return tail;
  const facts = tail.split(BP3_PART_SEPARATOR)[0];
  const fixed = withLine(facts, line);
  return fixed === facts ? tail : replaceWorkspaceEnvironment(tail, fixed);
}

/**
 * Make `session`'s generated environment name its own scratch directory:
 * the persisted environment tail, the system block carrying it and the
 * environment facts of a staged workspace change. Instruction files, memory
 * and every conversation message stay as they are; a session that already
 * names its own directory is left byte-identical (message objects included).
 * System messages are replaced in the session's own array, never mutated.
 * @returns {boolean} whether the system prefix changed
 */
export function useOwnScratchEnvironment(session) {
  const line = scratchEnvironmentLine(session?.id);
  if (!line) return false;
  const oldTail = session.bp3EnvironmentContext;
  const newTail = tailWithLine(oldTail, line);
  session.bp3EnvironmentContext = newTail;
  const pending = session.workspaceReroot;
  const seen = tailWithLine(pending?.seen?.environmentContext, line);
  const target = tailWithLine(pending?.target?.environmentContext, line);
  if (seen !== pending?.seen?.environmentContext || target !== pending?.target?.environmentContext) {
    // The staged state may be shared with the session this one was copied
    // from: replace it, never edit it.
    session.workspaceReroot = {
      ...pending,
      seen: { ...pending.seen, environmentContext: seen },
      target: { ...pending.target, environmentContext: target },
    };
  }
  if (newTail === oldTail || typeof oldTail !== 'string') return false;
  // The generated environment closes its block (split env block, or the
  // combined tier3 block after core + session start): swap that suffix.
  const block = session.bp3EnvSplit === true ? bpEnvSystemMessage(session) : bp3SystemMessage(session);
  const content = block?.content;
  const suffix = oldTail.trim();
  if (typeof content !== 'string' || !suffix || !content.endsWith(suffix)) return false;
  return replaceSystemMessageContent(session, block, content.slice(0, -suffix.length) + newTail.trim());
}
