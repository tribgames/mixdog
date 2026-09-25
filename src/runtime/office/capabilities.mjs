import { officeDesignCatalog } from './design/design-system.mjs';
import { plainObject } from './shared/values.mjs';
import { FIELD_ALIASES, OPERATION_ALIASES, PROPERTY_ALIASES } from './capabilities-aliases.mjs';
import { BACKENDS, CATALOG, COMMON, VIRTUAL_OPERATIONS } from './capabilities-catalog.mjs';
import { COMMON_SIGNATURES, FORMAT_SIGNATURES, signature } from './capabilities-signatures.mjs';

export { OFFICE_ACTIONS } from './capabilities-catalog.mjs';

function rawCatalogOperations(catalog) {
  return [...new Set([...catalog.operations.common, ...catalog.operations.office, ...catalog.operations.portable])];
}

function operationBackends(format, catalog, operation) {
  if (format === 'pdf') return ['mixdog-pdf'];
  if (format === 'csv' || format === 'tsv') return ['mixdog-tabular'];
  const backends = [];
  if (catalog.operations.common.includes(operation) || catalog.operations.office.includes(operation)) {
    backends.push('microsoft-office-com');
  }
  if (catalog.operations.common.includes(operation) || catalog.operations.portable.includes(operation)) {
    backends.push('mixdog-ooxml');
  }
  return backends;
}

function explicitOperationSignature(format, operation) {
  const formatSignatures = format === 'csv' || format === 'tsv' ? FORMAT_SIGNATURES.xlsx : FORMAT_SIGNATURES[format];
  if (Object.hasOwn(formatSignatures || {}, operation)) return formatSignatures[operation];
  if (Object.hasOwn(COMMON_SIGNATURES, operation)) return COMMON_SIGNATURES[operation];
  return null;
}

const OFFICE_OPERATION_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(CATALOG).map(([format, catalog]) => [
      format,
      Object.freeze(
        Object.fromEntries(
          rawCatalogOperations(catalog).map((operation) => {
            const input = explicitOperationSignature(format, operation);
            if (!input) throw new Error(`Office operation registry is missing a signature for ${format}.${operation}`);
            return [
              operation,
              Object.freeze({
                input,
                supportedBackends: Object.freeze(operationBackends(format, catalog, operation)),
              }),
            ];
          })
        )
      ),
    ])
  )
);

function catalogOperations(format) {
  return Object.keys(OFFICE_OPERATION_REGISTRY[format] || {});
}

function operationsForBackend(format, backend) {
  const entries = Object.entries(OFFICE_OPERATION_REGISTRY[format] || {});
  if (!backend) return entries.map(([operation]) => operation);
  return entries
    .filter(([, definition]) => definition.supportedBackends.includes(backend))
    .map(([operation]) => operation);
}

function supportedBackends(format, operation) {
  return [...(OFFICE_OPERATION_REGISTRY[format]?.[operation]?.supportedBackends || [])];
}

function operationSignature(format, operation) {
  return OFFICE_OPERATION_REGISTRY[format]?.[operation]?.input || signature();
}

