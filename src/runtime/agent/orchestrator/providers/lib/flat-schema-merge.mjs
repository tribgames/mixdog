/**
 * Merge two JSON-schema property definitions when a top-level compound
 * schema (oneOf/anyOf/allOf) is flattened into one object schema: enums
 * union, nested properties merge recursively, and only properties required
 * by both sides stay required. Inputs are never mutated.
 */
export function mergeFlatSchemaProperty(current, incoming) {
  if (!current || typeof current !== 'object') return structuredClone(incoming);
  if (!incoming || typeof incoming !== 'object') return structuredClone(current);
  const merged = { ...structuredClone(incoming), ...structuredClone(current) };
  if (Array.isArray(current.enum) || Array.isArray(incoming.enum)) {
    merged.enum = [
      ...new Set([
        ...(Array.isArray(current.enum) ? current.enum : []),
        ...(Array.isArray(incoming.enum) ? incoming.enum : []),
      ]),
    ];
  }
  if (current.properties || incoming.properties) {
    merged.properties = {};
    for (const [name, property] of Object.entries(current.properties || {})) {
      merged.properties[name] = structuredClone(property);
    }
    for (const [name, property] of Object.entries(incoming.properties || {})) {
      merged.properties[name] = mergeFlatSchemaProperty(merged.properties[name], property);
    }
  }
  if (Array.isArray(current.required) && Array.isArray(incoming.required)) {
    const incomingRequired = new Set(incoming.required);
    const sharedRequired = current.required.filter((name) => incomingRequired.has(name));
    if (sharedRequired.length) merged.required = sharedRequired;
    else delete merged.required;
  } else {
    delete merged.required;
  }
  return merged;
}
