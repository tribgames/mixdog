#!/usr/bin/env node
// One-off export of the office capability tables Node's runtime advertises, for the Rust crate mixdog-office.
//
//   node benchmarks/rust-core/recorders/record-office-capability-tables.mjs --tree <product tree>
//
// Writes, in the checkout this script lives in:
//   native/core/crates/mixdog-office/data/capabilities.json   every exported table, key order kept
//   native/core/crates/mixdog-office/data/tool-defs.json      TOOL_DEFS, key order kept
//   native/core/fixtures/office-capability-tables/golden.json the operation registry the contract engine builds from
//                                                             them (what the typed lookups must answer) and the digests
//   native/core/fixtures/office-capability-tables/MANIFEST.json
// The product tree is the one holding src/runtime/office/{capabilities-catalog,capabilities-signatures,
// capabilities-aliases,tool-defs}.mjs; it is only read.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const treeArg = process.argv.indexOf('--tree');
if (treeArg < 0 || !process.argv[treeArg + 1]) {
  console.error('usage: record-office-capability-tables.mjs --tree <product tree>');
  process.exit(2);
}
const tree = path.resolve(process.argv[treeArg + 1]);
const load = (name) => import(pathToFileURL(path.join(tree, 'src', 'runtime', 'office', name)).href);

const catalogModule = await load('capabilities-catalog.mjs');
const signatures = await load('capabilities-signatures.mjs');
const aliases = await load('capabilities-aliases.mjs');
const toolDefs = await load('tool-defs.mjs');
const contract = await import(pathToFileURL(path.join(tree, 'src', 'runtime', 'office', 'portable', 'xlsx-contract.mjs')).href);

const { OFFICE_ACTIONS, COMMON, CATALOG, BACKENDS, VIRTUAL_OPERATIONS } = catalogModule;
const { COMMON_SIGNATURES, FORMAT_SIGNATURES } = signatures;

const capabilities = {
  actions: [...OFFICE_ACTIONS],
  common: COMMON,
  catalog: CATALOG,
  backends: [...BACKENDS],
  virtualOperations: [...VIRTUAL_OPERATIONS],
  commonSignatures: COMMON_SIGNATURES,
  formatSignatures: FORMAT_SIGNATURES,
  fieldAliases: aliases.FIELD_ALIASES,
  propertyAliases: aliases.PROPERTY_ALIASES,
  operationAliases: aliases.OPERATION_ALIASES,
  xlsxValidation: {
    operators: [...contract.XLSX_VALIDATION_OPERATORS],
    types: [...contract.XLSX_VALIDATION_TYPES],
  },
};
const tools = { toolDefs: toolDefs.TOOL_DEFS, skillRouting: toolDefs.OFFICE_SKILL_ROUTING };

// The registry capabilities.mjs builds at load: per format and operation the input signature and the backends.
function backendsOf(format, catalog, operation) {
  if (format === 'pdf') return ['mixdog-pdf'];
  if (format === 'csv' || format === 'tsv') return ['mixdog-tabular'];
  const out = [];
  if (catalog.operations.common.includes(operation) || catalog.operations.office.includes(operation)) {
    out.push('microsoft-office-com');
  }
  if (catalog.operations.common.includes(operation) || catalog.operations.portable.includes(operation)) {
    out.push('mixdog-ooxml');
  }
  return out;
}
function signatureOf(format, operation) {
  const byFormat = format === 'csv' || format === 'tsv' ? FORMAT_SIGNATURES.xlsx : FORMAT_SIGNATURES[format];
  if (Object.hasOwn(byFormat || {}, operation)) return byFormat[operation];
  if (Object.hasOwn(COMMON_SIGNATURES, operation)) return COMMON_SIGNATURES[operation];
  return null;
}
const registry = {};
const byBackend = {};
const missing = [];
for (const [format, catalog] of Object.entries(CATALOG)) {
  registry[format] = {};
  const operations = [...new Set([...catalog.operations.common, ...catalog.operations.office, ...catalog.operations.portable])];
  for (const operation of operations) {
    const input = signatureOf(format, operation);
    if (!input) {
      missing.push(`${format}.${operation}`);
      continue;
    }
    registry[format][operation] = { input, supportedBackends: backendsOf(format, catalog, operation) };
  }
  byBackend[format] = {};
  for (const backend of BACKENDS) {
    byBackend[format][backend] = Object.entries(registry[format])
      .filter(([, definition]) => definition.supportedBackends.includes(backend))
      .map(([operation]) => operation);
  }
}
if (missing.length) throw new Error(`Office operation registry is missing a signature for ${missing.join(', ')}`);

const text = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const capabilitiesText = text(capabilities);
const toolsText = text(tools);
const golden = {
  note: 'Recorded from the Node office capability modules; tests/twin_capability_tables.rs replays it.',
  capabilitiesSha256: sha(capabilitiesText),
  toolDefsSha256: sha(toolsText),
  formats: Object.keys(CATALOG),
  registry,
  operationsByBackend: byBackend,
};
const goldenText = text(golden);

const crate = path.join(repo, 'native', 'core', 'crates', 'mixdog-office');
const fixtures = path.join(repo, 'native', 'core', 'fixtures', 'office-capability-tables');
mkdirSync(path.join(crate, 'data'), { recursive: true });
mkdirSync(fixtures, { recursive: true });
writeFileSync(path.join(crate, 'data', 'capabilities.json'), capabilitiesText);
writeFileSync(path.join(crate, 'data', 'tool-defs.json'), toolsText);
writeFileSync(path.join(fixtures, 'golden.json'), goldenText);
writeFileSync(
  path.join(fixtures, 'MANIFEST.json'),
  text({
    command: 'node benchmarks/rust-core/recorders/record-office-capability-tables.mjs --tree <tree>',
    fileCount: 1,
    files: [{ bytes: Buffer.byteLength(goldenText), path: 'golden.json', sha256: sha(goldenText) }],
    recorder: 'benchmarks/rust-core/recorders/record-office-capability-tables.mjs',
    set: 'office-capability-tables',
    totalBytes: Buffer.byteLength(goldenText),
  })
);
console.log(`capabilities.json ${capabilitiesText.length} bytes, tool-defs.json ${toolsText.length} bytes, golden.json ${goldenText.length} bytes`);
