import { randomUUID } from 'node:crypto';
import { selectedSkillName } from '../../../shared/skill-selection.mjs';
import { executeTool } from './loop/tool-exec.mjs';
import { parseNativeToolSearchPayload } from './loop/tool-helpers.mjs';
import { nativeToolSearchCallFromArguments } from '../providers/custom-tool-wire.mjs';
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

// Called before the first model request for a real user turn. This performs the
// same policy-checked Skill operation, without asking the model to request it.
// Native schemas still travel as a properly paired loader execution, never as
// new eager definitions or an orphan tool_search_output.
export async function prepareExplicitSkills(
  prompt,
  messages,
  session,
  { cwd = session?.cwd, signal, execute = executeTool } = {}
) {
  throwIfAborted(signal);
  const name = selectedSkillName(prompt);
  if (name) {
    const id = `skill-selection-${randomUUID()}`;
    const args = { name };
    const raw = await execute('Skill', args, cwd, session?.id, session, { signal, toolCallId: id });
    const envelope = normalizeToolEnvelope(raw);
    const native = parseNativeToolSearchPayload('Skill', envelope.result);
    const summary = native?.summary || envelope.result;
    if (native && !nativeDefinitionsPresent(native, messages)) {
      // This records the operation actually executed above, with explicit
      // runtime provenance; it is not a fabricated model decision.
      const call = /^(?:openai|openai-oauth)$/.test(native.provider)
        ? nativeToolSearchCallFromArguments(id, args)
        : { id, name: 'Skill', arguments: args };
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
  }
  throwIfAborted(signal);
}
