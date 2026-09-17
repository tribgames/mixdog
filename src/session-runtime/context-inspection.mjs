import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import {
  contextMessagesSignature,
  estimateMessageTokens,
  estimateToolSchemaTokens,
  reminderSectionBucket,
  splitMarkdownSections,
  stripSystemReminder,
  toolSchemaSignature,
} from '../runtime/agent/orchestrator/session/context-utils.mjs';
import { estimateTokens } from '../runtime/agent/orchestrator/session/token-estimate.mjs';
import { latestSkillBodies } from '../runtime/agent/orchestrator/context/skill-state.mjs';
import {
  SYNTHETIC_USER_ENVELOPE_TAG,
  SYNTHETIC_USER_KINDS,
} from '../runtime/agent/orchestrator/session/synthetic-user-envelope.mjs';
import { toolSchemaBucket } from './tool-catalog-schema.mjs';
import { finalizeProviderRequestTools, providerNativeToolPrefixCount } from './provider-request-tools.mjs';
import { CONTEXT_CATEGORIES, contextShares } from '../ui/context-inspection.mjs';
import { SUMMARY_PREFIX } from '../runtime/agent/orchestrator/session/compact.mjs';

const PREVIEW_LIMIT = 32_000;
// A provider reading this far from the local estimate is not describing the
// same request (tool surface swapped, stale anchor); keep the raw estimates.
const CALIBRATION_MIN = 0.25;
const CALIBRATION_MAX = 3;
const OPAQUE_FIELDS = new Set([
  'signature', 'thinkingSignature', 'thoughtSignature', 'thought_signature',
  'encrypted_content', 'encryptedContent', 'encrypted_reasoning', 'encryptedReasoning',
]);
// Runtime-authored role:'user' rows — a bare <system-reminder>, or the
// <mixdog-runtime kind="runtime-control"> envelope the wire projection wraps
// one in — are context the runtime sent, not words the person typed. They read
// as system prompt sections, so the message rows stay the real conversation.
const RUNTIME_CONTROL_OPEN = new RegExp(
  `^\\s*<${SYNTHETIC_USER_ENVELOPE_TAG}\\s+kind="${SYNTHETIC_USER_KINDS.RUNTIME_CONTROL}"[^>]*>`,
  'i'
);
const RUNTIME_CONTROL_CLOSE = new RegExp(`</${SYNTHETIC_USER_ENVELOPE_TAG}>\\s*$`, 'i');
// Both skill sections of the prompt head with a bare "Skills" /
// "available-skills" line, which reads like the Skill tool definition sitting
// next to them in the same category; name what each row actually holds.
const SKILL_SECTION_LABELS = new Map([
  ['skills', 'Skill instructions'],
  ['available-skills', 'Available skills'],
]);

function runtimeAuthored(text) {
  return text.trimStart().startsWith('<system-reminder>') || RUNTIME_CONTROL_OPEN.test(text);
}

function reminderSections(text) {
  return splitMarkdownSections(
    stripSystemReminder(text.replace(RUNTIME_CONTROL_OPEN, '').replace(RUNTIME_CONTROL_CLOSE, ''))
  );
}

function terminalText(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

function label(value) {
  return terminalText(value).replace(/\s+/g, ' ').trim().slice(0, 120);
}

function previewJson(value) {
  return JSON.stringify(value, (key, item) => {
    if (OPAQUE_FIELDS.has(key) && typeof item === 'string') return '[Opaque data omitted]';
    if (item?.type === 'base64') return '[Binary data omitted]';
    return item;
  }, 2);
}

// Project readable fields, never serialize a whole message or provider replay envelope.
function readableContent(content) {
  if (typeof content === 'string') return content;
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  return blocks.map((block) => {
    if (typeof block === 'string') return block;
    if (['image', 'image_url', 'input_image'].includes(block?.type)) return '[Image omitted]';
    if (['document', 'file', 'input_file'].includes(block?.type)) return '[File omitted]';
    if (block?.type === 'redacted_thinking') return '[Opaque reasoning omitted]';
    if (block?.type === 'tool_result') return readableContent(block.content);
    if (block?.type === 'tool_use' || block?.type === 'toolCall') {
      return `${block.name || 'tool'}\n${previewJson(block.input ?? block.arguments)}`;
    }
    if (typeof block?.text === 'string') return block.text;
    if (typeof block?.thinking === 'string') return block.thinking;
    if (Array.isArray(block?.summary)) return readableContent(block.summary);
    return '[Non-text content omitted]';
  }).join('\n');
}

function messagePreview(message) {
  const parts = [readableContent(message.content)];
  if (message.toolCalls?.length) {
    parts.push(...message.toolCalls.map((call) =>
      `${call.name || call.function?.name || 'tool'}\n${previewJson(call.arguments ?? call.function?.arguments)}`
    ));
  }
  const reasoning = message.providerReplay?.items ?? message.thinkingBlocks ?? message.reasoningItems;
  if (reasoning?.length) parts.push(readableContent(reasoning));
  return parts.filter(Boolean).join('\n\n');
}

// Tool results name the call they answer, not the tool; recover the tool name
// from the assistant turn that issued the call so results group per tool.
function toolCallNames(messages) {
  const names = new Map();
  for (const message of messages) {
    if (message?.role !== 'assistant') continue;
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const name = call?.name || call?.function?.name;
      if (call?.id && name) names.set(String(call.id), String(name));
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if ((block?.type === 'tool_use' || block?.type === 'toolCall') && block.id && block.name) {
        names.set(String(block.id), String(block.name));
      }
    }
  }
  return names;
}

