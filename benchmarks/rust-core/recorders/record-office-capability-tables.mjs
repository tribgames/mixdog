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
// The product tree is an export of NODE_COMMIT (the last commit holding src/runtime/office/tool-defs.mjs, which the K1
// cut removed) with src, apps and package.json; it is only read, and the recorder refuses a tree that is not exactly
// that commit.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, exactProductIdentity, importFrom, parseArgs, resolveTree, sha256, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'f6ac6584899028446d6f7a1fb51ffb8384f0194a';
const RECORDER = 'benchmarks/rust-core/recorders/record-office-capability-tables.mjs';
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const load = (name) => importFrom(tree, `src/runtime/office/${name}`);

const catalogModule = await load('capabilities-catalog.mjs');
const signatures = await load('capabilities-signatures.mjs');
const aliases = await load('capabilities-aliases.mjs');
const toolDefs = await load('tool-defs.mjs');
const contract = await load('portable/xlsx-contract.mjs');

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
const capabilitiesText = text(capabilities);
const toolsText = text(tools);
const golden = {
  note: 'Recorded from the Node office capability modules; tests/twin_capability_tables.rs replays it.',
  capabilitiesSha256: sha256(capabilitiesText),
  toolDefsSha256: sha256(toolsText),
  formats: Object.keys(CATALOG),
  registry,
  operationsByBackend: byBackend,
};
const goldenText = text(golden);

const crate = path.join(REPO_ROOT, 'native', 'core', 'crates', 'mixdog-office');
const fixtures = path.join(FIXTURES_ROOT, 'office-capability-tables');
mkdirSync(path.join(crate, 'data'), { recursive: true });
mkdirSync(fixtures, { recursive: true });
writeFileSync(path.join(crate, 'data', 'capabilities.json'), capabilitiesText);
writeFileSync(path.join(crate, 'data', 'tool-defs.json'), toolsText);
writeFileSync(path.join(fixtures, 'golden.json'), goldenText);
writeSetManifest(fixtures, { set: 'office-capability-tables', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`capabilities.json ${capabilitiesText.length} bytes, tool-defs.json ${toolsText.length} bytes, golden.json ${goldenText.length} bytes`);
