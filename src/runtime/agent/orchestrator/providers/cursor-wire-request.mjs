// Chat-completion request shaping for Cursor: message/content parsing, tool
// definitions and the per-run request context.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { encodeJsonValue } from './cursor-wire-protobuf.mjs';
import { prepareCursorToolDefinition } from './cursor-wire-guards.mjs';

export function deterministicUuid(seed) {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 | (parseInt(hex[16], 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function textContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part?.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n');
}

function imageUrlOf(value) {
  if (value?.type === 'image_url') {
    return typeof value.image_url === 'string' ? value.image_url : value.image_url?.url;
  }
  if (value?.type === 'image' && value.data) {
    return `data:${value.mimeType || value.media_type || 'application/octet-stream'};base64,${value.data}`;
  }
  return '';
}

function imagePart(value) {
  const url = imageUrlOf(value);
  const match = String(url || '').match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  return {
    url,
    mimeType: match[1],
    data: new Uint8Array(Buffer.from(match[2], 'base64')),
  };
}

function rootContent(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const output = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === 'text' && part.text) output.push({ type: 'text', text: part.text });
    else {
      const image = imagePart(part);
      if (image) output.push({ type: 'image', image: image.url, mediaType: image.mimeType });
    }
  }
  return output;
}

// A tool message as the resumable result plus its history entry; the tool
// name comes from the assistant call recorded earlier under the same id.
function toolResultEntry(message, text, toolNames) {
  const toolCallId = message.tool_call_id || '';
  const media = (message.mixdog_tool_media || []).map(imagePart).filter(Boolean);
  const isError = message.mixdog_tool_error === true;
  const toolName = toolNames.get(toolCallId) || '';
  return {
    toolResult: { toolCallId, content: text, media, isError },
    entry: {
      role: 'tool',
      id: toolCallId,
      content: [
        {
          type: 'tool-result',
          toolName,
          toolCallId,
          result: [text, ...media.map((item) => `[${item.mimeType} image]`)].filter(Boolean).join('\n'),
          ...(isError ? { isError: true } : {}),
        },
      ],
    },
  };
}

// An assistant turn's root content with its tool calls appended; records
// each call's name under its id for the results that follow.
function assistantContent(message, toolNames) {
  const content = rootContent(message.content);
  for (const call of message.tool_calls || []) {
    const id = call?.id || '';
    const name = call?.function?.name || '';
    let args = {};
    try {
      args = JSON.parse(call?.function?.arguments || '{}');
    } catch {}
    if (id) toolNames.set(id, name);
    content.push({ type: 'tool-call', toolCallId: id, toolName: name, args });
  }
  return content;
}

// Pops a trailing user turn off the history as the active request.
function activeUserTurn(history) {
  if (history.at(-1)?.role !== 'user') return { userText: '', userImages: [] };
  const active = history.pop();
  return {
    userText: active.text || '',
    userImages: active.content
      .map((part) => (part.type === 'image' ? imagePart({ type: 'image_url', image_url: { url: part.image } }) : null))
      .filter(Boolean),
  };
}

export function parseMessages(messages = []) {
  const systems = [];
  const history = [];
  const toolResults = [];
  const toolNames = new Map();
  for (const message of messages) {
    const text = textContent(message.content);
    if (message.role === 'system' || message.role === 'developer') {
      systems.push(text);
    } else if (message.role === 'tool') {
      const { toolResult, entry } = toolResultEntry(message, text, toolNames);
      toolResults.push(toolResult);
      history.push(entry);
    } else if (message.role === 'assistant') {
      const content = assistantContent(message, toolNames);
      if (content.length) history.push({ role: 'assistant', content });
    } else if (message.role === 'user') {
      history.push({ role: 'user', content: rootContent(message.content), text });
    }
  }
  return { systems: systems.filter(Boolean), history, toolResults, ...activeUserTurn(history) };
}

export function buildToolDefinitions(tools = []) {
  return tools
    .map((tool) => {
      const prepared = prepareCursorToolDefinition(tool);
      return {
        name: prepared.name,
        description: prepared.description,
        inputSchema: encodeJsonValue(prepared.inputSchema),
        inputSchemaJson: JSON.stringify(prepared.inputSchema),
        inputSchemaObject: prepared.inputSchema,
        providerIdentifier: 'mixdog',
        toolName: prepared.name,
      };
    })
    .filter((tool) => tool.name);
}

export function selectToolsForChoice(tools = [], toolChoice) {
  if (toolChoice === 'none') return [];
  const name = toolChoice && typeof toolChoice === 'object' ? toolChoice.function?.name || toolChoice.name : null;
  return typeof name === 'string' && name ? tools.filter((tool) => tool?.function?.name === name) : tools;
}

export function requestModelParameters(body) {
  return (Array.isArray(body?.mixdog_model_parameters) ? body.mixdog_model_parameters : [])
    .map((entry) => ({
      id: String(entry?.id || '').trim(),
      value: String(entry?.value ?? ''),
    }))
    .filter((entry) => entry.id);
}

export function buildRequestContext(tools, cloudRule) {
  return {
    tools,
    mcpInstructions: tools.length
      ? [
          {
            serverName: 'mixdog',
            instructions:
              'Use the tools provided by the mixdog MCP server for this task. ' +
              'Follow their descriptions and input schemas. Prefer them over Cursor native tools; ' +
              'native tools do not directly access the Mixdog environment. ' +
              'If a needed tool is not available, use the provided tool discovery mechanism rather than inventing a tool.',
          },
        ]
      : [],
    ...(cloudRule ? { cloudRule } : {}),
    fileContents: {},
  };
}

export function canReuseRun(active, { tools, cloudRule, modelParameters, maxMode }) {
  const toolContract = (definitions) =>
    new Map(
      definitions.map((tool) => [tool.name, { description: tool.description, inputSchema: tool.inputSchemaObject }])
    );
  const parameters = (values) => new Map(values.map(({ id, value }) => [id, value]));
  return (
    (active.cloudRule || '') === (cloudRule || '') &&
    isDeepStrictEqual(toolContract(active.tools), toolContract(tools)) &&
    isDeepStrictEqual(parameters(active.modelParameters || []), parameters(modelParameters)) &&
    (active.maxMode === true) === maxMode
  );
}