function isDeferredTool(tool) {
  return tool?.deferLoading === true || tool?.defer_loading === true;
}

// Reconcile per-item estimates with the provider's own count for the prefix it
// measured. Everything the reading covered is redistributed so it sums exactly
// to the measurement; items appended since scale by the same ratio. Ratios
// outside the plausible band mean the reading is not about this request.
function calibrateDrafts(drafts, coverage) {
  const rawTotal = drafts.reduce((sum, draft) => sum + draft.tokens, 0);
  for (const draft of drafts) draft.estimatedTokens = draft.tokens;
  const count = Number(coverage?.count);
  const measured = Number(coverage?.tokens);
  if (!Number.isInteger(count) || count < 0 || !(measured > 0)) return { source: 'estimate', estimatedTokens: rawTotal };
  const covered = drafts.filter((draft) => draft.messageIndex === undefined || draft.messageIndex < count);
  const coveredRaw = covered.reduce((sum, draft) => sum + draft.tokens, 0);
  if (coveredRaw <= 0) return { source: 'estimate', estimatedTokens: rawTotal };
  const ratio = measured / coveredRaw;
  if (ratio < CALIBRATION_MIN || ratio > CALIBRATION_MAX) {
    return { source: 'estimate', estimatedTokens: rawTotal, rejectedRatio: Math.round(ratio * 1000) / 1000 };
  }
  const shares = contextShares(covered.map((draft) => draft.tokens), Math.round(measured));
  covered.forEach((draft, index) => { draft.tokens = shares[index]; });
  for (const draft of drafts) {
    if (draft.messageIndex !== undefined && draft.messageIndex >= count) draft.tokens = Math.round(draft.tokens * ratio);
  }
  return {
    source: 'provider',
    measuredTokens: Math.round(measured),
    ratio: Math.round(ratio * 1000) / 1000,
    coveredMessages: count,
    estimatedTokens: rawTotal,
  };
}