function editDistance(left, right) {
  const a = String(left);
  const b = String(right);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

// What a name is about, ignoring the verb it starts with: add_toc and
// insert_toc are the same subject under two verbs, which is how a caller
// usually misses a name.
function subjectTokens(name) {
  return new Set(
    String(name)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .slice(1)
  );
}

// A suggestion is worth a retry only when it reads as a typo of what was
// written or names the same subject. Nearest-neighbour alone hands back
// unrelated names (source→op), and a wrong hint costs a whole round trip, so
// unrelated candidates are dropped and the caller is given the real list.
function operationSuggestions(operation, operations) {
  const token = String(operation);
  const budget = Math.max(1, Math.floor(token.length / 3));
  const subject = subjectTokens(token);
  return [...operations]
    .map((candidate) => ({
      candidate,
      distance: editDistance(token, candidate),
      sameSubject: [...subjectTokens(candidate)].some((part) => subject.has(part)),
    }))
    .filter(
      ({ candidate, distance, sameSubject }) =>
        distance <= budget ||
        sameSubject ||
        (token.length >= 3 && candidate.toLowerCase().includes(token.toLowerCase())) ||
        (token.length >= 4 && (candidate.startsWith(token) || token.startsWith(candidate)))
    )
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

function didYouMean(candidates) {
  return candidates.length ? ` Did you mean: ${candidates.join(', ')}?` : '';
}

function describeHint(format, backend, operation) {
  return `Call office with ${JSON.stringify({
    action: 'describe',
    format,
    ...(backend ? { backend } : {}),
    operation,
  })}.`;
}

function operationDescription(format, backend, catalog, requested) {
  const knownOperations = catalogOperations(format);
  const operation = resolveOperationAlias(format, requested);
  if (!knownOperations.includes(operation)) {
    const suggestions = operationSuggestions(operation, knownOperations);
    throw new Error(
      `Unknown ${format.toUpperCase()} operation "${operation}".${didYouMean(suggestions)} Call describe with format:"${format}" to list operations.`
    );
  }
  const available = operationsForBackend(format, backend);
  const signatureValue = operationSignature(format, operation);
  const properties = Object.fromEntries(
    signatureValue.propertySets
      .filter((name) => catalog.properties[name])
      .map((name) => [name, catalog.properties[name]])
  );
  return {
    name: operation,
    ...(VIRTUAL_OPERATIONS.has(operation) ? { virtual: true } : {}),
    supported: !backend || available.includes(operation),
    supportedBackends: supportedBackends(format, operation),
    input: {
      required: ['op', ...signatureValue.required],
      ...(signatureValue.oneOf.length ? { oneOf: signatureValue.oneOf } : {}),
      optional: [...new Set([...signatureValue.optional, 'allowNoChange'])].filter(
        (field) => !signatureValue.required.includes(field)
      ),
    },
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(signatureValue.notes ? { notes: signatureValue.notes } : {}),
  };
}

function resolveOperationAlias(format, name) {
  const known = catalogOperations(format);
  if (known.includes(name)) return name;
  const alias = OPERATION_ALIASES[format]?.[name];
  return alias && known.includes(alias) ? alias : name;
}

// One cell, optionally sheet-qualified and absolute: Sheet1!$B$4, '운영 자료'!C12, D5.
const SINGLE_CELL_REFERENCE = /^(?:(?:'[^']+'|[^'!]+)!)?\$?[A-Za-z]{1,3}\$?\d{1,7}$/;

// The operation name the batch will run under, or the fault that stops it:
// an alias is rewritten onto the operation, an unknown or unsupported name
// is answered with the list that does hold it.
function resolveContractOperation(batch, operation, index) {
  const { format, backend, known, available } = batch;
  const written = String(operation.op || '').trim();
  if (!written) return { fault: `Office operation ${index + 1} requires op` };
  const name = resolveOperationAlias(format, written);
  if (name !== written) operation.op = name;
  if (!known.includes(name)) {
    const suggestions = operationSuggestions(name, known);
    // Describing a name the catalog does not hold only repeats this error:
    // the caller is sent to the list that does answer the question.
    return {
      fault: `Unknown ${format.toUpperCase()} operation "${name}" at operation ${index + 1}.${didYouMean(suggestions)} Call office with ${JSON.stringify({ action: 'describe', format, ...(backend ? { backend } : {}) })} to list operations.`,
    };
  }
  if (!available.includes(name)) {
    const alternatives = supportedBackends(format, name);
    return {
      fault: `${format.toUpperCase()} operation "${name}" is unsupported by ${backend || 'this backend'}.${alternatives.length ? ` Supported backend(s): ${alternatives.join(', ')}.` : ''} ${describeHint(format, backend, name)}`,
    };
  }
  return { name };
}

function applyFieldAliases(format, name, operation) {
  for (const [alias, field] of Object.entries(FIELD_ALIASES[format]?.[name] || {})) {
    if (operation[alias] !== undefined && operation[field] === undefined) {
      operation[field] = operation[alias];
      delete operation[alias];
    }
  }
}

// Every other worksheet operation takes `range`, so a caller naming one cell
// that way is not making a mistake worth a round trip — while a real range
// handed to a single-cell operation is one, and says which operation writes it.
function singleCellRangeFault(batch, name, operation, index, allowed) {
  const { format, backend } = batch;
  if (format !== 'xlsx' || !allowed.has('cell') || allowed.has('range')) return null;
  if (operation.range === undefined || operation.cell !== undefined) return null;
  if (SINGLE_CELL_REFERENCE.test(String(operation.range).trim())) {
    operation.cell = operation.range;
    delete operation.range;
    return null;
  }
  return (
    `XLSX operation "${name}" at operation ${index + 1} writes one cell: pass cell instead of range.` +
    ` For ${operation.range} use set_range (values) or set_style (formatting). ${describeHint(format, backend, name)}`
  );
}

