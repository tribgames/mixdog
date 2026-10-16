/**
 * gemini-schema.mjs — Gemini request-shape conversion: JSON Schema → Gemini
 * FunctionDeclarationSchema, tool/tool-config mapping, message → content
 * mapping, tool-call parsing/emission, and grounding-source collection.
 */
import { SchemaType } from '@google/generative-ai';
import { traceHash, stableTraceStringify } from './trace-utils.mjs';
import {
  normalizeContentForGeminiParts,
  splitToolContentForGemini,
  geminiPartMetadata,
} from './media-normalization.mjs';
import { providerReplayItems } from './lib/provider-replay.mjs';
import {
  claudeBridgeInputSchema,
  escapePointer,
  geminiJsonSchemaProblem,
  repairedToolInputSchema,
  reportInvalidTool,
} from './lib/claude-bridge-schema.mjs';
import { actionInputUnionFor } from './lib/action-input-contract.mjs';
import { isGeminiFamilyModel } from './gemini-family.mjs';
import { ensureGeminiToolCallSignatures } from './gemini-history-signatures.mjs';

// Bounds on persisted provider metadata replayed back into the prompt.
const MAX_THOUGHT_SIGNATURE_CHARS = 16_384;
const MAX_REPLAY_TEXT_CHARS = 1_000_000;
const MAX_REPLAY_PARTS = 128;

function explicitGeminiMediaPart(part) {
  if (!part || typeof part !== 'object') return null;
  const inline = part.inlineData || part.inline_data;
  if (typeof inline?.data === 'string' && inline.data) {
    const mimeType = inline.mimeType || inline.mime_type || inline.mediaType || inline.media_type;
    if (typeof mimeType === 'string' && mimeType) {
      return { inlineData: { mimeType, data: inline.data }, ...geminiPartMetadata(part) };
    }
  }
  // An explicit fileData part keeps exactly the MIME type it declared; with
  // none, the shared normalizer resolves it from the URI or omits it.
  const file = part.fileData || part.file_data;
  const fileUri = file?.fileUri || file?.file_uri;
  const mimeType = file?.mimeType || file?.mime_type || file?.mediaType || file?.media_type;
  if (typeof fileUri === 'string' && fileUri) {
    const info = { fileUri };
    if (typeof mimeType === 'string' && mimeType) info.mimeType = mimeType;
    else {
      const resolved = normalizeContentForGeminiParts([part])[0]?.fileData?.mimeType;
      if (resolved) info.mimeType = resolved;
    }
    return { fileData: info, ...geminiPartMetadata(part) };
  }
  return null;
}

