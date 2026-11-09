// Appends the synthetic shapes below to `node_recorded.json` as Node's own `normalizeGrokToolSchemas` (b6f10295a) answers
// them, and writes the manifest the Rust test compares exactly. The earlier cases are kept verbatim.
// Usage: node record.mjs <Node b6f10295a export root>   (a `git archive` export of that commit, never a working copy)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const here = dirname(fileURLToPath(import.meta.url));
const { normalizeGrokToolSchemas } = await import(pathToFileURL(join(root, 'src/runtime/agent/orchestrator/providers/lib/grok-tool-schema.mjs')).href);
const file = join(here, 'node_recorded.json');
const parsed = JSON.parse(readFileSync(file, 'utf8'));
const kept = (Array.isArray(parsed) ? parsed : parsed.cases).filter((c) => c.source !== 'synthetic-set');

const obj = (properties, extra = {}) => ({ type: 'object', properties, ...extra });
const branches = (...list) => ({ anyOf: list });
const synthetic = {
  // Two object branches whose property enums hold objects: a JS Set keeps every object entry.
  enum_object_entries: branches(obj({ p: { type: 'object', enum: [{ a: 1 }, { b: 2 }] } }), obj({ p: { type: 'object', enum: [{ a: 1 }, { c: 3 }] } })),
  enum_array_entries: branches(obj({ p: { type: 'array', enum: [[1], [2]] } }), obj({ p: { type: 'array', enum: [[1], [3]] } })),
  enum_primitives_by_value: branches(obj({ p: { type: 'string', enum: ['a', 'b', 'a'] } }), obj({ p: { type: 'string', enum: ['b', 'c'] } })),
  enum_mixed_primitives: branches(obj({ p: { enum: [1, '1', null, true, 1, null] } }), obj({ p: { enum: [true, 2, '1', false] } })),
  enum_type_differs: branches(obj({ p: { type: 'string', enum: ['a'] } }), obj({ p: { type: 'number', enum: [1] } })),
  enum_without_type: branches(obj({ p: { enum: ['x'] } }), obj({ p: { enum: ['x', 'y'] } })),
  enum_same_property_equal: branches(obj({ p: { type: 'string', enum: ['a'] } }), obj({ p: { type: 'string', enum: ['a'] } })),
  enum_three_branches: branches(obj({ p: { type: 'string', enum: ['a'] } }), obj({ p: { type: 'string', enum: ['b'] } }), obj({ p: { type: 'string', enum: ['a', 'c'] } })),
  property_pure_any_of_flattened: branches(obj({ p: { anyOf: [{ type: 'string', enum: ['a'] }, { type: 'string', enum: ['b'] }] } }), obj({ p: { type: 'string', enum: ['c'] } })),
  nested_object_merge: branches(obj({ p: obj({ a: { type: 'string' } }, { required: ['a'] }) }), obj({ p: obj({ b: { type: 'number' } }, { required: ['a', 'b'] }) })),
  nested_enum_inside_merge: branches(obj({ p: obj({ q: { type: 'string', enum: ['a'] } }) }), obj({ p: obj({ q: { type: 'string', enum: ['b'] } }) })),
  incompatible_property_any_of: branches(obj({ p: { type: 'string' } }), obj({ p: { type: 'number' } })),
  required_shared_and_exclusive: branches(obj({ a: { type: 'string' }, b: { type: 'string' } }, { required: ['a', 'b'] }), obj({ a: { type: 'string' }, c: { type: 'string' } }, { required: ['a', 'c', ''] })),
  required_none_shared: branches(obj({ a: { type: 'string' } }, { required: ['a'] }), obj({ b: { type: 'string' } }, { required: ['b'] })),
  required_object_entries_two_branches: branches(obj({ a: { type: 'string' } }, { required: [{ x: 1 }, 'a'] }), obj({ a: { type: 'string' } }, { required: [{ x: 1 }, 'a'] })),
  required_object_entry_one_branch: branches(obj({ a: { type: 'string' } }, { required: [{ x: 1 }, 'a'] })),
  root_properties_over_branches: { type: 'object', properties: { p: { type: 'object' }, k: { type: 'string' } }, required: ['k'], anyOf: [obj({ p: obj({ a: { type: 'string' } }) }), obj({ q: { type: 'string' } })] },
  one_of_and_any_of_together: { oneOf: [obj({ a: { type: 'string' } })], anyOf: [obj({ b: { type: 'string' } })] },
  type_array_object_branch: branches({ type: ['object', 'null'], properties: { a: { type: 'string' } } }, { type: 'string' }),
  union_without_object_branch: { description: 'd', anyOf: [{ type: 'string', required: ['x'] }, { type: 'number' }], additionalProperties: false },
  keyword_walk: { type: 'object', properties: { m: { type: 'object', patternProperties: { '^a': { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, $defs: { d: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, dependentSchemas: { k: { anyOf: [{ type: 'number' }] } } } } },
  schema_valued_keywords: { type: 'object', properties: { t: { type: 'array', prefixItems: [{ anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }], items: { oneOf: [{ type: 'number' }] }, contains: { anyOf: [{ type: 'string' }] }, not: { anyOf: [{ type: 'number' }] }, if: { anyOf: [{ type: 'string' }] }, then: { anyOf: [{ type: 'string' }] }, else: { anyOf: [{ type: 'string' }] }, allOf: [{ anyOf: [{ type: 'string' }] }], additionalProperties: { anyOf: [{ type: 'string' }] }, propertyNames: { anyOf: [{ type: 'string' }] } } } },
  array_note_present: { type: 'object', properties: { v: { description: 'Pass one or more values as an array.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } } },
  scalar_note_dropped_array: { type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'number' }] } } },
  first_object_branch_kept: { type: 'object', properties: { v: { anyOf: [{ type: 'null' }, { type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'string' } } }] } } },
  root_string: { type: 'string' },
  root_null: null,
  empty_object: {},
};
const added = Object.entries(synthetic).map(([name, input]) => {
  const out = normalizeGrokToolSchemas([{ name, inputSchema: input }])[0].inputSchema;
  return { source: 'synthetic-set', name, input, expected: out === undefined ? null : out };
});
const cases = [...kept, ...added];
const changed = cases.filter((c) => JSON.stringify(c.input) !== JSON.stringify(c.expected)).length;
const sources = {};
for (const c of cases) sources[c.source] = (sources[c.source] || 0) + 1;
const manifest = { node: 'b6f10295a', exact: true, count: cases.length, changed, sources, names: cases.map((c) => `${c.source}:${c.name}`) };
writeFileSync(file, `${JSON.stringify({ manifest, cases }, null, 1)}\n`);
console.log(`${cases.length} cases, ${changed} changed`);
