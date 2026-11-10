// Tool parameter schemas on the Devin wire.
//
// devinToolWireSchema: every tool's JSON Schema upgraded to draft 2020-12
// (definitions → $defs, tuple items → prefixItems, dependencies split,
// OpenAPI `nullable` → null unions), nullable scalar unions folded into a
// type array, bare enums typed, homogeneous const unions folded into an enum,
// and empty subschemas written as `true`.
//
// devinGoogleToolSchema: the projection Gemini backends accept: refs inlined,
// unsupported keywords stripped (the human-meaningful ones spilled into the
// description), type arrays scalarized with `nullable`, const unions folded
// into string enums, object property order made explicit.

// ── JSON helpers ─────────────────────────────────────────────────────────────
const isJsonObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isEmptyObject = (value) => isJsonObject(value) && Object.keys(value).length === 0;

function jsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => jsonEqual(entry, right[index]));
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => key in right && jsonEqual(left[key], right[key]));
}

// RFC 6901 tokens of a local `$ref` fragment; undefined for a non-local ref.
function parseLocalRefPointer(ref) {
  if (!ref.startsWith('#')) return undefined;
  let pointer;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  if (pointer.length > 0 && !pointer.startsWith('/')) return undefined;
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function formatLocalRefPointer(tokens) {
  if (!tokens.length) return '#';
  const encoded = tokens
    .map((token) => encodeURIComponent(token.replace(/~/g, '~0').replace(/\//g, '~1')))
    .map((token) => token.replace(/%24/g, '$'));
  return `#/${encoded.join('/')}`;
}

// ── Draft 2020-12 upgrade ────────────────────────────────────────────────────
const DRAFT_07_SCHEMA_URIS = new Set([
  'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-07/schema',
]);
const DRAFT_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema';
const UPGRADE_MAP_KEYS = new Set(['properties', 'patternProperties', 'dependentSchemas']);
const UPGRADE_VALUE_KEYS = new Set([
  'const',
  'default',
  'enum',
  'example',
  'examples',
  'required',
  'dependentRequired',
  'type',
]);

function needsUpgrade(value, seen) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.some((entry) => needsUpgrade(entry, seen));
  }
  if (!isJsonObject(value) || seen.has(value)) return false;
  seen.add(value);
  for (const key in value) {
    const entry = value[key];
    if (key === '$schema') {
      if (typeof entry === 'string' && DRAFT_07_SCHEMA_URIS.has(entry)) return true;
      continue;
    }
    if (key === 'definitions' || key === 'dependencies' || key === 'additionalItems' || key === 'nullable') return true;
    if (key === '$ref') {
      if (typeof entry === 'string' && entry.startsWith('#/definitions/')) return true;
      continue;
    }
    if (key === 'items' && Array.isArray(entry)) return true;
    if (key === '$defs' || UPGRADE_MAP_KEYS.has(key)) {
      if (isJsonObject(entry) && Object.values(entry).some((child) => needsUpgrade(child, seen))) return true;
      continue;
    }
    if (UPGRADE_VALUE_KEYS.has(key)) continue;
    if (needsUpgrade(entry, seen)) return true;
  }
  return false;
}

function objectMap(target, key) {
  if (isJsonObject(target[key])) return target[key];
  target[key] = {};
  return target[key];
}

function combineSchemas(left, right) {
  if (left === undefined || left === true) return right;
  if (right === undefined || right === true) return left;
  if (left === false || right === false) return false;
  if (jsonEqual(left, right)) return left;
  return { allOf: [left, right] };
}

function makeNullable(schema) {
  const { type } = schema;
  if (typeof type === 'string') {
    if (type !== 'null') schema.type = [type, 'null'];
    return schema;
  }
  if (Array.isArray(type)) {
    if (!type.includes('null')) schema.type = [...type, 'null'];
    return schema;
  }
  if (Array.isArray(schema.anyOf)) {
    const hasNull = schema.anyOf.some(
      (variant) =>
        isJsonObject(variant) &&
        (variant.type === 'null' || (Array.isArray(variant.type) && variant.type.includes('null')))
    );
    if (!hasNull) schema.anyOf = [...schema.anyOf, { type: 'null' }];
    return schema;
  }
  return { anyOf: [schema, { type: 'null' }] };
}

function upgradeNode(value, cache) {
  if (Array.isArray(value)) {
    if (cache.has(value)) return cache.get(value);
    const result = [];
    cache.set(value, result);
    for (const entry of value) result.push(upgradeNode(entry, cache));
    return result;
  }
  if (!isJsonObject(value)) return value;
  if (cache.has(value)) return cache.get(value);
  const result = {};
  cache.set(value, result);
  const mergeMap = (key, map) => {
    const target = objectMap(result, key);
    for (const name in map) target[name] = upgradeNode(map[name], cache);
  };
  for (const key in value) {
    const entry = value[key];
    if (key === 'definitions' || key === '$defs') {
      if (isJsonObject(entry)) mergeMap('$defs', entry);
      continue;
    }
    if (UPGRADE_MAP_KEYS.has(key)) {
      if (isJsonObject(entry)) mergeMap(key, entry);
      else result[key] = entry;
      continue;
    }
    if (UPGRADE_VALUE_KEYS.has(key)) {
      result[key] = entry;
      continue;
    }
    if (key === 'dependencies' || key === 'additionalItems' || key === 'nullable') continue;
    if (key === '$schema') {
      result.$schema = typeof entry === 'string' && DRAFT_07_SCHEMA_URIS.has(entry) ? DRAFT_2020_12_URI : entry;
      continue;
    }
    if (key === '$ref' && typeof entry === 'string') {
      const pointer = parseLocalRefPointer(entry);
      result.$ref =
        pointer === undefined || pointer[0] !== 'definitions'
          ? entry
          : formatLocalRefPointer(['$defs', ...pointer.slice(1)]);
      continue;
    }
    if (key === 'items' && Array.isArray(entry)) continue;
    result[key] = upgradeNode(entry, cache);
  }
  if (Array.isArray(value.items)) {
    const converted = upgradeNode(value.items, cache);
    if (Array.isArray(result.prefixItems)) {
      const merged = [...result.prefixItems];
      converted.forEach((item, index) => {
        merged[index] = index in merged ? combineSchemas(merged[index], item) : item;
      });
      result.prefixItems = merged;
    } else {
      result.prefixItems = converted;
    }
    if (value.additionalItems !== undefined && value.additionalItems !== true) {
      result.items = upgradeNode(value.additionalItems, cache);
    } else {
      delete result.items;
    }
  }
  if (isJsonObject(value.dependencies)) {
    for (const key in value.dependencies) {
      const converted = upgradeNode(value.dependencies[key], cache);
      if (Array.isArray(converted)) {
        const required = objectMap(result, 'dependentRequired');
        const existing = required[key];
        if (existing === undefined) required[key] = converted;
        else if (Array.isArray(existing)) {
          const merged = [...existing];
          for (const dep of converted) if (!merged.some((item) => jsonEqual(item, dep))) merged.push(dep);
          required[key] = merged;
        }
      } else {
        const schemas = objectMap(result, 'dependentSchemas');
        schemas[key] = combineSchemas(schemas[key], converted);
      }
    }
  }
  if (value.nullable === true) {
    const nullable = makeNullable(result);
    if (nullable !== result) cache.set(value, nullable);
    return nullable;
  }
  return result;
}

function upgradeTo202012(schema) {
  return needsUpgrade(schema, new Set()) ? upgradeNode(schema, new Map()) : schema;
}

// ── Wire post-processing ─────────────────────────────────────────────────────
const NULLABLE_SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const SCHEMA_DEFINING_SIBLING_KEYS = new Set([
  '$ref',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'enum',
  'if',
  'items',
  'not',
  'oneOf',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
const WIRE_VALUE_KEYS = [
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'items',
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
  'not',
];
const WIRE_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions'];
const WIRE_ARRAY_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];

const hasSchemaDefiningSibling = (schema) =>
  Object.keys(schema).some((key) => key !== 'anyOf' && SCHEMA_DEFINING_SIBLING_KEYS.has(key));

function homogeneousScalarType(values) {
  if (!values.length) return undefined;
  let inferred;
  for (const value of values) {
    const type = typeof value;
    if (type !== 'string' && type !== 'boolean' && type !== 'number') return undefined;
    if (inferred === undefined) inferred = type;
    else if (inferred !== type) return undefined;
  }
  return inferred;
}

// `anyOf: [{type: T, ...}, {type: 'null'}]` → `type: [T, 'null']`.
function rewriteNullableScalarAnyOf(schema) {
  if (hasSchemaDefiningSibling(schema)) return;
  const variants = schema.anyOf;
  if (!Array.isArray(variants) || variants.length !== 2) return;
  let scalar;
  let sawNull = false;
  for (const variant of variants) {
    if (!isJsonObject(variant)) return;
    if (variant.type === 'null' && Object.keys(variant).length === 1) {
      if (sawNull) return;
      sawNull = true;
      continue;
    }
    if (!(typeof variant.type === 'string' && NULLABLE_SCALAR_TYPES.has(variant.type)) || scalar) return;
    scalar = variant;
  }
  if (!sawNull || !scalar) return;
  delete schema.anyOf;
  for (const key in scalar) {
    if (key === 'type' || key === 'enum' || key === 'const' || Object.hasOwn(schema, key)) continue;
    schema[key] = scalar[key];
  }
  if (Object.hasOwn(scalar, 'const')) schema.enum = [scalar.const, null];
  else if (Array.isArray(scalar.enum)) schema.enum = scalar.enum.includes(null) ? scalar.enum : [...scalar.enum, null];
  schema.type = [scalar.type, 'null'];
}

function inferBareEnumScalarType(schema) {
  if ('type' in schema || !Array.isArray(schema.enum)) return;
  const inferred = homogeneousScalarType(schema.enum);
  if (inferred !== undefined) schema.type = inferred;
}

// A homogeneous `anyOf` of bare `{ const }` branches → `{ type, enum }`.
function collapseConstUnionAnyOf(schema) {
  if (hasSchemaDefiningSibling(schema) || 'type' in schema) return;
  const variants = schema.anyOf;
  if (!Array.isArray(variants) || variants.length < 2) return;
  const values = [];
  let branchDescription;
  let described = 0;
  for (const variant of variants) {
    if (!isJsonObject(variant) || !Object.hasOwn(variant, 'const')) return;
    if (Object.keys(variant).some((key) => key !== 'const' && key !== 'description')) return;
    if (typeof variant.description === 'string') {
      if (described === 0) branchDescription = variant.description;
      else if (variant.description !== branchDescription) return;
      described += 1;
    }
    values.push(variant.const);
  }
  if (described !== 0 && described !== variants.length) return;
  if (
    described === variants.length &&
    typeof schema.description === 'string' &&
    schema.description !== branchDescription
  ) {
    return;
  }
  const type = homogeneousScalarType(values);
  if (type === undefined) return;
  delete schema.anyOf;
  schema.type = type;
  schema.enum = values;
  if (typeof schema.description !== 'string' && branchDescription !== undefined) schema.description = branchDescription;
}

function walkWire(node) {
  if (Array.isArray(node)) {
    for (const child of node) walkWire(child);
    return;
  }
  if (!node || typeof node !== 'object') return;
  rewriteNullableScalarAnyOf(node);
  inferBareEnumScalarType(node);
  collapseConstUnionAnyOf(node);
  for (const key in node) walkWire(node[key]);
}

// `name /** description */` property keys carry their description inline.
function parseCommentKey(key) {
  const match = /^(.*?)\s*\/\*\*\s*([\s\S]*?)\s*\*\/\s*$/.exec(key);
  return match ? { name: match[1].trim(), description: match[2].trim() } : { name: key };
}

function withKeyDescription(schema, description) {
  if (!description) return schema;
  if (isJsonObject(schema)) {
    if (typeof schema.description !== 'string') schema.description = description;
    return schema;
  }
  return { anyOf: [schema], description };
}

function normalizePropertyComments(node) {
  if (Array.isArray(node)) {
    for (const child of node) normalizePropertyComments(child);
    return;
  }
  if (!isJsonObject(node)) return;
  if (isJsonObject(node.properties)) {
    const { properties } = node;
    if (Array.isArray(node.required)) {
      node.required = node.required.map((key) => (typeof key === 'string' ? parseCommentKey(key).name : key));
    }
    for (const key of Object.keys(properties)) {
      const parsed = parseCommentKey(key);
      let schema = properties[key];
      if (parsed.description) {
        schema = withKeyDescription(schema, parsed.description);
        delete properties[key];
        properties[parsed.name] = schema;
      }
      normalizePropertyComments(schema);
    }
  }
  for (const key of WIRE_VALUE_KEYS) if (Object.hasOwn(node, key)) normalizePropertyComments(node[key]);
  for (const key of WIRE_MAP_KEYS) {
    if (key === 'properties' || !isJsonObject(node[key])) continue;
    for (const name in node[key]) normalizePropertyComments(node[key][name]);
  }
  for (const key of WIRE_ARRAY_KEYS)
    if (Array.isArray(node[key])) for (const child of node[key]) normalizePropertyComments(child);
}

// `{}` (unconstrained) → `true` in every schema-valued position.
function normalizeEmptySchemas(node) {
  if (Array.isArray(node)) {
    for (const child of node) normalizeEmptySchemas(child);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const key of WIRE_VALUE_KEYS) if (Object.hasOwn(node, key) && isEmptyObject(node[key])) node[key] = true;
  for (const key of WIRE_MAP_KEYS) {
    const map = node[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const name in map) if (isEmptyObject(map[name])) map[name] = true;
  }
  for (const key of WIRE_ARRAY_KEYS) {
    const list = node[key];
    if (Array.isArray(list)) for (let i = 0; i < list.length; i += 1) if (isEmptyObject(list[i])) list[i] = true;
  }
  for (const key in node) normalizeEmptySchemas(node[key]);
}

/** A tool's input schema as every Devin request carries it (a fresh copy). */
export function devinToolWireSchema(inputSchema) {
  const copy = JSON.parse(JSON.stringify(inputSchema ?? {}));
  const upgraded = upgradeTo202012(copy);
  walkWire(upgraded);
  normalizePropertyComments(upgraded);
  normalizeEmptySchemas(upgraded);
  return upgraded;
}

// ── Ref inlining ─────────────────────────────────────────────────────────────
const DEREF_MAP_KEYS = new Set(['properties', 'patternProperties', 'dependencies', 'dependentSchemas']);
const DEREF_ARRAY_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const DEREF_VALUE_KEYS = new Set([
  'items',
  'additionalItems',
  'contains',
  'contentSchema',
  'propertyNames',
  'if',
  'then',
  'else',
  'not',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

function dereferenceKeyword(key, value, root, visiting) {
  if (DEREF_MAP_KEYS.has(key) && isJsonObject(value)) {
    const result = {};
    for (const name in value) result[name] = dereferenceNode(value[name], root, visiting);
    return result;
  }
  if ((DEREF_ARRAY_KEYS.has(key) || key === 'items') && Array.isArray(value)) {
    return value.map((item) => dereferenceNode(item, root, visiting));
  }
  if (DEREF_VALUE_KEYS.has(key)) return dereferenceNode(value, root, visiting);
  return value;
}

function resolveLocalRef(ref, root) {
  const pointer = parseLocalRefPointer(ref);
  if (pointer === undefined || pointer.length !== 2) return undefined;
  const [defsKey, name] = pointer;
  if (defsKey !== '$defs' && defsKey !== 'definitions') return undefined;
  const defs = root[defsKey];
  if (!isJsonObject(defs)) return undefined;
  return isJsonObject(defs[name]) ? defs[name] : undefined;
}

function dereferenceNode(node, root, visiting) {
  if (!isJsonObject(node)) return node;
  const ref = node.$ref;
  if (typeof ref === 'string') {
    if (visiting.has(ref)) return {};
    const resolved = resolveLocalRef(ref, root);
    if (!resolved) return node;
    visiting.add(ref);
    const inlined = dereferenceNode(resolved, root, visiting);
    visiting.delete(ref);
    const siblings = Object.keys(node).filter((key) => key !== '$ref' && key !== '$defs' && key !== 'definitions');
    if (!siblings.length || !isJsonObject(inlined)) return inlined;
    const merged = { ...inlined };
    for (const key of siblings) merged[key] = dereferenceKeyword(key, node[key], root, visiting);
    return merged;
  }
  const result = {};
  for (const key in node) {
    if (key === '$defs' || key === 'definitions') continue;
    result[key] = dereferenceKeyword(key, node[key], root, visiting);
  }
  return result;
}

function dereferenceSchema(schema) {
  if (!isJsonObject(schema) || (schema.$defs === undefined && schema.definitions === undefined)) return schema;
  return dereferenceNode(schema, schema, new Set());
}

// ── Google projection ────────────────────────────────────────────────────────
const GOOGLE_UNSUPPORTED_FIELDS = new Set([
  '$schema',
  '$id',
  '$anchor',
  '$ref',
  '$defs',
  '$dynamicRef',
  '$dynamicAnchor',
  'examples',
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'additionalItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'format',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'dependencies',
  'dependentSchemas',
  'dependentRequired',
  'x-mcp-header',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$comment',
]);
// Stripped keywords whose meaning is kept as text in the description.
const DESCRIPTION_SPILL_FIELDS = new Set([
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'default',
  'examples',
]);
const SNAKE_TO_CAMEL = new Map([
  ['additional_properties', 'additionalProperties'],
  ['any_of', 'anyOf'],
  ['prefix_items', 'prefixItems'],
  ['property_ordering', 'propertyOrdering'],
]);
const TYPE_SPECIFIC_KEYS = Object.freeze({
  array: new Set([
    'items',
    'prefixItems',
    'contains',
    'minContains',
    'maxContains',
    'minItems',
    'maxItems',
    'uniqueItems',
    'unevaluatedItems',
  ]),
  object: new Set([
    'properties',
    'required',
    'additionalProperties',
    'patternProperties',
    'propertyNames',
    'minProperties',
    'maxProperties',
    'dependentRequired',
    'dependentSchemas',
    'unevaluatedProperties',
  ]),
  string: new Set(['minLength', 'maxLength', 'pattern', 'format', 'contentEncoding', 'contentMediaType']),
  number: new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']),
  integer: new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']),
  boolean: new Set(),
  null: new Set(),
});
const ALL_TYPE_SPECIFIC_KEYS = new Set(Object.values(TYPE_SPECIFIC_KEYS).flatMap((keys) => [...keys]));
const CHILD_VALUE_KEYS = new Set([
  'items',
  'additionalItems',
  'unevaluatedItems',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'contentSchema',
]);
const CHILD_OR_BOOLEAN_KEYS = new Set(['additionalProperties', 'unevaluatedProperties']);
const CHILD_ARRAY_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const CHILD_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  'dependencies',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

// 'schema' / 'map' for a JSON Schema-valued child; undefined for instance data.
function childKind(key, value, insideMap) {
  if (insideMap) return 'schema';
  const name = SNAKE_TO_CAMEL.get(key) ?? key;
  if (CHILD_MAP_KEYS.has(name)) return 'map';
  if (CHILD_VALUE_KEYS.has(name) || CHILD_ARRAY_KEYS.has(name)) return 'schema';
  if (CHILD_OR_BOOLEAN_KEYS.has(name) && isJsonObject(value)) return 'schema';
  return undefined;
}

// Whether a `not` subtree constrains values Google's string-only enums cannot express.
function hasNonStringEnumConstraint(value, insideMap = false, seen = new Set()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.some((entry) => hasNonStringEnumConstraint(entry, false, seen));
  }
  if (!isJsonObject(value) || seen.has(value)) return false;
  seen.add(value);
  if (insideMap) return Object.values(value).some((entry) => hasNonStringEnumConstraint(entry, false, seen));
  if (Array.isArray(value.enum) && (value.enum.length === 0 || value.enum.some((entry) => typeof entry !== 'string'))) {
    return true;
  }
  if (Object.hasOwn(value, 'const') && typeof value.const !== 'string') return true;
  for (const key in value) {
    const kind = childKind(key, value[key], false);
    if (kind && hasNonStringEnumConstraint(value[key], kind === 'map', seen)) return true;
  }
  return false;
}

function renameSnakeKeys(obj) {
  if (!Object.keys(obj).some((key) => SNAKE_TO_CAMEL.has(key))) return obj;
  const out = {};
  for (const key in obj) {
    const renamed = SNAKE_TO_CAMEL.get(key);
    if (renamed !== undefined) out[renamed] = obj[key];
    else if (!Object.hasOwn(out, key)) out[key] = obj[key];
  }
  return out;
}

// `type: 'null'` → `nullable`; a null branch of `anyOf` → `nullable`.
function preHandleNullFields(obj) {
  if (obj.type === 'null') {
    const out = {};
    for (const key in obj) if (key !== 'type') out[key] = obj[key];
    out.nullable = true;
    return out;
  }
  if (!Array.isArray(obj.anyOf)) return obj;
  const kept = obj.anyOf.filter((variant) => !(isJsonObject(variant) && variant.type === 'null'));
  if (kept.length === obj.anyOf.length) return obj;
  const out = { ...obj, nullable: true };
  if (!kept.length) delete out.anyOf;
  else if (kept.length === 1 && isJsonObject(kept[0])) {
    delete out.anyOf;
    for (const key in kept[0]) if (!Object.hasOwn(out, key)) out[key] = kept[0][key];
  } else out.anyOf = kept;
  return out;
}

// A multi-type array → one `anyOf` branch per non-null type with its own keywords.
function splitTypeArray(obj) {
  if (!Array.isArray(obj.type) || Array.isArray(obj.anyOf)) return obj;
  const types = [];
  for (const type of obj.type)
    if (typeof type === 'string' && type !== 'null' && !types.includes(type)) types.push(type);
  if (types.length < 2) return obj;
  const branches = types.map((type) => ({ schema: { type }, keys: TYPE_SPECIFIC_KEYS[type] ?? new Set() }));
  const out = {};
  for (const key in obj) {
    if (key === 'type') continue;
    if (!ALL_TYPE_SPECIFIC_KEYS.has(key)) {
      out[key] = obj[key];
      continue;
    }
    for (const branch of branches) if (branch.keys.has(key)) branch.schema[key] = obj[key];
  }
  if (obj.type.includes('null')) out.nullable = true;
  out.anyOf = branches.map((branch) => branch.schema);
  return out;
}

function inferTypeFromValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'object' ? type : undefined;
}

function pushUnique(values, value) {
  if (!values.some((existing) => jsonEqual(existing, value))) values.push(value);
}

function spillToDescription(node, entries) {
  const spilled = entries.filter(([, value]) => value !== undefined);
  if (!spilled.length) return;
  const formatted = `{${spilled.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')}}`;
  const existing = typeof node.description === 'string' ? node.description : '';
  node.description = existing ? `${existing}\n\n${formatted}` : formatted;
}

function googleNode(value, ctx, path) {
  if (Array.isArray(value)) {
    if (path.has(value)) return [];
    path.add(value);
    try {
      return value.map((entry) => googleNode(entry, ctx, path));
    } finally {
      path.delete(value);
    }
  }
  if (typeof value === 'boolean') {
    if (!ctx.subschema) return value;
    return value ? {} : { not: {} };
  }
  if (!isJsonObject(value)) return value;
  if (path.has(value)) return {};
  path.add(value);
  try {
    return googleObject(value, ctx, path);
  } finally {
    path.delete(value);
  }
}

function googleChild(key, entry, ctx, path) {
  const kind = childKind(key, entry, ctx.insideMap);
  return kind ? googleNode(entry, { insideMap: kind === 'map', subschema: kind === 'schema' }, path) : entry;
}

// Copies one keyword onto `result`, or records it for the description spill.
function copyKeyword(result, key, entry, ctx, path, spill) {
  if (!ctx.insideMap && GOOGLE_UNSUPPORTED_FIELDS.has(key)) {
    if (DESCRIPTION_SPILL_FIELDS.has(key)) spill.push([key, entry]);
    return;
  }
  if (!ctx.insideMap && key === 'not' && hasNonStringEnumConstraint(entry)) return;
  result[key] = googleChild(key, entry, ctx, path);
}

// Google's enum takes strings only: any other enum is omitted, the type kept.
function finishNode(result, ctx) {
  if (ctx.subschema && Array.isArray(result.enum)) {
    const stringEnum = result.enum.length > 0 && result.enum.every((value) => typeof value === 'string');
    if (!stringEnum) {
      const { enum: _dropped, ...rest } = result;
      return rest;
    }
  }
  return result;
}

function googleObject(value, ctx, path) {
  let obj = ctx.insideMap ? value : renameSnakeKeys(value);
  if (!ctx.insideMap) obj = preHandleNullFields(splitTypeArray(obj));
  const result = {};
  const spill = [];

  // An `anyOf`/`oneOf` of const branches becomes one enum.
  for (const combiner of ['anyOf', 'oneOf']) {
    const variants = obj[combiner];
    if (!Array.isArray(variants) || !variants.length || !variants.every((v) => isJsonObject(v) && 'const' in v))
      continue;
    const values = [];
    for (const variant of variants) pushUnique(values, variant.const);
    result.enum = values;
    const explicit = variants.map((variant) => variant.type).filter((type) => typeof type === 'string');
    if (explicit.length === variants.length && explicit.every((type) => type === explicit[0]) && explicit[0]) {
      result.type = explicit[0];
    } else {
      const inferred = values.map(inferTypeFromValue).filter((type) => type !== undefined);
      if (new Set(inferred).size === 1) result.type = inferred[0];
      else {
        const nonNull = inferred.filter((type) => type !== 'null');
        if (inferred.includes('null') && new Set(nonNull).size === 1) {
          result.type = nonNull[0];
          result.nullable = true;
        }
      }
    }
    for (const key in obj) {
      if (key === combiner || Object.hasOwn(result, key)) continue;
      copyKeyword(result, key, obj[key], ctx, path, spill);
    }
    spillToDescription(result, spill);
    return finishNode(result, ctx);
  }

  let constValue;
  for (const key in obj) {
    if (!ctx.insideMap && GOOGLE_UNSUPPORTED_FIELDS.has(key)) {
      if (DESCRIPTION_SPILL_FIELDS.has(key)) spill.push([key, obj[key]]);
      continue;
    }
    if (key === 'const') {
      constValue = obj[key];
      continue;
    }
    copyKeyword(result, key, obj[key], ctx, path, spill);
  }
  if (Array.isArray(result.type)) {
    const types = result.type.filter((type) => typeof type === 'string');
    const nonNull = types.filter((type) => type !== 'null');
    if (types.includes('null')) result.nullable = true;
    result.type = nonNull[0] ?? types[0];
    if (typeof result.type === 'string') {
      const allowed = TYPE_SPECIFIC_KEYS[result.type] ?? new Set();
      for (const key in result) if (ALL_TYPE_SPECIFIC_KEYS.has(key) && !allowed.has(key)) delete result[key];
    }
  }
  if (constValue !== undefined) {
    const values = Array.isArray(result.enum) ? result.enum : [];
    pushUnique(values, constValue);
    result.enum = values;
    if (!result.type) result.type = inferTypeFromValue(constValue);
  }
  if (
    !result.type &&
    !Array.isArray(result.anyOf) &&
    !Array.isArray(result.oneOf) &&
    Array.isArray(result.enum) &&
    result.enum.length > 0
  ) {
    const types = result.enum.map(inferTypeFromValue);
    if (types.every((type) => typeof type === 'string') && new Set(types).size === 1) result.type = types[0];
  }
  if (result.type === 'null') {
    delete result.type;
    result.nullable = true;
  }
  if (result.type === 'object' && !Object.hasOwn(result, 'propertyOrdering') && isJsonObject(result.properties)) {
    const keys = Object.keys(result.properties);
    if (keys.length > 1) result.propertyOrdering = keys;
  }
  if (result.type === 'object' && !Object.hasOwn(result, 'properties')) result.properties = {};
  spillToDescription(result, spill);
  return finishNode(result, ctx);
}

/** `schema` projected onto the JSON Schema subset Gemini backends accept. */
export function devinGoogleToolSchema(schema) {
  return googleNode(dereferenceSchema(upgradeTo202012(schema)), { insideMap: false, subschema: true }, new Set());
}
