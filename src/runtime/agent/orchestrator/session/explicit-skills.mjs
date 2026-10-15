import { randomUUID } from 'node:crypto';
import { selectedSkillName } from '../../../shared/skill-selection.mjs';
import { mentionedSkillNames, skillMentionCandidates } from '../../../shared/skill-mentions.mjs';
import { isAttachmentReference } from '../../../attachments/store.mjs';
import { collectPromptSkillsCached } from '../context/collect.mjs';
import { executeTool } from './loop/tool-exec.mjs';
import { preDispatchDenyForSession } from './loop/pre-dispatch-deny.mjs';
import { parseNativeToolSearchPayload } from './loop/tool-helpers.mjs';
import { normalizeToolEnvelope } from './tool-envelope.mjs';
import { throwIfAborted } from '../../../shared/abort-race.mjs';

function nativeDefinitionsPresent(native, messages) {
  return native.toolReferences.every((name) =>
    messages.some(
      (message) =>
        message.nativeToolSearch?.provider === native.provider &&
        message.nativeToolSearch.toolReferences?.includes(name) &&
        native.openaiTools.every(
          (tool) =>
            tool.name !== name ||
            message.nativeToolSearch.openaiTools?.some((previous) => JSON.stringify(previous) === JSON.stringify(tool))
        )
    )
  );
}

// At most this many skills are prepared for one user turn; further selections
// stay prose.
const MAX_EXPLICIT_SKILLS = 5;
const LOADED_SKILL_RE = /^Loaded (?:built-in )?skill: /;

// The user's own typed text: plain strings and text parts, never attachment
// references (file contents the user attached, not words they typed).
function userPromptText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) return '';
  return prompt
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' && typeof part.text === 'string' && !isAttachmentReference(part)) return part.text;
      return '';
    })
    .join('\n');
}

/** The skills a prompt explicitly selects: the leading `Skill: "name"` header,
 *  then every inline `$name`, each only when it names a skill enabled and in
 *  scope for `cwd`, in first-mention order, deduplicated and capped. */
export function explicitSkillNames(prompt, cwd) {
  const header = selectedSkillName(prompt);
  const text = userPromptText(prompt);
  if (!header && !skillMentionCandidates(text).length) return [];
  const available = new Set(collectPromptSkillsCached(cwd).map((skill) => skill.name));
  const isSkill = (name) => available.has(name);
  const names = header && isSkill(header) ? [header] : [];
  for (const name of mentionedSkillNames(text, isSkill)) {
    if (!names.includes(name)) names.push(name);
  }
  return names.slice(0, MAX_EXPLICIT_SKILLS);
}

/** Stamps the skills a user turn actually loaded on its transcript metadata,
 *  where the live row, the persisted transcript and restore all read it.
 *  The stamped message REPLACES `message` in `messages` (returned): the
 *  session store ships reference-identical messages as an append-only delta,
 *  so an in-place edit of a user message an earlier save already sent would
 *  never reach disk. */
export function recordAppliedSkills(messages, message, names) {
  if (!message || !Array.isArray(names) || !names.length) return message;
  const meta = message.meta && typeof message.meta === 'object' ? message.meta : {};
  const transcript = meta.transcript && typeof meta.transcript === 'object' ? meta.transcript : {};
  const stamped = { ...message, meta: { ...meta, transcript: { ...transcript, appliedSkills: [...names] } } };
  const index = Array.isArray(messages) ? messages.indexOf(message) : -1;
  if (index >= 0) messages[index] = stamped;
  return stamped;
}

/** Tells the host which skills a user turn loaded; a host callback failure
 *  never fails the turn. */
export function notifySkillsApplied(onSkillsApplied, applied, message) {
  if (!applied.length) return;
  try {
    onSkillsApplied?.(applied, { messageId: message?.meta?.transcript?.messageId || null });
  } catch {
    /* best-effort host callback */
  }
}

// Called before the first model request for a real user turn. This performs the
// same policy-checked Skill operation, without asking the model to request it.
// Native schemas still travel as a properly paired loader execution, never as
// new eager definitions or an orphan tool_search_output. Returns the names of
// the skills that loaded successfully, in selection order.
// `selection`, when given (even empty), is the turn's TRUSTED selection input
// and the only text skills are selected from: a host whose model-visible
// prompt carries external data (webhook payloads) passes just the
// operator-authored part, so nothing inside the data can load a skill.
export async function prepareExplicitSkills(
  prompt,
  messages,
  session,
  { cwd = session?.cwd, signal, execute = executeTool, selection } = {}
) {
  throwIfAborted(signal);
  const applied = [];
  // A session that cannot call Skill (schema allowlist, denied tools, read-only
  // surface — the dispatcher's own gate) has nothing to select: preparing would
  // only push a refused-tool reminder into history on every matching turn.
  if (preDispatchDenyForSession(session, { name: 'Skill' })) return applied;
  const source = selection === undefined || selection === null ? prompt : selection;
  for (const name of explicitSkillNames(source, cwd)) {
    const id = `skill-selection-${randomUUID()}`;
    const args = { name };
    const raw = await execute('Skill', args, cwd, session?.id, session, { signal, toolCallId: id });
    const envelope = normalizeToolEnvelope(raw);
    const native = parseNativeToolSearchPayload('Skill', envelope.result);
    const summary = native?.summary || envelope.result;
    if (native && !nativeDefinitionsPresent(native, messages)) {
      // This records the operation actually executed above, with explicit
      // runtime provenance; it is not a fabricated model decision.
      const call = { id, name: 'Skill', arguments: args };
      messages.push(
        { role: 'assistant', content: '', toolCalls: [call], meta: { source: 'skill-selection', synthetic: true } },
        { role: 'tool', toolCallId: id, content: summary, nativeToolSearch: native }
      );
    } else {
      messages.push({
        role: 'user',
        meta: { source: 'skill-context' },
        content: `<system-reminder>\nExplicit skill selection result:\n${typeof summary === 'string' ? summary : JSON.stringify(summary)}\n</system-reminder>`,
      });
    }
    messages.push(...envelope.newMessages);
    if (LOADED_SKILL_RE.test(String(summary))) applied.push(name);
    throwIfAborted(signal);
  }
  return applied;
}