// Only explicit inspection requests build entries. Raw previews are neither cached
// with status nor persisted on the session, and are returned only for one selected id.
export function inspectContext(
  { sessionId, provider, model, messages, tools, overheadTokens = 0, coverage = null, deferredCatalogNames = null },
  options = {}
) {
  const revision = createHash('sha256')
    .update(JSON.stringify([sessionId, provider, model, contextMessagesSignature(messages), toolSchemaSignature(tools)]))
    .digest('hex');
  const drafts = [];
  const callNames = toolCallNames(messages);
  // Ordinals count turns per role, not transcript positions: an assistant row
  // reads "Assistant 3" whether or not reminders and tool results sit between
  // it and "Assistant 2". Tool results are not turns of their own — they are
  // the answer half of the assistant turn that issued the call, so they fold
  // into that row and count toward it.
  const ordinals = new Map();
  let openTurn = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const tokens = estimateMessageTokens(message);
    const skill = latestSkillBodies([message])[0];
    const text = typeof message.content === 'string' ? message.content : '';
    const reminder = message.role === 'user' && runtimeAuthored(text);
    const sections = reminder
      ? reminderSections(text)
      : message.role === 'system' ? splitMarkdownSections(text) : [];
    if (sections.length) {
      const shares = contextShares(sections.map(estimateTokens), tokens);
      sections.forEach((section, sectionIndex) => {
        const heading = section.match(/^#\s+([^\n]+)/)?.[1] || (reminder ? 'System reminder' : 'System prompt');
        const bucket = reminderSectionBucket(section);
        const skillLabel = SKILL_SECTION_LABELS.get(heading.trim().toLowerCase());
        const category = bucket === 'memory' ? 'memory' : skillLabel ? 'skills' : 'system';
        drafts.push({
          id: `message:${index}:section:${sectionIndex}`, category, group: reminder ? 'reminder' : 'instruction',
          label: label(skillLabel || heading), tokens: shares[sectionIndex], kind: 'instruction', messageIndex: index,
          preview: () => section,
        });
      });
      continue;
    }
    if (skill) {
      drafts.push({
        id: `message:${index}`, category: 'skills', group: 'instruction', label: label(skill.name),
        tokens, kind: 'instruction', messageIndex: index, preview: () => messagePreview(message),
      });
      continue;
    }
    const role = String(message.role || 'message');
    if (role === 'tool' && openTurn) {
      const toolName = callNames.get(String(message.toolCallId || '')) || (message.name ? String(message.name) : '');
      openTurn.tokens += tokens;
      openTurn.results.push({ index, name: toolName, tokens, message });
      // The turn's coverage is the last message it spans, so calibration
      // treats a turn with one uncovered tool result as appended, not measured.
      openTurn.messageIndex = index;
      continue;
    }
    if (role !== 'tool') openTurn = null;
    const summary = role === 'user' && text.startsWith(SUMMARY_PREFIX);
    const group = summary ? 'summary' : role;
    const ordinal = (ordinals.get(group) || 0) + 1;
    ordinals.set(group, ordinal);
    const name = message.name ? String(message.name) : '';
    const results = [];
    const draft = {
      id: `message:${index}`, category: role === 'system' ? 'system' : 'messages', group,
      label: label(`${role} · ${ordinal}${name ? ` · ${name}` : ''}`),
      role, ordinal, ...(name ? { name: label(name) } : {}),
      tokens, kind: 'message', messageIndex: index, results,
      preview: () => [
        messagePreview(message),
        ...results.map((result) => `── ${result.name || 'tool'} ──\n${messagePreview(result.message)}`),
      ].filter(Boolean).join('\n\n'),
    };
    drafts.push(draft);
    if (role === 'assistant') openTurn = draft;
  }
  // Tool results ride out as names + sizes only; the messages themselves stay
  // behind the preview boundary like every other payload.
  for (const draft of drafts) {
    if (!draft.results) continue;
    if (draft.results.length) {
      draft.toolResults = draft.results.map(({ name, tokens }) => ({ name: label(name || 'tool'), tokens }));
    }
    delete draft.results;
  }
  const nativeCount = providerNativeToolPrefixCount(tools);
  const catalogNames = deferredCatalogNames instanceof Set ? deferredCatalogNames : new Set(deferredCatalogNames || []);
  const toolWeights = tools.map((tool, index) =>
    isDeferredTool(tool)
      ? 0
      : estimateToolSchemaTokens(index < nativeCount ? finalizeProviderRequestTools([tool], 1) : [tool])
  );
  const schemaTokens = estimateToolSchemaTokens(tools);
  const toolShares = contextShares(toolWeights, schemaTokens);
  tools.forEach((tool, index) => {
    const bucket = toolSchemaBucket(tool);
    const category = ['mcp', 'agents', 'memory', 'skills'].includes(bucket) ? bucket : 'tools';
    // native: provider built-in, sent as the provider's own definition.
    // deferred: definition rides the wire flagged defer_loading; the API
    //   excludes it from context until the model loads it, so it costs 0.
    // loaded: was deferrable but has been loaded this session and now counts.
    // active: always sent in full.
    const name = String(tool.name || '');
    const state = index < nativeCount ? 'native' : isDeferredTool(tool) ? 'deferred' : catalogNames.has(name) ? 'loaded' : 'active';
    drafts.push({
      id: `tool:${index}`, category, group: state, state, label: label(tool.name || tool.type || `Tool ${index + 1}`),
      tokens: toolShares[index], kind: 'tool',
      preview: () => previewJson(index < nativeCount ? tool : {
        name: tool.name, description: tool.description,
        input_schema: tool.inputSchema ?? tool.input_schema ?? tool.parameters ?? tool.schema,
        ...(isDeferredTool(tool) ? { defer_loading: true } : {}),
      }),
    });
  });
  const framing = overheadTokens + schemaTokens - toolShares.reduce((sum, tokens) => sum + tokens, 0);
  if (framing > 0) drafts.push({
    id: 'request:framing', category: 'tools', group: 'overhead', label: 'Request framing', kind: 'overhead', tokens: framing,
    preview: () => 'Estimated request framing outside message content and individual tool definitions.',
  });
  const calibration = calibrateDrafts(drafts, coverage);
  const entries = drafts.map(({ preview: _preview, messageIndex: _messageIndex, ...entry }) => entry);
  const categories = CONTEXT_CATEGORIES.map((category) => {
    const children = entries.filter((entry) => entry.category === category.key);
    return {
      ...category,
      tokens: children.reduce((sum, entry) => sum + entry.tokens, 0),
      estimatedTokens: children.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
      count: children.length,
    };
  });
  const result = {
    revision, categories, entries, calibration,
    estimatedTokens: categories.reduce((sum, row) => sum + row.tokens, 0),
  };
  if (options.entryId !== undefined) {
    const entry = drafts.find((item) => item.id === options.entryId);
    if (options.revision !== revision || !entry) {
      result.preview = { id: options.entryId, stale: true, text: '', truncated: false };
    } else {
      const text = terminalText(entry.preview());
      result.preview = { id: entry.id, text: text.slice(0, PREVIEW_LIMIT), truncated: text.length > PREVIEW_LIMIT, stale: false };
    }
  }
  return result;
}
