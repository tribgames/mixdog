import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import {
  contextMessagesSignature,
  estimateMessageTokens,
  estimateToolSchemaTokens,
  messageAttachmentBreakdown,
  reminderSectionBucket,
  splitMarkdownSections,
  stripSystemReminder,
  toolSchemaSignature,
} from '../runtime/agent/orchestrator/session/context-utils.mjs';
import { estimateTokens } from '../runtime/agent/orchestrator/session/token-estimate.mjs';
import { latestSkillBodies } from '../runtime/agent/orchestrator/context/skill-state.mjs';
import {
  classifySyntheticUserMessage,
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
  'signature',
  'thinkingSignature',
  'thoughtSignature',
  'thought_signature',
  'encrypted_content',
  'encryptedContent',
  'encrypted_reasoning',
  'encryptedReasoning',
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

function runtimeAuthored(message, text) {
  if (!text.trim()) return false;
  if (text.trimStart().startsWith('<system-reminder>') || RUNTIME_CONTROL_OPEN.test(text)) return true;
  // The envelope exists only on the provider-bound copy; the transcript this
  // inspector reads is the STORED one, where an async task notification or a
  // recovery row is a bare role:'user' string and was counted as the person's
  // own words (user: 이건뭐지 잘못된건가). Ask the same classifier the wire
  // projection uses, so both agree with or without the envelope.
  return classifySyntheticUserMessage(message) === SYNTHETIC_USER_KINDS.RUNTIME_CONTROL;
}

// Prompt-head manifests arrive as XML blocks with no markdown heading, so the
// section split glued each one onto whatever ran before it and it read as a
// nameless slice of the system prompt (user: available-deferred-tools도 애매하게
// 지금 따로분류되어있고). Carve them out first and give each its own name.
const NAMED_PROMPT_BLOCKS = [
  { tag: 'available-deferred-tools', label: 'Deferred tool list' },
  { tag: 'mcp-instructions', label: 'MCP instructions' },
];
const ATTACHMENT_LABEL_LIMIT = 3;

function markdownSections(text) {
  return splitMarkdownSections(text).map((section) => ({ text: section, label: '' }));
}

function promptSections(text) {
  const named = [];
  let rest = String(text || '');
  for (const block of NAMED_PROMPT_BLOCKS) {
    rest = rest.replace(new RegExp(`<${block.tag}>[\\s\\S]*?</${block.tag}>`, 'gi'), (match) => {
      named.push({ text: match, label: block.label });
      return '';
    });
  }
  return [...markdownSections(rest), ...named];
}

function reminderSections(text) {
  return markdownSections(
    stripSystemReminder(text.replace(RUNTIME_CONTROL_OPEN, '').replace(RUNTIME_CONTROL_CLOSE, ''))
  );
}

// An attachment row names what it carries — image dimensions, document types —
// and stops before the label itself becomes the widest thing in the list.
function attachmentLabel(items) {
  const shown = items.slice(0, ATTACHMENT_LABEL_LIMIT).map((item) => item.label || item.kind);
  if (items.length > ATTACHMENT_LABEL_LIMIT) shown.push(`+${items.length - ATTACHMENT_LABEL_LIMIT}`);
  return label(shown.join(' · '));
}

// One line per attachment: what it is, what the wire said about it, and the
// allowance it costs. Never "image image 2000".
function attachmentPreview(items) {
  return items
    .map((item) => [item.kind, item.label, `≈${item.tokens.toLocaleString()}`].filter(Boolean).join(' · '))
    .join('\n');
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
  return JSON.stringify(
    value,
    (key, item) => {
      if (OPAQUE_FIELDS.has(key) && typeof item === 'string') return '[Opaque data omitted]';
      if (item?.type === 'base64') return '[Binary data omitted]';
      return item;
    },
    2
  );
}

// Project readable fields, never serialize a whole message or provider replay envelope.
function readableContent(content) {
  if (typeof content === 'string') return content;
  let blocks = [];
  if (Array.isArray(content)) blocks = content;
  else if (content) blocks = [content];
  return blocks
    .map((block) => {
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
    })
    .join('\n');
}

// Replay items are the provider-native copy of the same turn: the wire resends
// them INSTEAD of content/toolCalls, so their text and tool-call blocks repeat
// what the projected content already shows (user: 연속두번들어가는게 맞는건가).
// Only their reasoning blocks add anything to the preview.
const REPLAYED_CONTENT_TYPES = new Set(['text', 'tool_use', 'toolCall', 'message', 'function_call', 'output_text']);

function replayReasoning(items) {
  return items.filter((block) => !REPLAYED_CONTENT_TYPES.has(block?.type));
}

function messagePreview(message) {
  const parts = [readableContent(message.content)];
  if (message.toolCalls?.length) {
    parts.push(
      ...message.toolCalls.map(
        (call) =>
          `${call.name || call.function?.name || 'tool'}\n${previewJson(call.arguments ?? call.function?.arguments)}`
      )
    );
  }
  const reasoning = message.providerReplay?.items ?? message.thinkingBlocks ?? message.reasoningItems;
  if (reasoning?.length) parts.push(readableContent(replayReasoning(reasoning)));
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
  if (!Number.isInteger(count) || count < 0 || !(measured > 0))
    return { source: 'estimate', estimatedTokens: rawTotal };
  const covered = drafts.filter((draft) => draft.messageIndex === undefined || draft.messageIndex < count);
  const coveredRaw = covered.reduce((sum, draft) => sum + draft.tokens, 0);
  if (coveredRaw <= 0) return { source: 'estimate', estimatedTokens: rawTotal };
  const ratio = measured / coveredRaw;
  if (ratio < CALIBRATION_MIN || ratio > CALIBRATION_MAX) {
    return { source: 'estimate', estimatedTokens: rawTotal, rejectedRatio: Math.round(ratio * 1000) / 1000 };
  }
  const shares = contextShares(
    covered.map((draft) => draft.tokens),
    Math.round(measured)
  );
  covered.forEach((draft, index) => {
    draft.tokens = shares[index];
  });
  for (const draft of drafts) {
    if (draft.messageIndex !== undefined && draft.messageIndex >= count)
      draft.tokens = Math.round(draft.tokens * ratio);
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
// One draft per section of a system prompt or runtime reminder, each priced
// by its share of the message. A reminder is the system speaking inside a
// user-role row: it belongs to the system messages, marked by its own group.
function sectionDrafts(sections, index, tokens, reminder) {
  const shares = contextShares(
    sections.map((section) => estimateTokens(section.text)),
    tokens
  );
  return sections.map((section, sectionIndex) => {
    const heading = section.text.match(/^#\s+([^\n]+)/)?.[1] || (reminder ? 'System reminder' : 'System prompt');
    const bucket = reminderSectionBucket(section.text);
    const skillLabel = SKILL_SECTION_LABELS.get(heading.trim().toLowerCase());
    let category = 'system';
    if (bucket === 'memory') category = 'memory';
    else if (skillLabel) category = 'skills';
    return {
      id: `message:${index}:section:${sectionIndex}`,
      category,
      group: reminder ? 'reminder' : 'instruction',
      label: label(section.label || skillLabel || heading),
      tokens: shares[sectionIndex],
      kind: 'instruction',
      messageIndex: index,
      preview: () => section.text,
    };
  });
}

// An attachment is priced on its pixels or its bytes, not on the text it
// travels with, so it leaves the carrier row and becomes its own. The two
// halves still sum to what the message costs.
function attachmentDraft(attachments, index, { role = '', ordinal = 0, name = '' } = {}) {
  if (!attachments.tokens) return null;
  return {
    id: `message:${index}:attachment`,
    category: 'attachments',
    group: role || 'instruction',
    label: attachmentLabel(attachments.items),
    tokens: attachments.tokens,
    kind: 'attachment',
    messageIndex: index,
    ...(role ? { role } : {}),
    ...(ordinal ? { ordinal } : {}),
    ...(name ? { name } : {}),
    preview: () => attachmentPreview(attachments.items),
  };
}

// The drafts for every transcript message. Ordinals count turns per role, not
// transcript positions: an assistant row reads "Assistant 3" whether or not
// reminders and tool results sit between it and "Assistant 2". Tool results
// are numbered per tool instead, so one tool's whole cost reads off a single
// group. The turn keeps a name-only trace of the tools it called, so the pair
// still reads as one turn while the sizes live on the tool rows themselves.
function skillDraft(skill, message, index, tokens) {
  return {
    id: `message:${index}`,
    category: 'skills',
    group: 'instruction',
    label: label(skill.name),
    tokens,
    kind: 'instruction',
    messageIndex: index,
    preview: () => messagePreview(message),
  };
}

// A tool result answers the turn that called it, but its size is the
// tool's doing, not the model's. It rides as its own row grouped under the
// producing tool, so the group head reads as that tool's whole share.
function toolResultDraft(message, index, tokens, toolName, ordinal) {
  return {
    id: `message:${index}`,
    category: 'toolResults',
    group: toolName,
    name: toolName,
    ordinal,
    label: label(`${toolName} · ${ordinal}`),
    tokens,
    kind: 'toolResult',
    messageIndex: index,
    preview: () => messagePreview(message),
  };
}

function turnDraft(message, index, tokens, { role, group, ordinal, name }) {
  const category = role === 'system' || role === 'user' ? role : 'assistant';
  return {
    id: `message:${index}`,
    category,
    group,
    label: label(`${role} · ${ordinal}${name ? ` · ${name}` : ''}`),
    role,
    ordinal,
    ...(name ? { name: label(name) } : {}),
    tokens,
    kind: 'message',
    messageIndex: index,
    results: [],
    preview: () => messagePreview(message),
  };
}

// Per-key running ordinal (first call for a key answers 1).
function ordinalCounter() {
  const ordinals = new Map();
  return (key) => {
    const ordinal = (ordinals.get(key) || 0) + 1;
    ordinals.set(key, ordinal);
    return ordinal;
  };
}

// Runtime-authored reminders and system prompts split into named sections;
// every other message is one draft.
function frameSections(message, text, reminder) {
  if (reminder) return reminderSections(text);
  if (message.role === 'system') return promptSections(text);
  return [];
}

// Assistant turns carried their tool results as a working list; publish it
// as `toolResults` and drop the scratch field.
function finalizeToolResults(drafts) {
  for (const draft of drafts) {
    if (!draft.results) continue;
    if (draft.results.length) draft.toolResults = draft.results.map(({ name, tokens }) => ({ name, tokens }));
    delete draft.results;
  }
}

function messageDrafts(messages) {
  const drafts = [];
  const callNames = toolCallNames(messages);
  const nextOrdinal = ordinalCounter();
  let openTurn = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const attachments = messageAttachmentBreakdown(message);
    const tokens = estimateMessageTokens(message) - attachments.tokens;
    const pushAttachment = (identity) => {
      const draft = attachmentDraft(attachments, index, identity);
      if (draft) drafts.push(draft);
    };
    const skill = latestSkillBodies([message])[0];
    const text = typeof message.content === 'string' ? message.content : '';
    const reminder = message.role === 'user' && runtimeAuthored(message, text);
    const sections = frameSections(message, text, reminder);
    if (sections.length) {
      drafts.push(...sectionDrafts(sections, index, tokens, reminder));
      pushAttachment();
      continue;
    }
    if (skill) {
      drafts.push(skillDraft(skill, message, index, tokens));
      pushAttachment();
      continue;
    }
    const role = String(message.role || 'message');
    if (role === 'tool') {
      const toolName = label(callNames.get(String(message.toolCallId || '')) || message.name || 'tool');
      const ordinal = nextOrdinal(`tool:${toolName}`);
      drafts.push(toolResultDraft(message, index, tokens, toolName, ordinal));
      if (openTurn) openTurn.results.push({ name: toolName, tokens });
      pushAttachment({ role: 'tool', ordinal, name: toolName });
      continue;
    }
    openTurn = null;
    const summary = role === 'user' && text.startsWith(SUMMARY_PREFIX);
    const group = summary ? 'summary' : role;
    const ordinal = nextOrdinal(group);
    const name = message.name ? String(message.name) : '';
    const draft = turnDraft(message, index, tokens, { role, group, ordinal, name });
    drafts.push(draft);
    pushAttachment({ role, ordinal, name: name ? label(name) : '' });
    if (role === 'assistant') openTurn = draft;
  }
  finalizeToolResults(drafts);
  return drafts;
}

// One draft per tool definition, priced by its share of the schema tokens.
//   native: provider built-in, sent as the provider's own definition.
//   deferred: definition rides the wire flagged defer_loading; the API
//     excludes it from context until the model loads it, so it costs 0.
//   loaded: was deferrable but has been loaded this session and now counts.
//   active: always sent in full.
function toolDrafts(tools, deferredCatalogNames) {
  const nativeCount = providerNativeToolPrefixCount(tools);
  const catalogNames = deferredCatalogNames instanceof Set ? deferredCatalogNames : new Set(deferredCatalogNames || []);
  const toolWeights = tools.map((tool, index) => {
    if (isDeferredTool(tool)) return 0;
    return estimateToolSchemaTokens(index < nativeCount ? finalizeProviderRequestTools([tool], 1) : [tool]);
  });
  const schemaTokens = estimateToolSchemaTokens(tools);
  const toolShares = contextShares(toolWeights, schemaTokens);
  const drafts = tools.map((tool, index) => {
    const bucket = toolSchemaBucket(tool);
    // The agent tool is a built-in schema like any other; its `agents` bucket
    // must not file it under "Custom agents" (user: AGENT 도구가 분류가 이상하게).
    const category = ['mcp', 'memory', 'skills'].includes(bucket) ? bucket : 'tools';
    const name = String(tool.name || '');
    let state = 'active';
    if (index < nativeCount) state = 'native';
    else if (isDeferredTool(tool)) state = 'deferred';
    else if (catalogNames.has(name)) state = 'loaded';
    return {
      id: `tool:${index}`,
      category,
      group: state,
      state,
      label: label(tool.name || tool.type || `Tool ${index + 1}`),
      tokens: toolShares[index],
      kind: 'tool',
      preview: () => {
        if (index < nativeCount) return previewJson(tool);
        return previewJson({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema ?? tool.input_schema ?? tool.parameters ?? tool.schema,
          ...(isDeferredTool(tool) ? { defer_loading: true } : {}),
        });
      },
    };
  });
  return { drafts, schemaTokens, sharedTokens: toolShares.reduce((sum, tokens) => sum + tokens, 0) };
}

function entryPreview(drafts, options, revision) {
  const entry = drafts.find((item) => item.id === options.entryId);
  if (options.revision !== revision || !entry) {
    return { id: options.entryId, stale: true, text: '', truncated: false };
  }
  const text = terminalText(entry.preview());
  return { id: entry.id, text: text.slice(0, PREVIEW_LIMIT), truncated: text.length > PREVIEW_LIMIT, stale: false };
}

export function inspectContext(
  { sessionId, provider, model, messages, tools, overheadTokens = 0, coverage = null, deferredCatalogNames = null },
  options = {}
) {
  const revision = createHash('sha256')
    .update(
      JSON.stringify([sessionId, provider, model, contextMessagesSignature(messages), toolSchemaSignature(tools)])
    )
    .digest('hex');
  const drafts = messageDrafts(messages);
  const toolSurface = toolDrafts(tools, deferredCatalogNames);
  drafts.push(...toolSurface.drafts);
  const framing = overheadTokens + toolSurface.schemaTokens - toolSurface.sharedTokens;
  if (framing > 0)
    drafts.push({
      id: 'request:framing',
      category: 'tools',
      group: 'overhead',
      label: 'Request framing',
      kind: 'overhead',
      tokens: framing,
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
    revision,
    categories,
    entries,
    calibration,
    estimatedTokens: categories.reduce((sum, row) => sum + row.tokens, 0),
  };
  if (options.entryId !== undefined) result.preview = entryPreview(drafts, options, revision);
  return result;
}
