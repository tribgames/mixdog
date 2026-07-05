/**
 * gemini-schema.mjs — Gemini request-shape conversion: JSON Schema → Gemini
 * FunctionDeclarationSchema, tool/tool-config mapping, message → content
 * mapping, tool-call parsing/emission, and grounding-source collection.
 *
 * Extracted from gemini.mjs (no behavior change). Pure functions only — no
 * module state. gemini.mjs re-exports parseToolCalls / emitGeminiToolCalls /
 * collectGeminiGroundingSources so existing importers (tests, gemini-stream)
 * keep resolving through the facade.
 */
import { SchemaType } from '@google/generative-ai';
import { traceHash, stableTraceStringify } from './trace-utils.mjs';
import { normalizeContentForGeminiParts, splitToolContentForGemini } from './media-normalization.mjs';

/**
 * Convert JSON Schema type string to Gemini SchemaType.
 * Gemini SDK uses its own enum instead of plain strings.
 */
function toSchemaType(t) {
    const map = {
        string: SchemaType.STRING,
        number: SchemaType.NUMBER,
        integer: SchemaType.INTEGER,
        boolean: SchemaType.BOOLEAN,
        array: SchemaType.ARRAY,
        object: SchemaType.OBJECT,
    };
    return map[t] ?? SchemaType.STRING;
}

/**
 * Recursively convert a JSON Schema object to Gemini's FunctionDeclarationSchema.
 * Gemini requires `type` to be a SchemaType enum, not a plain string, and
 * rejects several JSON Schema fields the API does not understand
 * (additionalProperties, $schema, $ref, const, examples, definitions,
 * patternProperties). We strip those at every level.
 */
const GEMINI_SCHEMA_STRIP = new Set([
    'additionalProperties',
    '$schema',
    '$ref',
    'const',
    'examples',
    'definitions',
    'patternProperties',
]);
export function convertSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const result = {};
    for (const [k, v] of Object.entries(schema)) {
        if (GEMINI_SCHEMA_STRIP.has(k)) continue;
        result[k] = v;
    }
    // Gemini's Schema validator requires every `enum` entry to be a string,
    // even when the parent `type` is integer/number/boolean. Drop the enum in
    // that case rather than emit an invalid typed enum — `type` plus the
    // description still guides the model, and the tool handler revalidates.
    const rawType = typeof result.type === 'string' ? result.type : undefined;
    if (Array.isArray(result.enum) && (rawType === 'integer' || rawType === 'number' || rawType === 'boolean')) {
        if (result.enum.some((item) => typeof item !== 'string')) {
            delete result.enum;
        }
    }
    // Gemini rejects array schemas that omit `items`; fill a permissive
    // default so the declaration validates.
    if (rawType === 'array' && (!result.items || typeof result.items !== 'object')) {
        result.items = { type: 'string' };
    }
    if (typeof result.type === 'string') {
        result.type = toSchemaType(result.type);
    }
    if (result.properties && typeof result.properties === 'object') {
        const props = {};
        for (const [key, val] of Object.entries(result.properties)) {
            props[key] = convertSchema(val);
        }
        result.properties = props;
    }
    if (result.items && typeof result.items === 'object') {
        result.items = convertSchema(result.items);
    }
    // Recurse into JSON Schema combinator keys so disallowed fields
    // (additionalProperties, $schema, etc.) get stripped at every nesting
    // level. Without this, schemas using anyOf/oneOf/allOf/not pass the
    // shallow strip but fail Gemini validation at depth.
    //
    // Two Gemini-specific normalizations are also applied per combinator
    // subschema:
    //   1. Inject `type: OBJECT` when a subschema uses object-only keys
    //      (`required` / `properties`) without an explicit type — Gemini
    //      rejects `required` outside of OBJECT type.
    //   2. Materialize a local `properties` map from the parent's properties
    //      when the subschema only carries `required: [names]` — Gemini
    //      validates that every name in `required` exists in *this*
    //      subschema's `properties` (it does not inherit from the parent
    //      the way JSON Schema's compositional model does).
    for (const combinator of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(result[combinator])) {
            result[combinator] = result[combinator].map((s) => {
                const sub = convertSchema(s);
                if (sub && typeof sub === 'object') {
                    const usesObjectKeys = sub.required !== undefined || sub.properties !== undefined;
                    if (usesObjectKeys && sub.type === undefined) {
                        sub.type = toSchemaType('object');
                    }
                    if (Array.isArray(sub.required) && !sub.properties && result.properties) {
                        const projected = {};
                        for (const k of sub.required) {
                            if (result.properties[k]) projected[k] = result.properties[k];
                        }
                        if (Object.keys(projected).length > 0) sub.properties = projected;
                    }
                }
                return sub;
            });
        }
    }
    if (result.not && typeof result.not === 'object') {
        result.not = convertSchema(result.not);
    }
    return result;
}

export function toGeminiTools(tools) {
    return {
        functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: convertSchema(t.inputSchema),
        })),
    };
}
export function toGeminiNativeTools(nativeTools) {
    if (!Array.isArray(nativeTools)) return [];
    const out = [];
    for (const tool of nativeTools) {
        const type = String(tool?.type || '').trim().toLowerCase();
        if (type === 'google_search' || type === 'google_search_retrieval') {
            out.push({ googleSearch: {} });
        }
    }
    return out;
}

