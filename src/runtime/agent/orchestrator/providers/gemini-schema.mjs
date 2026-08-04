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

function explicitGeminiMediaPart(part) {
    if (!part || typeof part !== 'object') return null;
    const inline = part.inlineData || part.inline_data;
    if (typeof inline?.data === 'string' && inline.data) {
        const mimeType = inline.mimeType || inline.mime_type || inline.mediaType || inline.media_type;
        if (typeof mimeType === 'string' && mimeType) {
            return { inlineData: { mimeType, data: inline.data } };
        }
    }
    const file = part.fileData || part.file_data;
    const fileUri = file?.fileUri || file?.file_uri;
    const mimeType = file?.mimeType || file?.mime_type || file?.mediaType || file?.media_type;
    if (typeof fileUri === 'string' && fileUri && typeof mimeType === 'string' && mimeType) {
        return { fileData: { mimeType, fileUri } };
    }
    return null;
}

// The shared normalizer intentionally defaults unknown media to image/png for
// image-oriented providers. Gemini accepts audio/video/document MIME types too,
// so preserve explicit Gemini wire parts before using the shared fallback.
export function normalizeGeminiParts(content) {
    if (typeof content === 'string') return normalizeContentForGeminiParts(content);
    const parts = Array.isArray(content)
        ? content
        : (content && typeof content === 'object' && Array.isArray(content.content)
            ? content.content
            : [content]);
    const out = [];
    for (const part of parts) {
        const media = explicitGeminiMediaPart(part);
        if (media) out.push(media);
        else if (typeof part === 'string') out.push({ text: part });
        else if (part && typeof part === 'object' && typeof part.text === 'string') out.push({ text: part.text });
        else out.push(...normalizeContentForGeminiParts(part));
    }
    return out;
}

function splitGeminiToolContent(content) {
    const normalized = normalizeGeminiParts(content);
    const explicitMedia = normalized.filter((part) => part?.inlineData || part?.fileData);
    if (!explicitMedia.length) return splitToolContentForGemini(content);
    const text = normalized
        .filter((part) => typeof part?.text === 'string')
        .map((part) => part.text)
        .filter(Boolean)
        .join('\n');
    return {
        response: { result: text || '[tool result included media content]' },
        mediaParts: explicitMedia,
    };
}

const GEMINI_FUNCTION_RESPONSE_MIME = /^(?:image\/(?:png|jpeg|webp)|application\/pdf|text\/plain)$/i;

function toGeminiFunctionResponseMedia(mediaParts) {
    const parts = [];
    const refs = [];
    const external = [];
    const omitted = [];
    for (const media of mediaParts || []) {
        const payload = media?.inlineData || media?.fileData;
        const mimeType = String(payload?.mimeType || '').trim();
        if (!GEMINI_FUNCTION_RESPONSE_MIME.test(mimeType)) {
            if (mimeType) omitted.push(mimeType);
            continue;
        }
        const displayName = `tool_media_${parts.length + 1}`;
        if (media.inlineData) {
            parts.push({ inlineData: { ...media.inlineData, mimeType, displayName } });
            refs.push({ $ref: displayName });
        } else {
            // FunctionResponse.parts currently documents inlineData only.
            // fileData is valid in ordinary Content parts but can 400 when
            // nested here, so retain file-backed media as plain JSON metadata.
            external.push({
                mimeType,
                fileUri: String(media.fileData?.fileUri || ''),
            });
        }
    }
    return { parts, refs, external, omitted };
}

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
 * accepts only a documented subset of JSON Schema. Project onto that subset
 * at every level and convert `const` into Gemini's string enum form.
 */
const GEMINI_SCHEMA_FIELDS = new Set([
    'type',
    'format',
    'title',
    'description',
    'nullable',
    'enum',
    'items',
    'properties',
    'required',
    'example',
    'default',
    'anyOf',
    'oneOf',
    'allOf',
    'not',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
    'minLength',
    'maxLength',
    'pattern',
    'propertyOrdering',
    'const',
]);