function allowedOperationFields(signatureValue, stableTargets) {
  const allowed = new Set([
    'op',
    'allowNoChange',
    ...signatureValue.required,
    ...signatureValue.optional,
    ...signatureValue.oneOf.flat(),
  ]);
  if (stableTargets && allowed.has('slide')) allowed.add('slideId');
  if (stableTargets && allowed.has('shape')) allowed.add('shapeId');
  return allowed;
}

// A table is a table: compose_document takes one as { headers, rows } and
// compose_sheet takes those two at the top level. The caller who writes the
// document's shape here is writing a sheet with a table in it, not a
// mistake, and "table→tableName" was the only thing the contract had to say.
function hoistComposeSheetTable(format, name, operation) {
  if (format !== 'xlsx' || name !== 'compose_sheet' || !plainObject(operation.table)) return;
  if (operation.headers !== undefined || operation.rows !== undefined) return;
  if (!Array.isArray(operation.table.rows) && !Array.isArray(operation.table.headers)) return;
  if (Array.isArray(operation.table.headers)) operation.headers = operation.table.headers;
  if (Array.isArray(operation.table.rows)) operation.rows = operation.table.rows;
  delete operation.table;
}

// Geometry sits in properties for add_shape and at the top level for
// add_image in the same format: our own inconsistency, so a caller who
// wrote the fields in the neighbouring operation's place is taken at their
// word instead of paying a round trip to move them.
function hoistGeometryProperties(signatureValue, operation, allowed) {
  if (signatureValue.propertySets.length || !plainObject(operation.properties)) return;
  if (!Object.keys(operation.properties).every((field) => allowed.has(field) && operation[field] === undefined)) return;
  Object.assign(operation, operation.properties);
  delete operation.properties;
}

function propertyKeySet(catalog, signatureValue) {
  return new Set(
    signatureValue.propertySets
      .flatMap((set) => catalog.properties?.[set] || [])
      .map((entry) => String(entry).split('.')[0])
  );
}

function fieldCorrections(fields, allowed) {
  return fields
    .map((field) => {
      const [candidate] = operationSuggestions(field, allowed);
      return candidate && candidate !== field ? `${field}→${candidate}` : '';
    })
    .filter(Boolean);
}

// Fields the operation does not take. A style key passed as a field is not a
// typo: it belongs in properties, and a declared style key written one level
// up is unambiguous, so it is applied where it belongs. Only a key the
// operation contradicts — the same name present in properties with another
// value — or a field nothing declares is worth an answer.
function unknownFieldsFault(batch, name, operation, index, { allowed, propertyKeys }) {
  const { format, backend } = batch;
  const unknown = Object.keys(operation).filter((field) => !allowed.has(field));
  if (!unknown.length) return null;
  const hoisted = unknown.filter(
    (field) =>
      propertyKeys.has(field) &&
      (operation.properties === undefined ||
        (plainObject(operation.properties) && operation.properties[field] === undefined))
  );
  if (hoisted.length) {
    const properties = plainObject(operation.properties) ? operation.properties : {};
    for (const field of hoisted) {
      properties[field] = operation[field];
      delete operation[field];
    }
    operation.properties = properties;
  }
  const remaining = unknown.filter((field) => !hoisted.includes(field));
  if (!remaining.length) return null;
  const misplaced = remaining.filter((field) => propertyKeys.has(field));
  const corrections = fieldCorrections(
    remaining.filter((field) => !misplaced.includes(field)),
    allowed
  );
  const accepted = [...allowed].filter((field) => field !== 'allowNoChange').join(', ');
  const keyWord = misplaced.length === 1 ? 'is a properties key' : 'are properties keys';
  const misplacedNote = misplaced.length
    ? ` ${misplaced.join(', ')} ${keyWord}: pass properties:{ ${misplaced.map((field) => `${field}: …`).join(', ')} }.`
    : '';
  let suggestion = ` ${name} takes: ${accepted}.`;
  if (corrections.length) suggestion = didYouMean(corrections);
  else if (misplaced.length) suggestion = '';
  return `${format.toUpperCase()} operation "${name}" at operation ${index + 1} has unknown field(s): ${remaining.join(', ')}.${misplacedNote}${suggestion} ${describeHint(format, backend, name)}`;
}

