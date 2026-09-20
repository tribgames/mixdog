// JSON Schema counts Unicode code points, not JavaScript's UTF-16 code units.
export function schemaStringLength(value) {
  let length = 0;
  for (const _ of value) length++;
  return length;
}

// Shared schema checks; tools retain their action-specific target relationships.
export function schemaValueError(value, schema, path) {
  if (schema.enum && !schema.enum.includes(value)) {
    return `${path} must be one of: ${schema.enum.join(', ')}`;
  }
  if (Array.isArray(schema.type)) {
    const errors = schema.type.map((type) => schemaValueError(value, { ...schema, type }, path));
    return errors.includes(null) ? null : errors.join(' or ');
  }
  if (schema.type === 'null' && value !== null) return `${path} must be null`;
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be a string`;
    const length = schemaStringLength(value);
    if (schema.minLength !== undefined && length < schema.minLength) {
      return `${path} requires at least ${schema.minLength} characters`;
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return `${path} accepts at most ${schema.maxLength} characters`;
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      return `${path} must match the required format`;
    }
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path} must be a boolean`;
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    return `${path} must be a finite number`;
  }
  if (schema.type === 'integer' && !Number.isInteger(value)) return `${path} must be an integer`;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${path} requires at least ${schema.minItems} items`;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `${path} accepts at most ${schema.maxItems} items`;
    }
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      return `${path} must contain unique items`;
    }
    for (let index = 0; index < value.length; index += 1) {
      const error = schemaValueError(value[index], schema.items || {}, `${path}[${index}]`);
      if (error) return error;
    }
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
    const properties = schema.properties || {};
    const missing = (schema.required || []).filter((name) => !Object.hasOwn(value, name));
    if (missing.length) return `${path} requires field(s): ${missing.join(', ')}`;
    if (schema.additionalProperties === false) {
      const extras = Object.keys(value).filter((name) => !Object.hasOwn(properties, name));
      if (extras.length) return `${path} does not accept field(s): ${extras.join(', ')}`;
    }
    for (const [name, item] of Object.entries(value)) {
      let field = {};
      if (Object.hasOwn(properties, name)) field = properties[name];
      else if (typeof schema.additionalProperties === 'object') field = schema.additionalProperties;
      const error = schemaValueError(item, field, `${path}.${name}`);
      if (error) return error;
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  return null;
}