// The shared normalizer intentionally defaults unknown media to image/png for
// image-oriented providers. Gemini accepts audio/video/document MIME types too,
// so preserve explicit Gemini wire parts before using the shared fallback.
function normalizeGeminiParts(content) {
  if (typeof content === 'string') return normalizeContentForGeminiParts(content);
  let parts = [content];
  if (Array.isArray(content)) parts = content;
  else if (content && typeof content === 'object' && Array.isArray(content.content)) parts = content.content;
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
const sameSchemaValue = (a, b) => stableTraceStringify(a) === stableTraceStringify(b);
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
  let declared = [];
  if (Array.isArray(schema?.type)) declared = schema.type;
  else if (typeof schema?.type === 'string') declared = [schema.type];
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
    const values =
      ae && be ? ae.filter((value) => be.some((candidate) => sameSchemaValue(value, candidate))) : [...(ae || be)];
    if (!values.length) return { conflict: 'empty enum intersection' };
    merged.enum = values;
    delete merged.const;
  }

  const lower = strongerLower(rawBound(a, 'lower'), rawBound(b, 'lower'));
  const upper = strongerUpper(rawBound(a, 'upper'), rawBound(b, 'upper'));
  for (const key of ['minimum', 'exclusiveMinimum', 'maximum', 'exclusiveMaximum']) delete merged[key];
  if (lower) merged[lower.exclusive ? 'exclusiveMinimum' : 'minimum'] = lower.value;
  if (upper) merged[upper.exclusive ? 'exclusiveMaximum' : 'maximum'] = upper.value;
  if (
    lower &&
    upper &&
    (lower.value > upper.value || (lower.value === upper.value && (lower.exclusive || upper.exclusive)))
  ) {
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
  const required = [
    ...new Set(
      [...(Array.isArray(a.required) ? a.required : []), ...(Array.isArray(b.required) ? b.required : [])].filter(
        (name) => typeof name === 'string'
      )
    ),
  ];
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

/**
 * Recursively convert a JSON Schema object to Gemini's FunctionDeclarationSchema.
 * Gemini requires `type` to be a SchemaType enum, not a plain string, and
 * accepts only a documented subset of JSON Schema. Project onto that subset
 * at every level and convert `const` into Gemini's string enum form.
 */
function convertSchema(schema) {
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
  if (result.type === undefined && (result.properties || result.required)) result.type = 'object';
  if (result.type === undefined && result.items) result.type = 'array';
  // Gemini's schema dialect represents JSON Schema null unions with
  // `nullable`, not a type array.
  const normalizedType = typeInfo(result);
  if (normalizedType.conflict) return schemaFallback(normalizedType.conflict);
  const rawType = normalizedType.type || undefined;
  if (rawType) result.type = rawType;
  else delete result.type;
  if (normalizedType.allowsNull && rawType) result.nullable = true;
  else if (result.nullable !== true) delete result.nullable;
  // Gemini's Schema validator requires every `enum` entry to be a string.
  // An unrepresentable typed enum must become an explicit conflict schema;
  // dropping it would broaden the accepted tool arguments.
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
  if (Number.isFinite(result.minimum) && Number.isFinite(result.maximum) && result.minimum > result.maximum)
    return schemaFallback('empty numeric range');
  convertSchemaChildren(result);
  projectUnionBranches(result);
  delete result.allOf;
  delete result.not;
  return pruneTypeSpecificKeywords(result, rawType) ?? result;
}

/** Recurse into the object's properties and the array's items. A `required`
 *  name with no representable schema gets an explicit conflict property so
 *  the declaration cannot silently widen. */
function convertSchemaChildren(result) {
  if ((result.properties && typeof result.properties === 'object') || Array.isArray(result.required)) {
    const props = {};
    for (const [key, val] of Object.entries(result.properties || {})) {
      defineSchemaProperty(props, key, convertSchema(val));
    }
    if (Array.isArray(result.required)) {
      result.required = [...new Set(result.required.filter((key) => typeof key === 'string'))];
      for (const key of result.required) {
        if (!Object.hasOwn(props, key)) {
          defineSchemaProperty(props, key, schemaFallback(`required property ${key} has no representable schema`));
        }
      }
      if (!result.required.length) delete result.required;
    }
    result.properties = props;
  }
  if (result.items && typeof result.items === 'object') {
    result.items = convertSchema(result.items);
  }
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
function projectUnionBranches(result) {
  const unionBranches = [
    ...(Array.isArray(result.anyOf) ? result.anyOf : []),
    ...(Array.isArray(result.oneOf) ? result.oneOf : []),
  ];
  delete result.oneOf;
  if (!unionBranches.length) return;
  result.anyOf = unionBranches
    .map((s) => {
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
    })
    .filter(Boolean);
  if (!result.anyOf.length) delete result.anyOf;
}

const TYPE_SPECIFIC_KEYWORDS = {
  string: new Set(['minLength', 'maxLength', 'pattern', 'format']),
  array: new Set(['minItems', 'maxItems', 'items']),
  object: new Set(['minProperties', 'maxProperties', 'properties', 'required', 'propertyOrdering']),
  number: new Set(['minimum', 'maximum']),
  integer: new Set(['minimum', 'maximum']),
};
const ALL_TYPE_SPECIFIC_KEYWORDS = new Set(Object.values(TYPE_SPECIFIC_KEYWORDS).flatMap((set) => [...set]));

/** Drop every keyword that does not belong to the resolved type, then sanity
 *  the surviving min/max pairs. Returns a conflict schema for an empty range,
 *  else null (the caller keeps `result`). */
function pruneTypeSpecificKeywords(result, rawType) {
  for (const key of ALL_TYPE_SPECIFIC_KEYWORDS) {
    if (!TYPE_SPECIFIC_KEYWORDS[rawType]?.has(key)) delete result[key];
  }
  for (const [minKey, maxKey] of [
    ['minLength', 'maxLength'],
    ['minItems', 'maxItems'],
    ['minProperties', 'maxProperties'],
  ]) {
    if (result[minKey] !== undefined && (!Number.isInteger(result[minKey]) || result[minKey] < 0))
      delete result[minKey];
    if (result[maxKey] !== undefined && (!Number.isInteger(result[maxKey]) || result[maxKey] < 0))
      delete result[maxKey];
    if (result[minKey] !== undefined && result[maxKey] !== undefined && result[minKey] > result[maxKey])
      return schemaFallback(`${minKey}/${maxKey}`);
  }
  if (result.minimum !== undefined && !Number.isFinite(result.minimum)) delete result.minimum;
  if (result.maximum !== undefined && !Number.isFinite(result.maximum)) delete result.maximum;
  return null;
}

// Gemini's legacy Schema requires typed values. An unconstrained JSON value
// (Office operation values, for example) cannot be replaced with a string or
// an untyped Schema node. FunctionDeclaration.parametersJsonSchema is the
// documented, mutually exclusive representation for the original JSON Schema.
function needsJsonParameters(schema) {
  if (typeof schema === 'boolean') return true;
  if (!schema || typeof schema !== 'object') return false;
  return !legacyRepresentable(schema, true);
}

const LEGACY_JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
// Annotation-only keywords: dropping them never widens the accepted arguments.
const ANNOTATION_KEYS = new Set(['$schema', '$id', '$comment', 'examples']);
const NON_CONSTRAINT_KEYS = new Set([...ANNOTATION_KEYS, 'description', 'title', 'default', 'example']);

/** True when the legacy OpenAPI Schema subset expresses `input` exactly:
 *  convertSchema would neither drop a constraint nor invent a replacement. */
function legacyRepresentable(input, root = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const flat = flattenAllOf(input);
  if (flat.conflict) return false;
  const schema = flat.schema;
  const keys = Object.keys(schema);
  if (!keys.some((key) => !NON_CONSTRAINT_KEYS.has(key))) return false;
  for (const key of keys) {
    if (GEMINI_SCHEMA_FIELDS.has(key) || ANNOTATION_KEYS.has(key)) continue;
    // additionalProperties:true is the default; anything else is a constraint.
    if (key === 'additionalProperties' && schema[key] === true) continue;
    return false;
  }
  if (schema.oneOf !== undefined || schema.not !== undefined) return false;

  const declared = [].concat(schema.type ?? []);
  const nonNull = declared.filter((type) => type !== 'null');
  if (declared.length && !nonNull.length) return false;
  if (nonNull.length > 1 || nonNull.some((type) => !LEGACY_JSON_TYPES.has(type))) return false;
  let type = nonNull[0];
  if (!type && (schema.properties || schema.required)) type = 'object';
  if (!type && schema.items) type = 'array';

  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.some((v) => typeof v !== 'string'))) {
    return false;
  }
  if (schema.const !== undefined && typeof schema.const !== 'string') return false;
  if (['integer', 'number', 'boolean'].includes(type) && (schema.enum !== undefined || schema.const !== undefined)) {
    return false;
  }
  if (!type && [...ALL_TYPE_SPECIFIC_KEYWORDS].some((key) => schema[key] !== undefined)) return false;

  const lower = rawBound(schema, 'lower');
  const upper = rawBound(schema, 'upper');
  if ((lower?.exclusive || upper?.exclusive) && type !== 'integer') return false;
  if (lower && upper && lower.value > upper.value) return false;
  for (const [minKey, maxKey] of [
    ['minLength', 'maxLength'],
    ['minItems', 'maxItems'],
    ['minProperties', 'maxProperties'],
  ]) {
    if (Number.isFinite(schema[minKey]) && Number.isFinite(schema[maxKey]) && schema[minKey] > schema[maxKey]) {
      return false;
    }
  }

  if (type === 'array') {
    if (!schema.items || typeof schema.items !== 'object' || Array.isArray(schema.items)) return false;
    if (!legacyRepresentable(schema.items)) return false;
  }
  if (type === 'object') {
    const props = schema.properties;
    if (props !== undefined && (!props || typeof props !== 'object' || Array.isArray(props))) return false;
    const names = Object.keys(props || {});
    // A free-form object has no legacy form (empty `properties` is rejected);
    // only the root of a no-argument tool may be empty.
    if (!names.length && !root && !Array.isArray(schema.anyOf)) return false;
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required)) return false;
      if (schema.required.some((name) => typeof name !== 'string' || !names.includes(name))) return false;
    }
    if (!names.every((name) => legacyRepresentable(props[name]))) return false;
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || !schema.anyOf.every((branch) => legacyRepresentable(branch))) return false;
  }
  return true;
}