// Properties are where an unnoticed miss hurts most: an unknown key is
// dropped silently, so the caller believes the table was styled and only
// the rendered page says otherwise.
function unknownPropertiesFault(batch, name, operation, index, allowedProperties) {
  const { format, backend } = batch;
  const properties = operation.properties;
  if (!allowedProperties.size || !plainObject(properties)) return null;
  // The same font key is spelled two ways inside one format — a run takes
  // name/size, a table cell fontName/fontSize — because each set grew on
  // its own. Either spelling reaches the key the operation declares.
  for (const [written, canonical] of Object.entries(PROPERTY_ALIASES)) {
    if (properties[written] === undefined || allowedProperties.has(written)) continue;
    if (!allowedProperties.has(canonical) || properties[canonical] !== undefined) continue;
    properties[canonical] = properties[written];
    delete properties[written];
  }
  const unknownProperties = Object.keys(properties).filter((field) => !allowedProperties.has(field));
  if (!unknownProperties.length) return null;
  const corrections = fieldCorrections(unknownProperties, allowedProperties);
  return `${format.toUpperCase()} operation "${name}" at operation ${index + 1} has unknown properties: ${unknownProperties.join(', ')}.${didYouMean(corrections)} ${name} properties: ${[...allowedProperties].join(', ')}. ${describeHint(format, backend, name)}`;
}

// A Word table has two alignments that read alike: `alignment` places the
// table on the page and `columnAlignments` sets the text of each column.
// A list written into the first used to be serialized verbatim into the
// table's justification and refused by Word's schema at finalize.
function docxTableAlignmentFaults(format, name, operation, index) {
  const properties = operation.properties;
  if (format !== 'docx' || !['add_table', 'set_table_style'].includes(name) || !plainObject(properties)) return [];
  const faults = [];
  const placements = ['left', 'center', 'right'];
  const textAlignments = [...placements, 'justify'];
  if (properties.alignment !== undefined) {
    const placement = String(properties.alignment).trim().toLowerCase();
    if (Array.isArray(properties.alignment)) {
      faults.push(
        `DOCX operation "${name}" at operation ${index + 1}: properties.alignment places the whole table (${placements.join(', ')}); the text alignment of each column is properties.columnAlignments: ${JSON.stringify(properties.alignment)}.`
      );
    } else if (!placements.includes(placement)) {
      faults.push(
        `DOCX operation "${name}" at operation ${index + 1}: properties.alignment places the whole table and must be ${placements.join(', ')}, not ${JSON.stringify(properties.alignment)}; per-column text alignment is properties.columnAlignments.`
      );
    } else {
      properties.alignment = placement;
    }
  }
  if (properties.columnAlignments !== undefined) {
    const columns = Array.isArray(properties.columnAlignments) ? properties.columnAlignments : null;
    const invalid = columns
      ? columns.filter((entry) => !textAlignments.includes(String(entry).trim().toLowerCase()))
      : [];
    if (!columns || invalid.length) {
      faults.push(
        `DOCX operation "${name}" at operation ${index + 1}: properties.columnAlignments is one of ${textAlignments.join(', ')} per column${columns ? `, not ${invalid.map((entry) => JSON.stringify(entry)).join(', ')}` : ` (an array), not ${JSON.stringify(properties.columnAlignments)}`}.`
      );
    } else {
      properties.columnAlignments = columns.map((entry) => String(entry).trim().toLowerCase());
    }
  }
  return faults;
}

function requiredInputFault(batch, name, operation, index, signatureValue, stableTargets) {
  const { format, backend } = batch;
  const supplied = (field) =>
    operation[field] !== undefined ||
    (stableTargets && ['slide', 'shape'].includes(field) && operation[`${field}Id`] !== undefined);
  const missing = signatureValue.required.filter((field) => !supplied(field));
  const matchesAlternative =
    !signatureValue.oneOf.length || signatureValue.oneOf.some((alternative) => alternative.every(supplied));
  if (!missing.length && matchesAlternative) return null;
  const requirements = [
    ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
    ...(!matchesAlternative
      ? [`requires one of: ${signatureValue.oneOf.map((entry) => entry.join('+')).join(' or ')}`]
      : []),
  ].join('; ');
  return `${format.toUpperCase()} operation "${name}" at operation ${index + 1} has invalid input (${requirements}). ${describeHint(format, backend, name)}`;
}

