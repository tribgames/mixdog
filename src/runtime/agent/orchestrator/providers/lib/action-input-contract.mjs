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
