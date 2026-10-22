// manager/orchestration-mode-switch-notice.mjs
// A mid-conversation delegation (orchestration) mode switch
// (session-runtime/tool-policy-refresh.mjs switchSessionOrchestrationMode),
// on the workflow switch's pattern (workflow-switch-notice.mjs): the request
// prefix — system blocks and tool schemas — stays byte-identical, so the
// provider cache survives. The switch lives in two pieces of session state:
//   session.orchestrationModeOverlay — while the session's mode differs from
//     the one its system prompt carries: the prompt's mode (`prompt`), the
//     new mode, the tools the model must load before using them
//     (`loadableTools`) and the self-contained reminder (`content`) with the
//     new mode's rules (the same block BP3 carries). It is folded into the
//     prompt (and dropped) at the next point where the cache is cold anyway.
//   session.orchestrationModeSwitch — the notice the next user turn carries
//     in its reminder block: snapshot when the turn is built, acknowledge once
//     the provider accepted it. `from` is the mode the model was last told
//     about, `to` the session's mode now.
// Every notice says it replaces the earlier ones, so the latest one wins.
import { normalizeOrchestrationMode, ORCHESTRATION_MODES } from '../../../../shared/orchestration.mjs';
import { orchestrationInstructions } from '../../runtime-core/orchestration.mjs';

/** The mode's name as its BP3 block titles it (`# Orchestration Mode: …`). */
export function orchestrationModeName(value) {
  const mode = normalizeOrchestrationMode(value);
  return mode === 'none' ? 'Solo' : `${mode[0].toUpperCase()}${mode.slice(1)}`;
}

/** The mode the session's system prompt and tool surface were built with. */
export function promptOrchestrationModeOf(session) {
  if (session?.workflowOverlay) return session.workflowOverlay.promptOrchestrationMode;
  if (session?.orchestrationModeOverlay) return session.orchestrationModeOverlay.prompt;
  return session?.orchestrationMode;
}

/**
 * Read a shipped coding-mode slice from the actual BP3 message, not the mode
 * metadata: older profile refreshes could rewrite one without the other.
 * Only a complete, unambiguous generated slice is evidence. Custom rules,
 * headings quoted in another slice, and unrecognized legacy layouts are not.
 */
export function orchestrationModeFromPrompt(session) {
  const core = session?.messages?.find(
    (message) => message?.role === 'system' && message.cacheTier === 'tier3'
  )?.content;
  if (typeof core !== 'string') return null;
  const slices = core.split('\n\n---\n\n');
  const modes = ORCHESTRATION_MODES.filter((mode) => slices.includes(orchestrationInstructions(mode)));
  return modes.length === 1 ? modes[0] : null;
}

const listed = (names) => names.map((name) => `\`${name}\``).join(', ');

/** The reminder that makes the Lead follow `mode`: self-contained (the mode's
 *  rules) and superseding every earlier one. `carried`: the system prompt
 *  carries this mode itself (a switch back, or the overlay folded in). */
export function orchestrationModeNoticeContent({ mode, carried = false, loadableTools = [] }) {
  const name = orchestrationModeName(mode);
  const lead = carried
    ? `This conversation now uses the ${name} orchestration mode, the one the system prompt carries.`
    : `This conversation now uses the ${name} orchestration mode. The system prompt's Orchestration Mode no longer applies; follow ${name}'s below instead.`;
  const pronoun = loadableTools.length === 1 ? 'it' : 'them';
  return [
    '<system-reminder>',
    '# Orchestration Mode Changed',
    `${lead} This replaces every earlier Orchestration Mode Changed reminder in this conversation.`,
    ...(loadableTools.length
      ? [
          `${listed(loadableTools)}: not among your directly defined tools yet; load ${pronoun} with \`load_tool\` before the first call.`,
        ]
      : []),
    `Agents already started keep running with their own instructions; new delegation follows ${name}.`,
    '',
    orchestrationInstructions(mode),
    '</system-reminder>',
  ].join('\n');
}

/** Stage the notice of a switch from `from` to `to`; a switch back to what the
 *  model was last told drops it. Returns the staged state or null. */
export function stageOrchestrationModeSwitchNotice(session, from, to) {
  const prior = session.orchestrationModeSwitch;
  const told = prior ? prior.from : from;
  if (!to || told === to) {
    delete session.orchestrationModeSwitch;
    return null;
  }
  session.orchestrationModeSwitch = {
    version: 1,
    revision: (Number(prior?.revision) || 0) + 1,
    from: told,
    to,
  };
  return session.orchestrationModeSwitch;
}

/**
 * The orchestration mode notice the next user turn carries, or null.
 * @returns {{ revision: number, content: string } | null}
 */
export function snapshotPendingOrchestrationModeNotice(session) {
  const pending = session?.orchestrationModeSwitch;
  if (!pending?.to) return null;
  const overlay = session.orchestrationModeOverlay;
  const content =
    overlay?.mode === pending.to && overlay.content
      ? overlay.content
      : orchestrationModeNoticeContent({ mode: pending.to, carried: true });
  return { revision: pending.revision, content };
}

/** The notice of `revision` reached the model: nothing is due any more. */
export function acknowledgePendingOrchestrationModeNotice(session, revision) {
  if (!session?.orchestrationModeSwitch || session.orchestrationModeSwitch.revision !== Number(revision)) return false;
  delete session.orchestrationModeSwitch;
  return true;
}
