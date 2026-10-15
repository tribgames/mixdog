import { mergeFlatSchemaProperty } from './flat-schema-merge.mjs';

// Preserve action-specific input rules when a provider needs a flat schema.
// Field definitions remain shared; only the per-action field names and differing
// enums/bounds are repeated, rather than copying every full schema branch.
export function actionInputContract(schema) {
  const branches = schema?.oneOf || schema?.anyOf;
  if (!Array.isArray(branches) || !branches.length) return '';
  if (
    !branches.every(
      (branch) => Array.isArray(branch?.properties?.action?.enum) && branch?.properties?.input?.properties
    )
  )
    return '';
  const variants = new Map();
  for (const branch of branches) {
    for (const [name, field] of Object.entries(branch.properties.input.properties)) {
      const values = variants.get(name) || new Set();
      values.add(JSON.stringify([field.enum, field.minimum, field.maximum]));
      variants.set(name, values);
    }
  }
  const rows = branches.map((branch) => {
    const input = branch.properties.input;
    const required = new Set(input.required || []);
    const fields = Object.entries(input.properties).map(([name, field]) => {
      let label = `${name}${required.has(name) ? '*' : ''}`;
      if (variants.get(name).size > 1) {
        if (field.enum) label += `=${field.enum.join('|')}`;
        if (field.minimum !== undefined) label += `>=${field.minimum}`;
        if (field.maximum !== undefined) label += `<=${field.maximum}`;
      }
      return label;
    });
    return `${branch.properties.action.enum.join('/')}(${fields.join(',')})`;
  });
  return `Allowed input by action (* required): ${rows.join('; ')}.`;
}

// A per-action input union: the root's `action` enum and an `input` whose
// anyOf alternatives are object schemas, each titled with the one action it
// belongs to. Returns those alternatives as action/input branches, or null.
function actionInputBranches(schema) {
  const actions = schema?.properties?.action?.enum;
  const alternatives = schema?.properties?.input?.anyOf;
  if (!Array.isArray(actions) || !Array.isArray(alternatives) || !alternatives.length) return null;
  const branches = alternatives.map((alternative) =>
    alternative?.properties && actions.includes(alternative.title)
      ? { properties: { action: { enum: [alternative.title] }, input: alternative } }
      : null
  );
  return branches.every(Boolean) ? branches : null;
}

/** The flat projection of a per-action input union: `input` becomes the
 *  merged field set of every alternative, its description listing the fields
 *  per action. Any other schema is returned as is; the input is never mutated. */
export function flattenActionInputUnion(schema) {
  const branches = actionInputBranches(schema);
  if (!branches) return schema;
  const { anyOf: _anyOf, description, ...base } = schema.properties.input;
  const merged = branches
    .map(({ properties }) => {
      const { title: _title, description: _description, ...shape } = properties.input;
      return shape;
    })
    .reduce((current, shape) => mergeFlatSchemaProperty(current, shape));
  const contract = actionInputContract({ oneOf: branches });
  return {
    ...schema,
    properties: {
      ...schema.properties,
      input: { ...base, ...merged, description: [description, contract].filter(Boolean).join(' ') },
    },
  };
}

// Nested per-action input unions keyed by their flat projection's JSON. A tool
// advertises the flat projection on every path; only provider paths verified
// to accept nested alternatives opt in through actionInputUnionFor. Keyed by
// content, so a request snapshot's clone still resolves.
const nestedByFlat = new Map();

/** Register `nested` (a per-action input union) and return the flat
 *  projection the tool advertises. */
export function advertiseActionInputUnion(nested) {
  const flat = flattenActionInputUnion(nested);
  nestedByFlat.set(JSON.stringify(flat), nested);
  return flat;
}

/** The registered nested union for an advertised flat schema, else `schema`. */
export function actionInputUnionFor(schema) {
  if (!schema?.properties?.action || !schema.properties.input) return schema;
  return nestedByFlat.get(JSON.stringify(schema)) ?? schema;
}