// Keywords the Gemini endpoints reject or ignore on parametersJsonSchema:
// vendor extensions (`x-*`) and annotation-only keywords. None of them
// constrains the accepted arguments, so dropping them keeps the semantics.
const NON_STANDARD_SCHEMA_KEYS = new Set(['$schema', '$comment', 'deprecated', 'examples']);
const isNonStandardSchemaKey = (key) => NON_STANDARD_SCHEMA_KEYS.has(key) || key.startsWith('x-');
// Keys whose value maps names to subschemas (names are data, never stripped),
// a single subschema, or a list of subschemas.
const JSON_SCHEMA_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const JSON_SCHEMA_NODE_KEYS = [
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
];
const JSON_SCHEMA_LIST_KEYS = ['prefixItems', 'allOf', 'anyOf', 'oneOf'];

function stripNonStandardSchemaKeys(schema) {
  if (Array.isArray(schema)) return schema.map(stripNonStandardSchemaKeys);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (isNonStandardSchemaKey(key)) continue;
    if (JSON_SCHEMA_MAP_KEYS.includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const children = {};
      for (const [name, child] of Object.entries(value)) {
        defineSchemaProperty(children, name, stripNonStandardSchemaKeys(child));
      }
      out[key] = children;
    } else if (JSON_SCHEMA_NODE_KEYS.includes(key) || JSON_SCHEMA_LIST_KEYS.includes(key)) {
      out[key] = stripNonStandardSchemaKeys(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const LEGACY_SCHEMA_TYPES = new Set(Object.values(SchemaType));

/** Why a legacy `parameters` Schema (the OpenAPI subset convertSchema targets)
 *  is rejected by Gemini, as `{ pointer, reason }`, or null when it is valid:
 *  an OBJECT root (or none), known types, an `items` schema on every ARRAY,
 *  string enums, and `required` names that exist in `properties`. */
function legacyParametersProblem(node, pointer = '', root = true) {
  const bad = (reason, at = pointer) => ({ pointer: at, reason });
  if (!node || typeof node !== 'object' || Array.isArray(node)) return bad('a Gemini Schema must be an object');
  const { type, properties, required, items, anyOf } = node;
  if (type !== undefined && !LEGACY_SCHEMA_TYPES.has(type))
    return bad(`unsupported type ${JSON.stringify(type)}`, `${pointer}/type`);
  if (root && type !== undefined && type !== SchemaType.OBJECT)
    return bad('the input schema root must have type "object"', `${pointer}/type`);
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.some((value) => typeof value !== 'string'))) {
    return bad('enum must be an array of strings', `${pointer}/enum`);
  }
  if (type === SchemaType.ARRAY && (!items || typeof items !== 'object' || Array.isArray(items))) {
    return bad('an array schema needs an "items" schema', `${pointer}/items`);
  }
  // A node without its own `properties` (an anyOf branch narrowing the
  // parent's required keys) has nothing to check `required` against.
  if (required !== undefined) {
    const names = properties && typeof properties === 'object' ? Object.keys(properties) : null;
    if (!Array.isArray(required) || (names && required.some((name) => !names.includes(name)))) {
      return bad('required must list properties declared in "properties"', `${pointer}/required`);
    }
  }
  const children = [
    ...Object.entries(properties || {}).map(([name, child]) => [child, `${pointer}/properties/${escapePointer(name)}`]),
    ...(items ? [[items, `${pointer}/items`]] : []),
    ...(Array.isArray(anyOf) ? anyOf.map((child, i) => [child, `${pointer}/anyOf/${i}`]) : []),
  ];
  for (const [child, at] of children) {
    const problem = legacyParametersProblem(child, at, false);
    if (problem) return problem;
  }
  return null;
}

/** Why the declaration's schema (`parameters` or `parametersJsonSchema`) is
 *  rejected by Gemini, or null. A tool without a schema is sent as written. */
function geminiDeclarationProblem(declaration) {
  if (declaration.parametersJsonSchema !== undefined) return geminiJsonSchemaProblem(declaration.parametersJsonSchema);
  return declaration.parameters === undefined ? null : legacyParametersProblem(declaration.parameters);
}

// `claudeBridge: true` (Claude models behind Antigravity) always encodes the
// schema as `parametersJsonSchema`: the bridge hands it to Anthropic as a
// draft 2020-12 input_schema, and the legacy `parameters` projection
// (convertSchema) rewrites type arrays, numeric enums and nullable unions.
// A tool whose schema is invalid for Anthropic is left out and reported
// (`onToolExcluded`, default console.warn); the other tools are unaffected.
// Gemini routes validate each final declaration the same way; `validate:
// false` (an Antigravity model outside the Gemini family) converts without it.
export function toGeminiTools(tools, { claudeBridge = false, onToolExcluded, validate = true } = {}) {
  const functionDeclarations = [];
  tools.forEach((t, index) => {
    const declaration = { name: t.name, description: t.description };
    if (claudeBridge) {
      // The bridge accepts nested per-action input alternatives.
      const result = claudeBridgeInputSchema(actionInputUnionFor(t.inputSchema));
      if (!result.schema) {
        reportInvalidTool(t.name, index, result, onToolExcluded);
        return;
      }
      declaration.parametersJsonSchema = result.schema;
    } else if (validate) {
      const accepted = acceptedGeminiTool(t, index, onToolExcluded);
      if (!accepted) return;
      Object.assign(declaration, accepted.fields);
    } else {
      Object.assign(declaration, geminiSchemaFields(t.inputSchema));
    }
    functionDeclarations.push(declaration);
  });
  return { functionDeclarations };
}

function geminiSchemaFields(inputSchema) {
  if (needsJsonParameters(inputSchema)) {
    return { parametersJsonSchema: stripNonStandardSchemaKeys(structuredClone(inputSchema)) };
  }
  return { parameters: convertSchema(inputSchema) };
}

// A Gemini endpoint rejects the whole request for one bad declaration. A
// declaration it would reject is first rebuilt from the lowered schema
// (draft-07/04 constructs); one still rejected is reported and left out.
// Returns { tool, fields } (the tool to send, its schema fields) or null.
function acceptedGeminiTool(tool, index, onToolExcluded) {
  const fields = geminiSchemaFields(tool.inputSchema);
  let problem = geminiDeclarationProblem(fields);
  if (!problem) return { tool, fields };
  const repaired = repairedToolInputSchema(tool.inputSchema, 'gemini');
  if (repaired) {
    const repairedFields = geminiSchemaFields(repaired);
    problem = geminiDeclarationProblem(repairedFields);
    if (!problem) return { tool: { ...tool, inputSchema: repaired }, fields: repairedFields };
  }
  reportInvalidTool(tool.name, index, problem, onToolExcluded, '[gemini] tool');
  return null;
}

/** The tools whose schema a Gemini-family model behind an OpenAI-compatible
 *  route (OpenRouter, a gateway) accepts, in order: unchanged, or carrying
 *  the lowered schema when only that is accepted. The others are reported
 *  through `onToolExcluded`. */
export function geminiAcceptedTools(tools, onToolExcluded) {
  let changed = false;
  const out = [];
  tools.forEach((tool, index) => {
    const accepted = acceptedGeminiTool(tool, index, onToolExcluded);
    if (accepted?.tool !== tool) changed = true;
    if (accepted) out.push(accepted.tool);
  });
  return changed ? out : tools;
}

/** The `{ name, pointer, reason }` for which a Gemini route leaves `tool`
 *  out of its requests, or null when the tool is sent. Reports nothing. */
export function geminiToolExclusion(tool) {
  let exclusion = null;
  geminiAcceptedTools([tool], (found) => {
    exclusion = found;
  });
  return exclusion;
}

export function toGeminiNativeTools(nativeTools) {
  if (!Array.isArray(nativeTools)) return [];
  const out = [];
  for (const tool of nativeTools) {
    const type = String(tool?.type || '')
      .trim()
      .toLowerCase();
    if (type === 'google_search' || type === 'google_search_retrieval') {
      out.push({ googleSearch: {} });
    }
  }
  return out;
}

// The request `tools` array: hosted tools first, then one function-declaration
// entry when function tools are present. Empty when neither is present.
export function toGeminiRequestTools(tools, nativeTools, options) {
  const declarations = tools?.length ? toGeminiTools(tools, options) : null;
  // Every function tool may have been left out as invalid for the provider.
  const functionTools = declarations?.functionDeclarations.length ? [declarations] : [];
  return [...toGeminiNativeTools(nativeTools), ...functionTools];
}

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
  for (const source of Array.isArray(citationMetadata.citationSources) ? citationMetadata.citationSources : [])
    add(source);
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

// One tool result: its functionResponse part, plus any media it carried as
// ordinary content parts. The ids pair a call with its response (the Claude
// models behind Antigravity require them) and are harmless for Gemini.
// Multimodal function responses (FunctionResponse.parts) exist on Gemini 3+.
// Older Gemini ids and other families (Claude behind Antigravity) keep media
// as sibling parts of the response turn.
function supportsFunctionResponseParts(model) {
  if (!isGeminiFamilyModel(model)) return false;
  const major = /gemini-(\d+)/i.exec(String(model))?.[1];
  return major === undefined || Number(major) >= 3;
}

// FunctionResponsePart carries only inlineData{mimeType,data}; anything else
// (fileData URIs, parts with mediaResolution/videoMetadata) stays a sibling.
const isNestableMedia = (part) =>
  part?.inlineData && Object.keys(part).length === 1 && Object.keys(part.inlineData).length === 2;

// A failed result travels under `error`, the key Gemini's function-calling
// contract reserves for failures; a successful one keeps `result`.
const isFailedToolResult = (message) => message.toolKind === 'error' || message.isError === true;

// `callsByFinalId` maps a tool result's id to the functionCall the request
// replays for it. The response must name exactly the id that call carries:
// the id the transcript settled on (possibly renamed `-2`) can differ from the
// recorded part, and a recorded Gemini part may carry no id at all, in which
// case the response carries none either. An unmatched result keeps its own id.
function toGeminiToolResult(message, toolNameByCallId, nestMedia, callsByFinalId) {
  const functionName = toolNameByCallId?.get(message.toolCallId) || message.toolCallId || '';
  const { response: rawResponse, mediaParts } = splitGeminiToolContent(message.content);
  const response = isFailedToolResult(message) && 'result' in rawResponse ? { error: rawResponse.result } : rawResponse;
  const functionResponse = { name: functionName, response };
  const replayedCall = callsByFinalId?.get(message.toolCallId);
  const responseId = replayedCall ? replayedCall.id : message.toolCallId;
  if (typeof responseId === 'string' && responseId) functionResponse.id = responseId;
  if (!nestMedia) return { functionResponsePart: { functionResponse }, mediaParts };
  const nested = mediaParts.filter(isNestableMedia);
  if (nested.length) functionResponse.parts = nested;
  return {
    functionResponsePart: { functionResponse },
    mediaParts: mediaParts.filter((part) => !isNestableMedia(part)),
  };
}

// A replay recorded by a non-Gemini model (Claude behind Antigravity) carries
// signatures Gemini rejects: its replay envelope and the signed metadata
// derived from the same response must not reach a Gemini request.
function hasForeignReplay(message) {
  const replay = message?.providerReplay;
  if (replay?.provider !== 'gemini' && replay?.provider !== 'antigravity') return false;
  const recorded = replay.requestContext?.model;
  return typeof recorded === 'string' && recorded !== '' && !isGeminiFamilyModel(recorded);
}

function toGeminiContent(message) {
  if (!message || message.role === 'system') return null;
  const foreign = message.role === 'assistant' && hasForeignReplay(message);
  if (foreign) message = { ...message, providerMetadata: undefined };
  const orderedReplay =
    message.role === 'assistant' && !foreign ? providerReplayItems(message, ['gemini', 'antigravity']) : undefined;
  if (orderedReplay?.length) {
    return { role: 'model', parts: orderedReplay };
  }
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
      if (
        !foreign &&
        typeof tc.thoughtSignature === 'string' &&
        tc.thoughtSignature &&
        tc.thoughtSignature.length <= MAX_THOUGHT_SIGNATURE_CHARS
      ) {
        part.thoughtSignature = tc.thoughtSignature;
      }
      parts.push(part);
    }
    return { role: 'model', parts };
  }
  if (message.role === 'tool') return null;
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts:
      message.role === 'assistant'
        ? geminiTextPartsFromMetadata(message) || normalizeGeminiParts(message.content)
        : normalizeGeminiParts(message.content),
  };
}

