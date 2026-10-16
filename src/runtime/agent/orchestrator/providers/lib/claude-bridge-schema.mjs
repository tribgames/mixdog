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

const DRAFT07 = { dropRefSiblings: true, renameDefs: true };
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
export const escapePointer = (segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
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
  const declared =
    typeof schema.$schema === 'string' ? schema.$schema.replace(/^https?:\/\//, '').replace(/#$/, '') : '';
  if (declared === 'json-schema.org/draft/2020-12/schema') return '2020-12';
  if (declared === 'json-schema.org/draft-07/schema') return 'draft-07';
  throw new SchemaProblem(
    '/$schema',
    `unsupported JSON Schema dialect ${JSON.stringify(schema.$schema)} (supported: 2020-12, draft-07)`
  );
}

// ---- draft-07 -> 2020-12 -------------------------------------------------------

const isResourceId = (node) => typeof node.$id === 'string' && !node.$id.startsWith('#');
const rewriteRef = (ref) =>
  ref.replace('#/definitions', (match, offset, whole) => {
    const next = whole[offset + match.length];
    return next === undefined || next === '/' ? '#/$defs' : match;
  });

function translateMap(map, ptr, ctx) {
  const out = {};
  for (const [name, child] of Object.entries(map))
    put(out, name, translateDraft07(child, `${ptr}/${escapePointer(name)}`, false, ctx));
  return out;
}

function translateDraft07(node, ptr, isRoot, ctx) {
  if (!isPlainObject(node)) return structuredClone(node);
  const resource = isRoot || isResourceId(node);
  const tuple = Array.isArray(node.items);
  const out = {};
  let legacyDefs;
  // Draft-07 ignores every keyword beside `$ref`; 2020-12 evaluates them. Only
  // the reference (and `definitions`, which a pointer ref may still resolve
  // into) is kept, so the translated schema accepts what the original did.
  const isRef = ctx.dropRefSiblings && typeof node.$ref === 'string';
  for (const [key, value] of Object.entries(node)) {
    if (isRef && key !== '$ref' && key !== 'definitions') continue;
    const at = `${ptr}/${escapePointer(key)}`;
    // Draft-04 boolean bounds: `minimum: n, exclusiveMinimum: true` is
    // 2020-12's `exclusiveMinimum: n`; `false` is the default.
    if ((key === 'exclusiveMinimum' || key === 'exclusiveMaximum') && typeof value === 'boolean') {
      const bound = key === 'exclusiveMinimum' ? 'minimum' : 'maximum';
      if (value && typeof node[bound] === 'number') put(out, key, node[bound]);
      continue;
    }
    if (
      typeof value === 'number' &&
      ((key === 'minimum' && node.exclusiveMinimum === true) || (key === 'maximum' && node.exclusiveMaximum === true))
    ) {
      continue;
    }
    if (key === 'items' && tuple) {
      if (Object.hasOwn(node, 'prefixItems'))
        throw new SchemaProblem(at, 'tuple "items" array conflicts with "prefixItems"');
      put(
        out,
        'prefixItems',
        value.map((child, i) => translateDraft07(child, `${at}/${i}`, false, ctx))
      );
    } else if (key === 'additionalItems' && tuple) {
      put(out, 'items', translateDraft07(value, at, false, ctx));
    } else if (key === 'dependencies' && isPlainObject(value)) {
      if (Object.hasOwn(node, 'dependentRequired') || Object.hasOwn(node, 'dependentSchemas')) {
        throw new SchemaProblem(at, '"dependencies" conflicts with dependentRequired/dependentSchemas');
      }
      for (const [name, dep] of Object.entries(value)) {
        const target = Array.isArray(dep) ? 'dependentRequired' : 'dependentSchemas';
        if (!Object.hasOwn(out, target)) put(out, target, {});
        put(
          out[target],
          name,
          Array.isArray(dep) ? structuredClone(dep) : translateDraft07(dep, `${at}/${escapePointer(name)}`, false, ctx)
        );
      }
    } else if (key === 'definitions' && resource && ctx.renameDefs && isPlainObject(value)) {
      legacyDefs = { value: translateMap(value, at, ctx), at };
    } else if (key === '$ref' && typeof value === 'string') {
      put(out, key, ctx.renameDefs ? rewriteRef(value) : value);
    } else if (MAP_KEYS.includes(key) && isPlainObject(value)) {
      put(out, key, translateMap(value, at, ctx));
    } else if (NODE_KEYS.includes(key)) {
      put(out, key, translateDraft07(value, at, false, ctx));
    } else if (LIST_KEYS.includes(key) && Array.isArray(value)) {
      put(
        out,
        key,
        value.map((child, i) => translateDraft07(child, `${at}/${i}`, false, ctx))
      );
    } else {
      put(out, key, structuredClone(value));
    }
  }
  if (legacyDefs) {
    if (Object.hasOwn(out, '$defs'))
      throw new SchemaProblem(legacyDefs.at, '"definitions" and "$defs" are both present');
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
  // Draft-04 `id` is an annotation providers ignore; Ajv would refuse it.
  ajv.removeKeyword('id');
  ajv.addKeyword('id');
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

// `rule`: 'anthropic' (object root, no root combinators), 'openai' (object
// root) or 'gemini' (object root, or no type at all).
function assertObjectRoot(schema, rule) {
  const label = rule === 'anthropic' ? 'Anthropic input_schema root' : 'the input schema root';
  if (rule === 'gemini' && schema.type === undefined) return;
  if (schema.type !== 'object') throw new SchemaProblem('/type', `${label} must have type "object"`);
  if (rule !== 'anthropic') return;
  for (const key of ROOT_FORBIDDEN_KEYS) {
    if (Object.hasOwn(schema, key)) {
      throw new SchemaProblem(`/${key}`, `Anthropic input_schema does not allow a root "${key}"`);
    }
  }
}

function buildSchema(inputSchema) {
  if (!isPlainObject(inputSchema)) throw new SchemaProblem('', 'the input schema must be a JSON object schema');
  const { $schema, ...rest } = inputSchema;
  const schema =
    dialectOf(inputSchema) === 'draft-07' ? translateDraft07(rest, '', true, DRAFT07) : structuredClone(rest);
  assertValidDraft202012(schema);
  assertObjectRoot(schema, 'anthropic');
  return schema;
}

// ---- per-wire normalization -----------------------------------------------------
//
// A schema the wire accepts as written is sent as written (byte-identical, so
// the prompt cache holds). Only a schema that fails validation is repaired --
// draft-07/04 constructs lowered to 2020-12 (tuple `items`, `definitions`,
// `dependencies`, boolean exclusive bounds, keywords beside `$ref`), a missing
// root `type` filled in -- and re-validated; what still fails is excluded.

function repairRoot(schema) {
  const { type } = schema;
  if (Array.isArray(type) && type.includes('object')) return { ...schema, type: 'object' };
  if (type !== undefined || Object.hasOwn(schema, '$ref')) return schema;
  const out = { type: 'object', ...schema };
  if (!Object.hasOwn(out, 'properties') && !ROOT_FORBIDDEN_KEYS.some((k) => Object.hasOwn(out, k))) out.properties = {};
  return out;
}

// Whether any `$ref` points into a draft-07 `#/definitions` table.
function refsIntoDefinitions(node) {
  if (Array.isArray(node)) return node.some(refsIntoDefinitions);
  if (!isPlainObject(node)) return false;
  return Object.entries(node).some(
    ([key, value]) =>
      (key === '$ref' && typeof value === 'string' && /^#\/definitions(\/|$)/.test(value)) || refsIntoDefinitions(value)
  );
}

// Only a schema that declares draft-07/04 gets draft-07 `$ref` semantics
// (keywords beside `$ref` ignored); otherwise siblings are real constraints.
const declaresLegacyDraft = ($schema) => typeof $schema === 'string' && /draft-0[4-7]/.test($schema);

/** The lowered copy of a tool input schema for `rule`, or null when it cannot
 *  be lowered. Fixes only what validation rejects: tuple `items`, boolean
 *  exclusive bounds, `dependencies`, draft-07 `definitions` refs and the root
 *  `type`. Never mutates `inputSchema`. */
export function repairedToolInputSchema(inputSchema, rule) {
  if (!isPlainObject(inputSchema)) return null;
  const { $schema, ...rest } = inputSchema;
  try {
    const lowered = translateDraft07(rest, '', true, {
      dropRefSiblings: declaresLegacyDraft($schema),
      renameDefs: refsIntoDefinitions(rest),
    });
    return rule === 'gemini' ? lowered : repairRoot(lowered);
  } catch (error) {
    if (error instanceof SchemaProblem) return null;
    throw error;
  }
}

const wireProblems = new Map();

/** Why `schema` is not accepted as written on a `rule` wire, as `{ pointer,
 *  reason }`, or null. `$schema` is not validated against (the provider reads
 *  the keywords, not the dialect). */
function wireProblem(schema, rule) {
  let key;
  try {
    key = `${rule}\0${JSON.stringify(schema) ?? 'undefined'}`;
  } catch {
    key = null;
  }
  if (key !== null && wireProblems.has(key)) return wireProblems.get(key);
  let problem = null;
  try {
    if (!isPlainObject(schema)) throw new SchemaProblem('', 'the input schema must be a JSON object schema');
    const { $schema, ...rest } = schema;
    assertValidDraft202012(rest);
    assertObjectRoot(rest, rule);
  } catch (error) {
    if (!(error instanceof SchemaProblem)) throw error;
    problem = { pointer: error.pointer, reason: error.message };
  }
  if (key !== null) {
    if (wireProblems.size >= CACHE_LIMIT) wireProblems.clear();
    wireProblems.set(key, problem);
  }
  return problem;
}

/** The schema to send for a tool on a `rule` wire: `{ schema }` (the same
 *  object when it is accepted as written, else its lowered copy), or `{
 *  pointer, reason }` when it is broken even after lowering. */
export function wireInputSchema(inputSchema, rule) {
  const problem = wireProblem(inputSchema, rule);
  if (!problem) return { schema: inputSchema };
  const repaired = repairedToolInputSchema(inputSchema, rule);
  const remaining = repaired ? wireProblem(repaired, rule) : problem;
  return remaining || { schema: repaired };
}

/** `tools` with each unacceptable one left out (reported through
 *  `onToolExcluded`) and each repairable one carrying its lowered schema; the
 *  same array when nothing changed. A tool without a schema is sent as
 *  written, as is any tool `isExempt` names (no JSON schema on the wire). */
export function acceptedWireTools(tools, rule, onToolExcluded, source, isExempt = () => false) {
  let changed = false;
  const out = [];
  tools.forEach((tool, index) => {
    const schema = tool?.inputSchema;
    if (schema == null || isExempt(tool)) {
      out.push(tool);
      return;
    }
    const result = wireInputSchema(schema, rule);
    if (!result.schema) {
      reportInvalidTool(tool.name, index, result, onToolExcluded, source);
      changed = true;
    } else if (result.schema !== schema) {
      out.push({ ...tool, inputSchema: result.schema });
      changed = true;
    } else out.push(tool);
  });
  return changed ? out : tools;
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
      // Not valid as written: lower undeclared draft-07/04 constructs and
      // fill the root type; only a schema still broken is excluded.
      const repaired = repairedToolInputSchema(inputSchema, 'anthropic');
      result =
        repaired && !wireProblem(repaired, 'anthropic')
          ? { schema: repaired }
          : { pointer: error.pointer, reason: error.message };
    }
    if (key !== null) {
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(key, result);
    }
  }
  return result.schema ? { schema: structuredClone(result.schema) } : result;
}

/** Why `schema` is not a valid Gemini `parametersJsonSchema` (a JSON Schema
 *  2020-12 schema with an object root), as `{ pointer, reason }` into the
 *  schema, or null when it is valid. Never mutates `schema`. */
export const geminiJsonSchemaProblem = (schema) => wireProblem(schema, 'gemini');

const warned = new Set();

/** An invalid tool is left out of the request and reported with its name,
 *  index, pointer and reason: to `onToolExcluded({ name, index, pointer,
 *  reason, message })` when given (the agent loop records it for the session),
 *  otherwise once per distinct problem on console.warn. `source` prefixes the
 *  console message (which route and kind of tool). */
export function reportInvalidTool(
  toolName,
  index,
  { pointer, reason },
  onToolExcluded,
  source = '[antigravity] Claude tool'
) {
  const at = pointer || '/';
  const message = `${source} "${toolName}" (tools[${index}]) excluded: invalid input schema at "${at}": ${reason}`;
  if (typeof onToolExcluded === 'function') {
    return onToolExcluded({ name: toolName, index, pointer: at, reason, message });
  }
  if (warned.has(message)) return undefined;
  warned.add(message);
  return console.warn(message);
}
