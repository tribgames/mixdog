// Grok's gRPC tool registry requires flattened anyOf/oneOf schemas. Tool
// definitions are never mutated.
import { actionInputContract } from './action-input-contract.mjs';

function schemasDeepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => schemasDeepEqual(value, right[index]))
    );
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && schemasDeepEqual(left[key], right[key]))
  );
}

function pureAnyOfAlternatives(schema) {
  return schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    Object.keys(schema).length === 1 &&
    Array.isArray(schema.anyOf)
    ? schema.anyOf
    : [schema];
}

function mergeObjectBranchProperties(objectBranches) {
  const properties = {};
  for (const branch of objectBranches) {
    for (const [name, schema] of Object.entries(branch.properties || {})) {
      if (!Object.hasOwn(properties, name)) {
        properties[name] = schema;
        continue;
      }
      if (schemasDeepEqual(properties[name], schema)) continue;
      const alternatives = [...pureAnyOfAlternatives(properties[name]), ...pureAnyOfAlternatives(schema)];
      const deduped = alternatives.reduce(
        (unique, alternative) =>
          unique.some((item) => schemasDeepEqual(item, alternative)) ? unique : [...unique, alternative],
        []
      );
      if (deduped.every((value) => value.type === 'object' || value.properties)) {
        const { required: _required, properties: _properties, ...base } = deduped[0];
        const required = requiredKeys(deduped[0]).filter((key) =>
          deduped.every((value) => requiredKeys(value).includes(key))
        );
        properties[name] = {
          ...base,
          type: 'object',
          properties: mergeObjectBranchProperties(deduped),
          ...(required.length ? { required } : {}),
        };
      } else if (deduped.every((value) => Array.isArray(value.enum) && value.type === deduped[0].type)) {
        properties[name] = { ...deduped[0], enum: [...new Set(deduped.flatMap((value) => value.enum))] };
      } else {
        properties[name] = deduped.length === 1 ? deduped[0] : { anyOf: deduped };
      }
    }
  }
  return properties;
}

function requiredKeys(schema) {
  return schema && typeof schema === 'object' && !Array.isArray(schema) && Array.isArray(schema.required)
    ? schema.required.filter((key) => typeof key === 'string' && key)
    : [];
}

// Grok cannot keep XOR anyOf. Promote the first alternative's required keys
// so a flatten never advertises an optional-only tool that the runtime rejects.
function firstExclusiveRequired(branches) {
  for (const branch of branches) {
    const keys = requiredKeys(branch);
    if (keys.length) return keys;
  }
  return [];
}

const ARRAY_DROP_NOTE = 'This provider accepts a single value here, not an array.';

function describesArray(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  return schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'));
}

// Flattening keeps one branch, so a description that still promises the dropped
// shape would advertise more than the wire schema accepts. Project the loss
// into the text the model actually reads.
function projectDroppedBranches(schema, dropped) {
  if (describesArray(schema) || !dropped.some(describesArray)) return schema;
  const description = String(schema.description || '').trim();
  if (description.includes(ARRAY_DROP_NOTE)) return schema;
  return {
    ...schema,
    description: description ? `${description} ${ARRAY_DROP_NOTE}` : ARRAY_DROP_NOTE,
  };
}

function normalizeGrokPropertySchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const branches = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
  ];
  if (branches.length) {
    const first = branches.find((branch) => branch && typeof branch === 'object' && !Array.isArray(branch));
    if (first) {
      const { anyOf: _anyOf, oneOf: _oneOf, ...siblings } = schema;
      const dropped = branches.filter((branch) => branch !== first);
      return normalizeGrokPropertySchema(projectDroppedBranches({ ...first, ...siblings }, dropped));
    }
  }
  let result = schema;
  const replace = (key, value) => {
    if (value !== schema[key]) result = { ...result, [key]: value };
  };
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    if (!schema[key] || typeof schema[key] !== 'object') continue;
    let changed = false;
    const children = Object.fromEntries(
      Object.entries(schema[key]).map(([name, child]) => {
        const normalized = normalizeGrokPropertySchema(child);
        if (normalized !== child) changed = true;
        return [name, normalized];
      })
    );
    if (changed) replace(key, children);
  }
  // Schema-valued keywords are not restricted to object properties. Do not
  // walk data-valued keywords such as enum/default/examples.
  for (const key of [
    'items',
    'prefixItems',
    'additionalProperties',
    'contains',
    'allOf',
    'not',
    'if',
    'then',
    'else',
    'propertyNames',
    'unevaluatedProperties',
    'unevaluatedItems',
  ]) {
    const child = schema[key];
    if (Array.isArray(child)) {
      const children = child.map(normalizeGrokPropertySchema);
      if (children.some((value, index) => value !== child[index])) replace(key, children);
    } else if (child && typeof child === 'object') {
      replace(key, normalizeGrokPropertySchema(child));
    }
  }
  return result;
}

function normalizeGrokToolSchema(schema) {
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    (!Array.isArray(schema.anyOf) && !Array.isArray(schema.oneOf))
  ) {
    return normalizeGrokPropertySchema(schema);
  }

  const { anyOf, oneOf, ...root } = schema;
  const branches = [...(Array.isArray(anyOf) ? anyOf : []), ...(Array.isArray(oneOf) ? oneOf : [])];
  const objectBranches = branches.filter(
    (branch) =>
      branch &&
      typeof branch === 'object' &&
      !Array.isArray(branch) &&
      (branch.type === 'object' ||
        (Array.isArray(branch.type) && branch.type.includes('object')) ||
        (branch.properties && typeof branch.properties === 'object'))
  );

  if (!objectBranches.length) {
    const required = [...new Set([...requiredKeys(root), ...firstExclusiveRequired(branches)])];
    return normalizeGrokPropertySchema({
      ...root,
      type: 'object',
      ...(required.length ? { required } : {}),
      ...(!Object.hasOwn(root, 'additionalProperties') ? { additionalProperties: true } : {}),
    });
  }

  const properties =
    objectBranches.some((branch) => branch.properties) || root.properties
      ? mergeObjectBranchProperties(objectBranches)
      : undefined;
  for (const [name, property] of Object.entries(root.properties || {})) {
    const combined = properties[name];
    // A root's generic input object constrains its type; it must not erase
    // the action branches' actual fields.
    properties[name] =
      property.type === 'object' && !property.properties && combined?.type === 'object'
        ? { ...combined, ...property, properties: combined.properties }
        : property;
  }
  const actionContract = actionInputContract(schema);
  if (actionContract && properties?.input) {
    properties.input = {
      ...properties.input,
      description: actionContract,
    };
  }
  const branchRequiredInEvery = (Array.isArray(objectBranches[0].required) ? objectBranches[0].required : []).filter(
    (key) => objectBranches.every((branch) => Array.isArray(branch.required) && branch.required.includes(key))
  );
  const required = [
    ...new Set([
      ...requiredKeys(root),
      ...branchRequiredInEvery,
      ...(branchRequiredInEvery.length ? [] : firstExclusiveRequired(objectBranches)),
    ]),
  ];
  const { properties: _rootProperties, required: _rootRequired, ...rootWithoutPropertiesOrRequired } = root;
  const mergedObjectBranches = Object.assign({}, ...objectBranches);
  const {
    properties: _branchProperties,
    required: _branchRequired,
    ...mergedObjectBranchesWithoutPropertiesOrRequired
  } = mergedObjectBranches;
  return normalizeGrokPropertySchema({
    ...mergedObjectBranchesWithoutPropertiesOrRequired,
    ...rootWithoutPropertiesOrRequired,
    type: 'object',
    ...(properties ? { properties } : {}),
    ...(required.length ? { required } : {}),
  });
}

export function normalizeGrokToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    const inputSchema = normalizeGrokToolSchema(tool?.inputSchema);
    return inputSchema === tool?.inputSchema ? tool : { ...tool, inputSchema };
  });
}