const SCHEMA_CONFLICT_ENUM = '__mixdog_unrepresentable_schema_conjunction__';
const schemaValueKey = (value) => stableTraceStringify(value);
const sameSchemaValue = (a, b) => schemaValueKey(a) === schemaValueKey(b);
const defineSchemaProperty = (target, name, value) => {
    Object.defineProperty(target, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    });
};

function schemaFallback(reason) {
    return {
        type: SchemaType.STRING,
        enum: [SCHEMA_CONFLICT_ENUM],
        description: `Schema conjunction could not be represented safely: ${String(reason || 'conflict').slice(0, 300)}`,
    };
}

function typeInfo(schema) {
    const declared = Array.isArray(schema?.type)
        ? schema.type
        : (typeof schema?.type === 'string' ? [schema.type] : []);
    const nonNull = [...new Set(declared.filter((type) => type !== 'null'))];
    let type = nonNull[0] || null;
    if (nonNull.length > 1) {
        if (nonNull.length === 2 && nonNull.includes('integer') && nonNull.includes('number')) type = 'integer';
        else return { conflict: `unsupported type union ${nonNull.join('|')}` };
    }
    return {
        type,
        allowsNull: declared.length === 0 || declared.includes('null') || schema?.nullable === true,
    };
}

function intersectTypeInfo(a, b) {
    const left = typeInfo(a);
    const right = typeInfo(b);
    if (left.conflict || right.conflict) return { conflict: left.conflict || right.conflict };
    let type = left.type || right.type;
    if (left.type && right.type && left.type !== right.type) {
        if ([left.type, right.type].includes('integer') && [left.type, right.type].includes('number')) type = 'integer';
        else return { conflict: `incompatible types ${left.type} and ${right.type}` };
    }
    return { type, allowsNull: left.allowsNull && right.allowsNull };
}

function enumValues(schema) {
    const values = Array.isArray(schema?.enum) ? schema.enum : null;
    if (schema?.const === undefined) return { values };
    if (values && !values.some((value) => sameSchemaValue(value, schema.const))) {
        return { values: null, conflict: 'empty enum intersection' };
    }
    return { values: [schema.const] };
}

function strongerLower(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (b.value > a.value) return b;
    if (b.value < a.value) return a;
    return { value: a.value, exclusive: a.exclusive || b.exclusive };
}

function strongerUpper(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (b.value < a.value) return b;
    if (b.value > a.value) return a;
    return { value: a.value, exclusive: a.exclusive || b.exclusive };
}

function rawBound(schema, side) {
    const inclusive = side === 'lower' ? schema?.minimum : schema?.maximum;
    const exclusive = side === 'lower' ? schema?.exclusiveMinimum : schema?.exclusiveMaximum;
    let out = Number.isFinite(Number(inclusive)) ? { value: Number(inclusive), exclusive: false } : null;
    if (Number.isFinite(Number(exclusive))) {
        const next = { value: Number(exclusive), exclusive: true };
        out = side === 'lower' ? strongerLower(out, next) : strongerUpper(out, next);
    }
    return out;
}

