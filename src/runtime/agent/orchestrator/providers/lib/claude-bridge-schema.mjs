// Claude tool input schemas on the Antigravity gateway.
//
// The gateway's Claude bridge forwards `parametersJsonSchema` as an Anthropic
// `custom.input_schema`: JSON Schema draft 2020-12 with an object root and no
// root anyOf/oneOf/allOf/not. Following the MCP spec, a schema without
// `$schema` is 2020-12 and a declared dialect is honoured: draft-07 is
// translated to 2020-12 by the standard keyword mapping only (tuple `items` ->
// `prefixItems`, `additionalItems` -> `items`, `definitions` -> `$defs` with
// local refs rewritten, `dependencies` -> dependentRequired/dependentSchemas,
// keywords beside `$ref` dropped as draft-07 ignores them);
// any other dialect is unsupported. The result is checked with Ajv's 2020-12
// meta-schema and ref resolution, then against the provider's root rule. A
// schema that fails is invalid: nothing is rewritten to make it fit.
import Ajv2020 from 'ajv/dist/2020.js';

const MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const NODE_KEYS = [
  'items',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
];
const LIST_KEYS = ['prefixItems', 'allOf', 'anyOf', 'oneOf'];
const ROOT_FORBIDDEN_KEYS = ['anyOf', 'oneOf', 'allOf', 'not'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const escapePointer = (segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
const put = (target, key, value) => {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

class SchemaProblem extends Error {
  constructor(pointer, reason) {
    super(reason);
    this.pointer = pointer;
  }
}

// ---- dialect -----------------------------------------------------------------

function dialectOf(schema) {
  if (schema.$schema === undefined) return '2020-12';
  const declared = typeof schema.$schema === 'string' ? schema.$schema.replace(/^https?:\/\//, '').replace(/#$/, '') : '';
  if (declared === 'json-schema.org/draft/2020-12/schema') return '2020-12';
  if (declared === 'json-schema.org/draft-07/schema') return 'draft-07';
  throw new SchemaProblem('/$schema', `unsupported JSON Schema dialect ${JSON.stringify(schema.$schema)} (supported: 2020-12, draft-07)`);
}

// ---- draft-07 -> 2020-12 -------------------------------------------------------

const isResourceId = (node) => typeof node.$id === 'string' && !node.$id.startsWith('#');
const rewriteRef = (ref) =>
  ref.replace('#/definitions', (match, offset, whole) => {
    const next = whole[offset + match.length];
    return next === undefined || next === '/' ? '#/$defs' : match;
  });

function translateMap(map, ptr) {
  const out = {};
  for (const [name, child] of Object.entries(map)) put(out, name, translateDraft07(child, `${ptr}/${escapePointer(name)}`, false));
  return out;
}

function translateDraft07(node, ptr, isRoot) {
  if (!isPlainObject(node)) return structuredClone(node);
  const resource = isRoot || isResourceId(node);
  const tuple = Array.isArray(node.items);
  const out = {};
  let legacyDefs;
  // Draft-07 ignores every keyword beside `$ref`; 2020-12 evaluates them. Only
  // the reference (and `definitions`, which a pointer ref may still resolve
  // into) is kept, so the translated schema accepts what the original did.
  const isRef = typeof node.$ref === 'string';
  for (const [key, value] of Object.entries(node)) {
    if (isRef && key !== '$ref' && key !== 'definitions') continue;
    const at = `${ptr}/${escapePointer(key)}`;
    if (key === 'items' && tuple) {
      if (Object.hasOwn(node, 'prefixItems')) throw new SchemaProblem(at, 'tuple "items" array conflicts with "prefixItems"');
      put(out, 'prefixItems', value.map((child, i) => translateDraft07(child, `${at}/${i}`, false)));
    } else if (key === 'additionalItems' && tuple) {
      put(out, 'items', translateDraft07(value, at, false));
    } else if (key === 'dependencies' && isPlainObject(value)) {
      if (Object.hasOwn(node, 'dependentRequired') || Object.hasOwn(node, 'dependentSchemas')) {
        throw new SchemaProblem(at, '"dependencies" conflicts with dependentRequired/dependentSchemas');
      }
      for (const [name, dep] of Object.entries(value)) {
        const target = Array.isArray(dep) ? 'dependentRequired' : 'dependentSchemas';
        if (!Object.hasOwn(out, target)) put(out, target, {});
        put(out[target], name, Array.isArray(dep) ? structuredClone(dep) : translateDraft07(dep, `${at}/${escapePointer(name)}`, false));
      }
    } else if (key === 'definitions' && resource && isPlainObject(value)) {
      legacyDefs = { value: translateMap(value, at), at };
    } else if (key === '$ref' && typeof value === 'string') {
      put(out, key, rewriteRef(value));
    } else if (MAP_KEYS.includes(key) && isPlainObject(value)) {
      put(out, key, translateMap(value, at));
    } else if (NODE_KEYS.includes(key)) {
      put(out, key, translateDraft07(value, at, false));
    } else if (LIST_KEYS.includes(key) && Array.isArray(value)) {
      put(out, key, value.map((child, i) => translateDraft07(child, `${at}/${i}`, false)));
    } else {
      put(out, key, structuredClone(value));
    }
  }
  if (legacyDefs) {
    if (Object.hasOwn(out, '$defs')) throw new SchemaProblem(legacyDefs.at, '"definitions" and "$defs" are both present');
    put(out, '$defs', legacyDefs.value);
  }
  return out;
}

// ---- validation ----------------------------------------------------------------

// Where a `$ref` the validator could not resolve is written (diagnostics only).
function refPointer(node, matches, ptr = '') {
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) {
      const found = refPointer(child, matches, `${ptr}/${i}`);
      if (found !== undefined) return found;
    }
  } else if (isPlainObject(node)) {
    if (typeof node.$ref === 'string' && matches(node.$ref)) return `${ptr}/$ref`;
    for (const [key, child] of Object.entries(node)) {
      const found = refPointer(child, matches, `${ptr}/${escapePointer(key)}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function assertValidDraft202012(schema) {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, validateSchema: false });
  if (!ajv.validateSchema(schema)) {
    const [error] = ajv.errors;
    throw new SchemaProblem(error.instancePath, `not a valid JSON Schema 2020-12 schema: ${error.message}`);
  }
  try {
    ajv.compile(schema);
  } catch (error) {
    if (!error.missingRef) throw new SchemaProblem('', error.message);
    const pointer = refPointer(schema, (ref) => error.missingRef === ref || error.missingRef.endsWith(ref)) ?? '';
    throw new SchemaProblem(pointer, `unresolvable $ref "${error.missingRef}"`);
  }
}

function assertAnthropicRoot(schema) {
  if (schema.type !== 'object') throw new SchemaProblem('/type', 'Anthropic input_schema root must have type "object"');
  for (const key of ROOT_FORBIDDEN_KEYS) {
    if (Object.hasOwn(schema, key)) {
      throw new SchemaProblem(`/${key}`, `Anthropic input_schema does not allow a root "${key}"`);
    }
  }
}

function buildSchema(inputSchema) {
  if (!isPlainObject(inputSchema)) throw new SchemaProblem('', 'the input schema must be a JSON object schema');
  const { $schema, ...rest } = inputSchema;
  const schema = dialectOf(inputSchema) === 'draft-07' ? translateDraft07(rest, '', true) : structuredClone(rest);
  assertValidDraft202012(schema);
  assertAnthropicRoot(schema);
  return schema;
}

const cache = new Map();
const CACHE_LIMIT = 256;

/** The draft 2020-12 `parametersJsonSchema` for a Claude tool declaration:
 *  `{ schema }`, or `{ pointer, reason }` (a JSON pointer into the tool's own
 *  input schema) when the schema is invalid under its dialect or for the
 *  provider. Never mutates `inputSchema`. */
export function claudeBridgeInputSchema(inputSchema) {
  let key;
  try {
    key = JSON.stringify(inputSchema) ?? 'undefined';
  } catch {
    key = null;
  }
  let result = key === null ? undefined : cache.get(key);
  if (!result) {
    try {
      result = { schema: buildSchema(inputSchema) };
    } catch (error) {
      if (!(error instanceof SchemaProblem)) throw error;
      result = { pointer: error.pointer, reason: error.message };
    }
    if (key !== null) {
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(key, result);
    }
  }
  return result.schema ? { schema: structuredClone(result.schema) } : result;
}

const warned = new Set();

/** An invalid tool is left out of the request and reported with its name,
 *  index, pointer and reason: to `onToolExcluded({ name, index, pointer,
 *  reason, message })` when given (the agent loop records it for the session),
 *  otherwise once per distinct problem on console.warn. */
export function reportInvalidClaudeTool(toolName, index, { pointer, reason }, onToolExcluded) {
  const at = pointer || '/';
  const message = `[antigravity] Claude tool "${toolName}" (tools[${index}]) excluded: invalid input schema at "${at}": ${reason}`;
  if (typeof onToolExcluded === 'function') {
    return onToolExcluded({ name: toolName, index, pointer: at, reason, message });
  }
  if (warned.has(message)) return undefined;
  warned.add(message);
  return console.warn(message);
}