// The contract faults one operation carries, after the rewrites the contract
// performs on the caller's behalf (aliases, hoisted fields, single-cell
// ranges). A name the batch cannot run stops the checks for that operation.
function operationContractFaults(batch, operation, index) {
  if (!plainObject(operation)) return [`Office operation ${index + 1} must be an object`];
  const resolved = resolveContractOperation(batch, operation, index);
  if (resolved.fault) return [resolved.fault];
  const { name } = resolved;
  const { format, backend, catalog } = batch;
  applyFieldAliases(format, name, operation);
  const signatureValue = operationSignature(format, name);
  const stableTargets = format === 'pptx' && backend === 'mixdog-ooxml';
  const allowed = allowedOperationFields(signatureValue, stableTargets);
  const cellFault = singleCellRangeFault(batch, name, operation, index, allowed);
  if (cellFault) return [cellFault];
  hoistComposeSheetTable(format, name, operation);
  hoistGeometryProperties(signatureValue, operation, allowed);
  const propertyKeys = propertyKeySet(catalog, signatureValue);
  return [
    unknownFieldsFault(batch, name, operation, index, { allowed, propertyKeys }),
    unknownPropertiesFault(batch, name, operation, index, propertyKeys),
    ...docxTableAlignmentFaults(format, name, operation, index),
    requiredInputFault(batch, name, operation, index, signatureValue, stableTargets),
  ].filter(Boolean);
}

export function assertOfficeOperationContracts({ format = '', backend = '', operations = [] } = {}) {
  const catalog = CATALOG[format];
  if (!catalog) throw new Error(`Unsupported Office Use format: ${format}`);
  const batch = {
    format,
    backend,
    catalog,
    available: operationsForBackend(format, backend),
    known: catalogOperations(format),
  };
  // Every contract violation in the batch is reported together. The batch is
  // refused as a whole either way, and a caller who learns one wrong field per
  // answer pays a round trip for each of them.
  const faults = operations.flatMap((operation, index) => operationContractFaults(batch, operation, index));
  if (faults.length === 1) throw new Error(faults[0]);
  if (faults.length) {
    throw new Error(`This batch breaks ${faults.length} input contracts; fix them together. ${faults.join(' ')}`);
  }
  return operations;
}

export function describeOfficeCapabilities({ format = '', backend = '', target = '', operation = '' } = {}) {
  if (backend && !BACKENDS.has(backend)) throw new Error(`Unsupported Office backend: ${backend}`);
  if (!format) {
    if (operation) throw new Error('describe with operation requires format, path, or session');
    return {
      ...COMMON,
      designs: officeDesignCatalog(),
      formats: Object.fromEntries(
        Object.entries(CATALOG).map(([name, value]) => [
          name,
          {
            paths: value.paths,
            operationCount: catalogOperations(name).length,
          },
        ])
      ),
      nextAction:
        'When discovery is needed, add format for its operation list or add operation for one compact input contract; otherwise call create/open/batch directly.',
    };
  }
  const catalog = CATALOG[format];
  if (!catalog) throw new Error(`Unsupported Office Use format: ${format}`);
  const normalizedOperation = String(operation || '').trim();
  if (normalizedOperation) {
    return {
      ...COMMON,
      format,
      backend,
      target: target || '/',
      paths: catalog.paths,
      operation: operationDescription(format, backend, catalog, normalizedOperation),
      designs: officeDesignCatalog(format),
    };
  }
  const operations = operationsForBackend(format, backend);
  const unsupported = backend ? catalogOperations(format).filter((name) => !operations.includes(name)) : [];
  return {
    ...COMMON,
    format,
    backend,
    target: target || '/',
    paths: catalog.paths,
    operations,
    unsupportedInBackend: unsupported,
    properties: catalog.properties,
    designs: officeDesignCatalog(format),
    nextAction:
      'If exact fields are unknown, add operation for its compact contract; otherwise call create/open/batch directly.',
  };
}