function geminiTextPartsFromMetadata(message) {
  const parts = message?.providerMetadata?.gemini?.textParts;
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_REPLAY_PARTS) return null;
  const normalized = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object' || typeof part.text !== 'string' || part.text.length > MAX_REPLAY_TEXT_CHARS)
      return null;
    const next = { text: part.text };
    if (part.thoughtSignature !== undefined) {
      if (
        typeof part.thoughtSignature !== 'string' ||
        !part.thoughtSignature ||
        part.thoughtSignature.length > MAX_THOUGHT_SIGNATURE_CHARS
      )
        return null;
      next.thoughtSignature = part.thoughtSignature;
    }
    normalized.push(next);
  }
  const expected = typeof message.content === 'string' ? message.content : '';
  return normalized.map((part) => part.text).join('') === expected ? normalized : null;
}

function geminiThoughtPartsFromMetadata(message) {
  const parts = message?.providerMetadata?.gemini?.thoughtParts;
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_REPLAY_PARTS) return [];
  const normalized = [];
  for (const part of parts) {
    // Hidden prompt content is replayable only when every persisted part is
    // structurally valid and signed by Gemini. Reject the whole collection
    // on malformed/unsigned data rather than partially accepting metadata.
    if (
      !part ||
      typeof part !== 'object' ||
      typeof part.text !== 'string' ||
      part.text.length > MAX_REPLAY_TEXT_CHARS ||
      typeof part.thoughtSignature !== 'string' ||
      !part.thoughtSignature ||
      part.thoughtSignature.length > MAX_THOUGHT_SIGNATURE_CHARS
    )
      return [];
    normalized.push({
      text: part.text,
      thought: true,
      thoughtSignature: part.thoughtSignature,
    });
  }
  return normalized;
}