function mergeSchemaConjunction(leftInput, rightInput) {
    const left = flattenAllOf(leftInput);
    const right = flattenAllOf(rightInput);
    if (left.conflict || right.conflict) return { conflict: left.conflict || right.conflict };
    for (const key of ['anyOf', 'oneOf', 'not']) {
        if (right.schema[key] !== undefined) return { conflict: `${key} inside allOf` };
    }
    const a = left.schema;
    const b = right.schema;
    for (const source of [a, b]) {
        for (const key of Object.keys(source)) {
            if (GEMINI_SCHEMA_FIELDS.has(key)) continue;
            return { conflict: `unsupported allOf keyword ${key}` };
        }
    }
    const merged = { ...a };
    const types = intersectTypeInfo(a, b);
    if (types.conflict) return types;
    delete merged.type;
    delete merged.nullable;
    if (types.type) merged.type = types.type;
    if (types.allowsNull && types.type) merged.nullable = true;

    const aEnum = enumValues(a);
    const bEnum = enumValues(b);
    if (aEnum.conflict || bEnum.conflict) {
        return { conflict: aEnum.conflict || bEnum.conflict };
    }
    const ae = aEnum.values;
    const be = bEnum.values;
    if (ae || be) {
        const values = ae && be
            ? ae.filter((value) => be.some((candidate) => sameSchemaValue(value, candidate)))
            : [...(ae || be)];
        if (!values.length) return { conflict: 'empty enum intersection' };
        merged.enum = values;
        delete merged.const;
    }

    const lower = strongerLower(rawBound(a, 'lower'), rawBound(b, 'lower'));
    const upper = strongerUpper(rawBound(a, 'upper'), rawBound(b, 'upper'));
    for (const key of ['minimum', 'exclusiveMinimum', 'maximum', 'exclusiveMaximum']) delete merged[key];
    if (lower) merged[lower.exclusive ? 'exclusiveMinimum' : 'minimum'] = lower.value;
    if (upper) merged[upper.exclusive ? 'exclusiveMaximum' : 'maximum'] = upper.value;
    if (lower && upper && (lower.value > upper.value
        || (lower.value === upper.value && (lower.exclusive || upper.exclusive)))) {
        return { conflict: 'empty numeric range' };
    }

    for (const [minKey, maxKey] of [
        ['minLength', 'maxLength'],
        ['minItems', 'maxItems'],
        ['minProperties', 'maxProperties'],
    ]) {
        const min = Math.max(...[a[minKey], b[minKey]].filter(Number.isFinite), 0);
        const maxima = [a[maxKey], b[maxKey]].filter(Number.isFinite);
        const max = maxima.length ? Math.min(...maxima) : null;
        if (max != null && min > max) return { conflict: `${minKey}/${maxKey}` };
        if (min > 0 || a[minKey] === 0 || b[minKey] === 0) merged[minKey] = min;
        if (max != null) merged[maxKey] = max;
    }

    for (const key of ['pattern', 'format']) {
        if (a[key] !== undefined && b[key] !== undefined && a[key] !== b[key]) {
            return { conflict: `incompatible ${key}` };
        }
        if (b[key] !== undefined) merged[key] = b[key];
    }
    if (a.description && b.description && a.description !== b.description) {
        merged.description = `${a.description}\n${b.description}`;
    } else if (b.description !== undefined) merged.description = b.description;
    if (a.default !== undefined && b.default !== undefined && !sameSchemaValue(a.default, b.default)) {
        delete merged.default;
    } else if (b.default !== undefined) merged.default = b.default;
    for (const key of ['title', 'example', 'propertyOrdering']) {
        if (merged[key] === undefined && b[key] !== undefined) merged[key] = b[key];
    }

    const properties = {};
    for (const [name, schema] of Object.entries(a.properties || {})) {
        defineSchemaProperty(properties, name, schema);
    }
    for (const [name, schema] of Object.entries(b.properties || {})) {
        if (!Object.hasOwn(properties, name)) defineSchemaProperty(properties, name, schema);
        else {
            const child = mergeSchemaConjunction(properties[name], schema);
            if (child.conflict) return { conflict: `property ${name}: ${child.conflict}` };
            defineSchemaProperty(properties, name, child.schema);
        }
    }
    if (Object.keys(properties).length) merged.properties = properties;
    const required = [...new Set([
        ...(Array.isArray(a.required) ? a.required : []),
        ...(Array.isArray(b.required) ? b.required : []),
    ].filter((name) => typeof name === 'string'))];
    if (required.length) merged.required = required;

    if (a.items && b.items) {
        const items = mergeSchemaConjunction(a.items, b.items);
        if (items.conflict) return { conflict: `items: ${items.conflict}` };
        merged.items = items.schema;
    } else if (b.items) merged.items = b.items;
    return { schema: merged };
}

function flattenAllOf(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { schema: input };
    let schema = { ...input };
    const branches = Array.isArray(schema.allOf) ? schema.allOf : [];
    const hadAllOf = branches.length > 0;
    delete schema.allOf;
    for (const branch of branches) {
        const merged = mergeSchemaConjunction(schema, branch);
        if (merged.conflict) return merged;
        schema = merged.schema;
    }
    return { schema, hadAllOf };
}

