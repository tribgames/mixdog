import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertOfficeOperationContracts, describeOfficeCapabilities } from './capabilities.mjs';
import { physicalAsarPath } from './shared/asar-path.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

test('persistent Office validation inspects the open document with bounded Excel busy retries', async () => {
  const source = await readFile(new URL('./com/office-com-session-host.ps1', import.meta.url), 'utf8');
  const start = source.indexOf("'validate' {");
  const end = source.indexOf("'checkpoint' {", start);
  const validation = source.slice(start, end);
  assert.match(validation, /Snapshot-SessionDocument \$document/);
  assert.match(validation, /Issues-SessionDocument \$document/);
  assert.match(source, /Invoke-ExcelComRetry[\s\S]+Excel session snapshot/);
  assert.match(source, /Invoke-ExcelComRetry[\s\S]+Excel session issue inspection/);
  assert.match(source, /\$app\.Presentations\.Add\(\$visible\)/);
  assert.doesNotMatch(validation, /Validate-NativeDocument/);
});

test('Office COM host resolves to the physical ASAR sidecar for external PowerShell', () => {
  const packaged = 'C:\\Program Files\\Mixdog\\resources\\runtime.asar\\node_modules\\mixdog\\src\\runtime\\office\\com\\office-com-host.ps1';
  assert.equal(
    physicalAsarPath(packaged),
    'C:\\Program Files\\Mixdog\\resources\\runtime.asar.unpacked\\node_modules\\mixdog\\src\\runtime\\office\\com\\office-com-host.ps1',
  );
  const development = 'C:\\Project\\mixdog\\src\\runtime\\office\\com\\office-com-host.ps1';
  assert.equal(physicalAsarPath(development), development);
});

test('operation registry matches every COM implementation and rejects unknown fields before dispatch', async () => {
  const source = await readFile(new URL('./com/office-com-host.ps1', import.meta.url), 'utf8');
  const sections = [
    ['docx', 'function Apply-WordOperation', 'function Excel-Sheet'],
    ['xlsx', 'function Apply-ExcelOperation', 'function Ppt-Slide'],
    ['pptx', 'function Apply-PowerPointOperation', 'function Apply-Operations'],
  ];
  for (const [format, startMarker, endMarker] of sections) {
    const start = source.indexOf(startMarker);
    const block = source.slice(start, source.indexOf(endMarker, start + startMarker.length));
    const implemented = [...block.matchAll(/^\s{4}'([a-z][a-z0-9_]*)'\s*\{/gm)]
      .map((match) => match[1])
      .sort();
    const described = describeOfficeCapabilities({
      format,
      backend: 'microsoft-office-com',
    }).operations.sort();
    const native = described.filter((operation) => !describeOfficeCapabilities({
      format,
      backend: 'microsoft-office-com',
      operation,
    }).operation.virtual);
    assert.deepEqual(native, implemented, `${format} registry drifted from the COM backend`);
    for (const operation of described) {
      const targeted = describeOfficeCapabilities({
        format,
        backend: 'microsoft-office-com',
        operation,
      }).operation;
      assert.equal(targeted.input.required[0], 'op');
      assert.ok(targeted.supportedBackends.includes('microsoft-office-com'));
    }
  }
  assert.throws(
    () => assertOfficeOperationContracts({
      format: 'pdf',
      backend: 'mixdog-pdf',
      operations: [{ op: 'compress', alowNoChange: true }],
    }),
    /unknown field\(s\): alowNoChange.*alowNoChange→allowNoChange/,
  );
});