// Exported for gemini-stream.mjs (stream consumers collect citations).
export function collectGeminiGroundingSources(candidate) {
    const out = [];
    const seen = new Set();
    const add = (source) => {
        if (!source || typeof source !== 'object') return;
        const web = source.web && typeof source.web === 'object' ? source.web : source;
        const url = String(web.uri || web.url || source.uri || source.url || '').trim();
        if (!url || seen.has(url)) return;
        seen.add(url);
        out.push({
            title: String(web.title || source.title || url).trim(),
            url,
            snippet: '',
            source: 'gemini-grounding',
            provider: 'gemini',
        });
    };
    const grounding = candidate?.groundingMetadata || {};
    for (const chunk of Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks : []) add(chunk);
    const citationMetadata = candidate?.citationMetadata || {};
    for (const source of Array.isArray(citationMetadata.citationSources) ? citationMetadata.citationSources : []) add(source);
    return out;
}

// Map the orchestrator-level toolChoice to Gemini's functionCallingConfig.
//   auto      -> AUTO
//   required  -> ANY
//   none      -> NONE
//   { name }  -> ANY + allowedFunctionNames:[name]   (specific tool)
export function toGeminiToolConfig(toolChoice) {
    if (toolChoice == null) return undefined;
    if (typeof toolChoice === 'string') {
        if (toolChoice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
        if (toolChoice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
        if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
        return undefined;
    }
    if (typeof toolChoice === 'object') {
        const name = toolChoice.name || toolChoice.function?.name;
        if (typeof name === 'string' && name) {
            return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } };
        }
    }
    return undefined;
}

function toGeminiContent(message, toolNameByCallId) {
    if (!message || message.role === 'system') return null;
    if (message.role === 'assistant' && message.toolCalls?.length) {
        const parts = [];
        if (message.content) parts.push(...normalizeContentForGeminiParts(message.content));
        for (const tc of message.toolCalls) {
            // Gemini 3 thinking models require the original thoughtSignature
            // echoed back on every prior functionCall so the cached thinking
            // prefix stays valid. v1beta places the field at the Part level
            // (sibling of functionCall) — putting it inside functionCall returns
            // 400 "Unknown name". Older models / first turn have no signature.
            const part = { functionCall: { name: tc.name, args: tc.arguments } };
            if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature;
            parts.push(part);
        }
        return { role: 'model', parts };
    }
    if (message.role === 'tool') {
        // Tool result content stays byte-identical for cache prefix stability.
        // Gemini accepts functionResponse parts under role 'user' (per docs).
        // Using 'user' keeps tool_result entries byte-identical between
        // cachedContents.create (which rejects role:'function') and
        // generateContent, so the cached prefix actually matches at runtime.
        // functionResponse.name must be the FUNCTION name, not the synthetic
        // toolCallId. Resolve it from the toolCallId->functionName map built
        // from prior assistant tool_calls; fall back to the raw id only when
        // no mapping exists.
        const functionName = (toolNameByCallId && toolNameByCallId.get(message.toolCallId))
            || message.toolCallId
            || '';
        const { response, mediaParts } = splitToolContentForGemini(message.content);
        const parts = [{ functionResponse: { name: functionName, response } }];
        if (mediaParts.length) parts.push(...mediaParts);
        return {
            role: 'user',
            parts,
        };
    }
    return {
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: normalizeContentForGeminiParts(message.content),
    };
}

export function toGeminiContents(messages) {
    const contents = [];
    // Map synthetic toolCallId -> function name from prior assistant
    // tool_calls so each functionResponse part carries the real function name.
    const toolNameByCallId = new Map();
    for (const m of messages) {
        if (m?.role === 'assistant' && Array.isArray(m.toolCalls)) {
            for (const tc of m.toolCalls) {
                if (tc?.id && tc?.name) toolNameByCallId.set(tc.id, tc.name);
            }
        }
    }
    for (const message of messages) {
        const content = toGeminiContent(message, toolNameByCallId);
        if (content) contents.push(content);
    }
    return contents;
}

export function parseToolCalls(parts) {
    const calls = parts.filter((p) => 'functionCall' in p && !!p.functionCall);
    if (!calls.length)
        return undefined;
    // The @google/generative-ai 0.24.1 SDK predates Gemini 3 thinking — its
    // FunctionCall type only declares { name, args }. The runtime object,
    // however, retains whatever the wire response carried, which means the
    // signature may sit under any of:
    //   • part.functionCall.thoughtSignature   (camelCase, expected)
    //   • part.functionCall.thought_signature  (snake_case, raw protobuf)
    //   • part.thoughtSignature / part.thought_signature (sibling on Part)
    // Read all four and use the first non-empty hit. Set MIXDOG_DEBUG_GEMINI=1
    // to dump the raw parts so we can confirm the actual key location on the
    // next session and harden the parser.
    if (process.env.MIXDOG_DEBUG_GEMINI === '1') {
        try { process.stderr.write(`[gemini fc raw] ${JSON.stringify(parts)}\n`); } catch {}
    }
    return calls.map((p, i) => {
        const fc = p.functionCall;
        const sig = fc.thoughtSignature
            || fc.thought_signature
            || p.thoughtSignature
            || p.thought_signature
            || null;
        const idHash = traceHash(stableTraceStringify({
            index: i,
            name: fc.name || '',
            args: fc.args ?? {},
        })).slice(0, 16);
        const call = {
            id: `gemini_${idHash}`,
            name: fc.name,
            arguments: (fc.args ?? {}),
        };
        if (sig) call.thoughtSignature = sig;
        return call;
    });
}

// Exported for gemini-stream.mjs (leak-guard + stream consumers).
export function emitGeminiToolCalls(toolCalls, onToolCall) {
    if (typeof onToolCall !== 'function' || !Array.isArray(toolCalls)) return;
    const emitted = new Set();
    for (const call of toolCalls) {
        if (!call?.id || !call?.name || emitted.has(call.id)) continue;
        emitted.add(call.id);
        try { onToolCall(call); } catch {}
    }
}