export function convertSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const flattened = flattenAllOf(schema);
    if (flattened.conflict) return schemaFallback(flattened.conflict);
    schema = flattened.schema;
    const result = {};
    for (const [k, v] of Object.entries(schema)) {
        // Project onto Gemini's documented Schema surface instead of trying
        // to blacklist the much larger JSON Schema vocabulary. Unknown
        // extension keywords are rejected by generateContent.
        if (!GEMINI_SCHEMA_FIELDS.has(k)) continue;
        result[k] = v;
    }
    // Gemini's Schema validator requires every `enum` entry to be a string.
    // An unrepresentable typed enum must become an explicit conflict schema;
    // dropping it would broaden the accepted tool arguments.
    // Gemini's schema dialect represents JSON Schema null unions with
    // `nullable`, not a type array.
    if (result.type === undefined && (result.properties || result.required)) result.type = 'object';
    if (result.type === undefined && result.items) result.type = 'array';
    const normalizedType = typeInfo(result);
    if (normalizedType.conflict) return schemaFallback(normalizedType.conflict);
    const rawType = normalizedType.type || undefined;
    if (rawType) result.type = rawType;
    else delete result.type;
    if (normalizedType.allowsNull && rawType) result.nullable = true;
    else if (result.nullable !== true) delete result.nullable;
    const localEnum = enumValues(result);
    if (localEnum.conflict) return schemaFallback(localEnum.conflict);
    if (result.const !== undefined) {
        if (rawType === 'integer' || rawType === 'number' || rawType === 'boolean') {
            return schemaFallback(`Gemini does not support ${rawType} const`);
        }
        result.enum = [String(result.const)];
        delete result.const;
    }
    if (Array.isArray(result.enum) && (rawType === 'integer' || rawType === 'number' || rawType === 'boolean')) {
        if (result.enum.some((item) => typeof item !== 'string')) {
            return schemaFallback(`Gemini does not support ${rawType} enum conjunction`);
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
    const lower = rawBound(result, 'lower');
    const upper = rawBound(result, 'upper');
    delete result.exclusiveMinimum;
    delete result.exclusiveMaximum;
    if ((lower?.exclusive || upper?.exclusive) && rawType !== 'integer') {
        return schemaFallback('exclusive numeric bound is not supported by Gemini Schema');
    }
    if (rawType === 'integer') {
        if (lower?.exclusive) result.minimum = Math.floor(lower.value) + 1;
        if (upper?.exclusive) result.maximum = Math.ceil(upper.value) - 1;
    }
    if (Number.isFinite(result.minimum) && Number.isFinite(result.maximum)
        && result.minimum > result.maximum) return schemaFallback('empty numeric range');
    if ((result.properties && typeof result.properties === 'object') || Array.isArray(result.required)) {
        const props = {};
        for (const [key, val] of Object.entries(result.properties || {})) {
            defineSchemaProperty(props, key, convertSchema(val));
        }
        if (Array.isArray(result.required)) {
            result.required = [...new Set(result.required.filter((key) => typeof key === 'string'))];
            for (const key of result.required) {
                if (!Object.hasOwn(props, key)) {
                    defineSchemaProperty(
                        props,
                        key,
                        schemaFallback(`required property ${key} has no representable schema`),
                    );
                }
            }
            if (!result.required.length) delete result.required;
        }
        result.properties = props;
    }
    if (result.items && typeof result.items === 'object') {
        result.items = convertSchema(result.items);
    }
    // Gemini function declarations support anyOf, but not oneOf/allOf/not.
    // oneOf is safely relaxed to anyOf. Object allOf branches are projected
    // into the local properties/required set where representable; other allOf
    // and all not constraints are conservatively dropped.
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
    const unionBranches = [
        ...(Array.isArray(result.anyOf) ? result.anyOf : []),
        ...(Array.isArray(result.oneOf) ? result.oneOf : []),
    ];
    delete result.oneOf;
    if (unionBranches.length) {
        result.anyOf = unionBranches.map((s) => {
                const sub = convertSchema(s);
                if (sub && typeof sub === 'object') {
                    const usesObjectKeys = sub.required !== undefined || sub.properties !== undefined;
                    if (usesObjectKeys && sub.type === undefined) {
                        sub.type = toSchemaType('object');
                    }
                    if (Array.isArray(sub.required) && !sub.properties && result.properties) {
                        const projected = {};
                        for (const k of sub.required) {
                            if (Object.hasOwn(result.properties, k)) {
                                defineSchemaProperty(projected, k, result.properties[k]);
                            }
                        }
                        if (Object.keys(projected).length > 0) sub.properties = projected;
                    }
                }
                return sub;
            }).filter(Boolean);
        if (!result.anyOf.length) delete result.anyOf;
    }
    delete result.allOf;
    delete result.not;
    const typeSpecific = {
        string: new Set(['minLength', 'maxLength', 'pattern', 'format']),
        array: new Set(['minItems', 'maxItems', 'items']),
        object: new Set(['minProperties', 'maxProperties', 'properties', 'required', 'propertyOrdering']),
        number: new Set(['minimum', 'maximum']),
        integer: new Set(['minimum', 'maximum']),
    };
    for (const key of [
        'minLength', 'maxLength', 'pattern', 'format',
        'minItems', 'maxItems', 'items',
        'minProperties', 'maxProperties', 'properties', 'required', 'propertyOrdering',
        'minimum', 'maximum',
    ]) {
        if (!typeSpecific[rawType]?.has(key)) delete result[key];
    }
    for (const [minKey, maxKey] of [
        ['minLength', 'maxLength'],
        ['minItems', 'maxItems'],
        ['minProperties', 'maxProperties'],
    ]) {
        if (result[minKey] !== undefined
            && (!Number.isInteger(result[minKey]) || result[minKey] < 0)) delete result[minKey];
        if (result[maxKey] !== undefined
            && (!Number.isInteger(result[maxKey]) || result[maxKey] < 0)) delete result[maxKey];
        if (result[minKey] !== undefined && result[maxKey] !== undefined
            && result[minKey] > result[maxKey]) return schemaFallback(`${minKey}/${maxKey}`);
    }
    if (result.minimum !== undefined && !Number.isFinite(result.minimum)) delete result.minimum;
    if (result.maximum !== undefined && !Number.isFinite(result.maximum)) delete result.maximum;
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
        const parts = geminiThoughtPartsFromMetadata(message);
        if (message.content) {
            parts.push(...(geminiTextPartsFromMetadata(message) || normalizeGeminiParts(message.content)));
        }
        for (const tc of message.toolCalls) {
            // Gemini 3 thinking models require the original thoughtSignature
            // echoed back on every prior functionCall so the cached thinking
            // prefix stays valid. v1beta places the field at the Part level
            // (sibling of functionCall) — putting it inside functionCall returns
            // 400 "Unknown name". Older models / first turn have no signature.
            const part = {
                functionCall: {
                    name: tc.name,
                    args: tc.arguments,
                    ...(typeof tc.id === 'string' && tc.id ? { id: tc.id } : {}),
                },
            };
            if (typeof tc.thoughtSignature === 'string'
                && tc.thoughtSignature && tc.thoughtSignature.length <= 16_384) {
                part.thoughtSignature = tc.thoughtSignature;
            }
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
        const { response, mediaParts } = splitGeminiToolContent(message.content);
        const media = toGeminiFunctionResponseMedia(mediaParts);
        if (media.refs.length) response.media = media.refs;
        if (media.external.length) response.externalMedia = media.external;
        if (media.omitted.length) {
            response.omittedMediaTypes = media.omitted;
        }
        const functionResponse = { name: functionName, response };
        if (typeof message.toolCallId === 'string' && message.toolCallId) {
            functionResponse.id = message.toolCallId;
        }
        if (media.parts.length) functionResponse.parts = media.parts;
        const parts = [{ functionResponse }];
        return {
            role: 'user',
            parts,
        };
    }
    return {
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: message.role === 'assistant'
            ? (geminiTextPartsFromMetadata(message) || normalizeGeminiParts(message.content))
            : normalizeGeminiParts(message.content),
    };
}

function geminiTextPartsFromMetadata(message) {
    const parts = message?.providerMetadata?.gemini?.textParts;
    if (!Array.isArray(parts) || !parts.length || parts.length > 128) return null;
    const normalized = [];
    for (const part of parts) {
        if (!part || typeof part !== 'object'
            || typeof part.text !== 'string' || part.text.length > 1_000_000) return null;
        const next = { text: part.text };
        if (part.thoughtSignature !== undefined) {
            if (typeof part.thoughtSignature !== 'string'
                || !part.thoughtSignature || part.thoughtSignature.length > 16_384) return null;
            next.thoughtSignature = part.thoughtSignature;
        }
        normalized.push(next);
    }
    const expected = typeof message.content === 'string' ? message.content : '';
    return normalized.map((part) => part.text).join('') === expected ? normalized : null;
}

function geminiThoughtPartsFromMetadata(message) {
    const parts = message?.providerMetadata?.gemini?.thoughtParts;
    if (!Array.isArray(parts) || !parts.length || parts.length > 128) return [];
    const normalized = [];
    for (const part of parts) {
        // Hidden prompt content is replayable only when every persisted part is
        // structurally valid and signed by Gemini. Reject the whole collection
        // on malformed/unsigned data rather than partially accepting metadata.
        if (!part || typeof part !== 'object'
            || typeof part.text !== 'string' || part.text.length > 1_000_000
            || typeof part.thoughtSignature !== 'string' || !part.thoughtSignature
            || part.thoughtSignature.length > 16_384) return [];
        normalized.push({
            text: part.text,
            thought: true,
            thoughtSignature: part.thoughtSignature,
        });
    }
    return normalized;
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

export function parseGeminiThinkingParts(parts) {
    if (!Array.isArray(parts)) return undefined;
    const blocks = [];
    for (const part of parts) {
        if (part?.thought !== true) continue;
        const block = {
            type: 'thinking',
            thinking: typeof part.text === 'string' ? part.text : '',
        };
        const signature = part.thoughtSignature || part.thought_signature;
        if (typeof signature === 'string' && signature && signature.length <= 16_384) {
            block.signature = signature;
        }
        blocks.push(block);
    }
    return blocks.length ? blocks : undefined;
}

export function parseGeminiTextPartMetadata(parts) {
    if (!Array.isArray(parts)) return undefined;
    const thoughtParts = parts
        .filter((part) => part?.thought === true && typeof part?.text === 'string')
        .map((part) => {
            const out = { text: part.text };
            const signature = part.thoughtSignature || part.thought_signature;
            if (typeof signature === 'string' && signature && signature.length <= 16_384) {
                out.thoughtSignature = signature;
            }
            return out;
        })
        // Unsigned reasoning must never become persisted hidden prompt text.
        .filter((part) => typeof part.thoughtSignature === 'string' && part.thoughtSignature);
    const textParts = parts
        .filter((part) => part?.thought !== true && typeof part?.text === 'string')
        .map((part) => {
            const out = { text: part.text };
            const signature = part.thoughtSignature || part.thought_signature;
            if (typeof signature === 'string' && signature && signature.length <= 16_384) {
                out.thoughtSignature = signature;
            }
            return out;
        });
    if (!thoughtParts.length && !textParts.some((part) => part.thoughtSignature)) return undefined;
    return {
        gemini: {
            ...(thoughtParts.length ? { thoughtParts } : {}),
            ...(textParts.some((part) => part.thoughtSignature) ? { textParts } : {}),
        },
    };
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
            // Gemini may provide an opaque server call id. It is a protocol
            // correlation token: preserve it byte-for-byte and synthesize a
            // deterministic id only for older responses that omit it.
            id: typeof fc.id === 'string' && fc.id ? fc.id : `gemini_${idHash}`,
            name: fc.name,
            arguments: (fc.args ?? {}),
        };
        if (typeof sig === 'string' && sig && sig.length <= 16_384) {
            call.thoughtSignature = sig;
        }
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