export function toGeminiContents(messages, model = '', { repairToolSignatures = true } = {}) {
  const contents = [];
  // Map synthetic toolCallId -> function name from prior assistant
  // tool_calls so each functionResponse part carries the real function name.
  const toolNameByCallId = new Map();
  // Final call id -> the functionCall the request replays for it. Replayed
  // assistant turns are the raw recorded parts, so a generated or renamed id
  // never appears on them. Claude/GPT-OSS routes need the pair to share the
  // final id, so it is stamped on the part; a Gemini part keeps exactly what
  // the server sent (possibly no id) and the response follows it.
  const callsByFinalId = new Map();
  const assistantContent = new Map();
  const stampFinalIds = !!model && !isGeminiFamilyModel(model);
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        if (tc?.id && tc?.name) toolNameByCallId.set(tc.id, tc.name);
      }
      const content = toGeminiContent(m);
      assistantContent.set(m, content);
      const replayed = (content?.parts || []).filter((part) => part?.functionCall);
      m.toolCalls.forEach((tc, index) => {
        if (!tc?.id) return;
        // Positional when the turn replays one call per tool call (the id may
        // be renamed, and a bridged call_tool keeps its wire name and id);
        // otherwise only a part already carrying the id can be matched.
        const part =
          replayed.length === m.toolCalls.length ? replayed[index] : replayed.find((p) => p.functionCall.id === tc.id);
        if (!part) return;
        if (stampFinalIds) part.functionCall.id = tc.id;
        callsByFinalId.set(tc.id, part.functionCall);
      });
    }
  }
  // Consecutive tool results share one user turn: every functionResponse part
  // first (one per call, in call order), then the media the results carried as
  // sibling inlineData/fileData parts.
  let toolTurn = null;
  const nestMedia = supportsFunctionResponseParts(model);
  for (const message of messages) {
    if (message?.role === 'tool') {
      const { functionResponsePart, mediaParts } = toGeminiToolResult(
        message,
        toolNameByCallId,
        nestMedia,
        callsByFinalId
      );
      if (!toolTurn) {
        toolTurn = { content: { role: 'user', parts: [] }, responseCount: 0 };
        contents.push(toolTurn.content);
      }
      toolTurn.content.parts.splice(toolTurn.responseCount, 0, functionResponsePart);
      toolTurn.responseCount += 1;
      toolTurn.content.parts.push(...mediaParts);
      continue;
    }
    toolTurn = null;
    const content = assistantContent.has(message) ? assistantContent.get(message) : toGeminiContent(message);
    if (content) contents.push(content);
  }
  return repairToolSignatures ? ensureGeminiToolCallSignatures(contents, model) : contents;
}

function signedTextPart(part) {
  const out = { text: part.text };
  const signature = part.thoughtSignature || part.thought_signature;
  if (typeof signature === 'string' && signature && signature.length <= MAX_THOUGHT_SIGNATURE_CHARS) {
    out.thoughtSignature = signature;
  }
  return out;
}

export function parseGeminiTextPartMetadata(parts) {
  if (!Array.isArray(parts)) return undefined;
  const thoughtParts = parts
    .filter((part) => part?.thought === true && typeof part?.text === 'string')
    .map(signedTextPart)
    // Unsigned reasoning must never become persisted hidden prompt text.
    .filter((part) => typeof part.thoughtSignature === 'string' && part.thoughtSignature);
  const textParts = parts
    .filter((part) => part?.thought !== true && typeof part?.text === 'string')
    .map(signedTextPart);
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
  if (!calls.length) return undefined;
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
    try {
      process.stderr.write(`[gemini fc raw] ${JSON.stringify(parts)}\n`);
    } catch {}
  }
  return calls.map((p, i) => {
    const fc = p.functionCall;
    const sig = fc.thoughtSignature || fc.thought_signature || p.thoughtSignature || p.thought_signature || null;
    const idHash = traceHash(
      stableTraceStringify({
        index: i,
        name: fc.name || '',
        args: fc.args ?? {},
      })
    ).slice(0, 16);
    const call = {
      // Gemini may provide an opaque server call id. It is a protocol
      // correlation token: preserve it byte-for-byte and synthesize a
      // deterministic id only for older responses that omit it.
      id: typeof fc.id === 'string' && fc.id ? fc.id : `gemini_${idHash}`,
      name: fc.name,
      // Execution may normalize nested arguments in place. Keep native
      // replay and anonymous ID inputs independent of that working copy.
      arguments: structuredClone(fc.args ?? {}),
    };
    if (typeof sig === 'string' && sig && sig.length <= MAX_THOUGHT_SIGNATURE_CHARS) {
      call.thoughtSignature = sig;
    }
    return call;
  });
}

export function emitGeminiToolCalls(toolCalls, onToolCall) {
  if (typeof onToolCall !== 'function' || !Array.isArray(toolCalls)) return;
  const emitted = new Set();
  for (const call of toolCalls) {
    if (!call?.id || !call?.name || emitted.has(call.id)) continue;
    emitted.add(call.id);
    try {
      onToolCall(call);
    } catch {}
  }
}
