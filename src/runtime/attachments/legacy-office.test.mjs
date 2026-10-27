import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
process.env.MIXDOG_DATA_DIR = makeTempDirSync('legacy-office');

const { materializePromptSubmission, preparePromptSubmissionForProvider, readAttachmentBuffer } = await import(
  './store.mjs'
);
const { convertLegacyOfficeBuffer } = await import('./legacy-office.mjs');
const { extractOoxmlTextFromBuffer } = await import('./office-extract.mjs');

const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('legacy body')]);
const XLS_MIME = 'application/vnd.ms-excel';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// A stored-method ZIP holding one workbook with a single inline-string cell.
function minimalXlsx(cellText) {
  const parts = {
    'xl/workbook.xml': '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${cellText}</t></is></c></row></sheetData></worksheet>`,
  };
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(parts).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function legacyPrompt(data = OLE, mimeType = XLS_MIME, filename = 'sales plan.xls') {
  return materializePromptSubmission([
    { type: 'text', text: 'read it' },
    { type: 'file', data: data.toString('base64'), mimeType, filename },
  ]);
}

test('a legacy attachment is converted to its OOXML package before extraction and the scratch folder is removed', async () => {
  const seen = {};
  const convert = async (source, output) => {
    seen.dir = dirname(source);
    seen.source = await readFile(source);
    assert.equal(dirname(output), seen.dir);
    assert.match(output, /\.xlsx$/);
    await writeFile(output, minimalXlsx('converted cell'));
  };
  const intake = await preparePromptSubmissionForProvider(legacyPrompt(), {}, { convertLegacy: convert });
  const part = intake.prompt[1];
  assert.equal(part.type, 'file');
  assert.equal(part.mimeType, XLSX_MIME);
  assert.equal(part.filename, 'sales plan.xlsx');
  assert.deepEqual(seen.source, OLE);
  assert.equal(existsSync(seen.dir), false);
  assert.match(extractOoxmlTextFromBuffer(readAttachmentBuffer(part), part.filename), /converted cell/);
});

test('an OLE file renamed to .xlsx is converted too', async () => {
  const convert = async (_source, output) => writeFile(output, minimalXlsx('renamed'));
  const prompt = legacyPrompt(OLE, XLSX_MIME, 'book.xlsx');
  const intake = await preparePromptSubmissionForProvider(prompt, {}, { convertLegacy: convert });
  assert.match(extractOoxmlTextFromBuffer(readAttachmentBuffer(intake.prompt[1]), 'book.xlsx'), /renamed/);
});

test('a failing or missing converter yields its message as the attachment text and cleans up', async () => {
  let dir = '';
  const convert = async (source, output) => {
    dir = dirname(source);
    throw new Error(
      `${source} is a legacy binary file, not an Office package, and converting it needs LibreOffice. Install the Office feature in Mixdog settings (it installs LibreOffice), or open it in Microsoft Office and save it as ${output}.`
    );
  };
  const intake = await preparePromptSubmissionForProvider(legacyPrompt(), {}, { convertLegacy: convert });
  const part = intake.prompt[1];
  assert.equal(part.type, 'text');
  assert.match(part.text, /^--- sales plan\.xls ---\n/);
  assert.match(part.text, /needs LibreOffice\. Install the Office feature in Mixdog settings/);
  assert.ok(!part.text.includes(dir));
  assert.equal(existsSync(dir), false);
});

test('OOXML and non-OLE attachments are left untouched', async () => {
  const convert = async () => assert.fail('converter must not run');
  const docx = legacyPrompt(minimalXlsx('x'), XLSX_MIME, 'ok.xlsx');
  const intake = await preparePromptSubmissionForProvider(docx, {}, { convertLegacy: convert });
  assert.equal(intake.prompt[1], docx.prompt[1]);
});

test('convertLegacyOfficeBuffer maps the label to the package extension', async () => {
  let output = '';
  const result = await convertLegacyOfficeBuffer(OLE, 'deck.ppt', 'pptx', {
    convert: async (_source, target) => {
      output = target;
      await writeFile(target, 'bytes');
    },
  });
  assert.equal(result.filename, 'deck.pptx');
  assert.equal(result.buffer.toString(), 'bytes');
  assert.equal(existsSync(dirname(output)), false);
});

test('an OLE attachment sent with an OOXML MIME type and no extension is converted', async () => {
  const convert = async (_source, output) => writeFile(output, minimalXlsx('by mime'));
  const intake = await preparePromptSubmissionForProvider(
    legacyPrompt(OLE, XLSX_MIME, 'upload'),
    {},
    { convertLegacy: convert }
  );
  const part = intake.prompt[1];
  assert.equal(part.type, 'file');
  assert.equal(part.filename, 'upload.xlsx');
  assert.match(extractOoxmlTextFromBuffer(readAttachmentBuffer(part), part.filename), /by mime/);
});

test('a legacy-labelled attachment whose bytes are not a legacy file is explained, not passed through', async () => {
  const convert = async () => assert.fail('converter must not run');
  const intake = await preparePromptSubmissionForProvider(
    legacyPrompt(Buffer.from('plain text, not OLE'), XLS_MIME, 'fake.xls'),
    {},
    { convertLegacy: convert }
  );
  const part = intake.prompt[1];
  assert.equal(part.type, 'text');
  assert.match(part.text, /^--- fake\.xls ---\n/);
  assert.match(part.text, /not a legacy Office file|content is not one/);
  assert.match(part.text, /save it as \.xlsx/);
});

test('cancelling mid-conversion rejects with the abort, never becomes attachment text, and leaves no folder', async () => {
  const controller = new AbortController();
  let dir = '';
  let started;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  const convert = (source, _output, { signal }) =>
    new Promise((_resolve, reject) => {
      dir = dirname(source);
      started();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const pending = preparePromptSubmissionForProvider(
    legacyPrompt(),
    {},
    { convertLegacy: convert, signal: controller.signal }
  );
  await running;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(existsSync(dir), false);
});

test('an already-cancelled intake never starts the converter', async () => {
  const controller = new AbortController();
  controller.abort();
  const convert = async () => assert.fail('converter must not run');
  await assert.rejects(
    preparePromptSubmissionForProvider(legacyPrompt(), {}, { convertLegacy: convert, signal: controller.signal }),
    { name: 'AbortError' }
  );
});

test('a timed-out conversion reports its message without the scratch path and cleans up', async () => {
  let dir = '';
  const convert = async (source) => {
    dir = dirname(source);
    throw new Error(`LibreOffice conversion timed out after 60 seconds (${source}; ${dir})`);
  };
  await assert.rejects(convertLegacyOfficeBuffer(OLE, 'a.xls', 'xlsx', { convert }), (error) => {
    assert.match(error.message, /timed out after 60 seconds/);
    assert.ok(!error.message.includes(dir));
    assert.ok(!/mixdog-attachment-/.test(error.message));
    return true;
  });
  assert.equal(existsSync(dir), false);
});

test('every spelling of the scratch folder is kept out of the error', async () => {
  const convert = async (source, output) => {
    const dir = dirname(source);
    throw new Error(`${dir}\\a.xls | ${dir.replaceAll('\\', '/')}/a.xls | bare ${dir} | ${output}`);
  };
  await assert.rejects(convertLegacyOfficeBuffer(OLE, 'a.xls', 'xlsx', { convert }), (error) => {
    assert.ok(!/mixdog-attachment-/.test(error.message), error.message);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('two concurrent conversions each use their own folder and each clean up', async () => {
  const dirs = [];
  const convert = async (source, output) => {
    dirs.push(dirname(source));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(output, minimalXlsx(`from ${source.length}`));
  };
  await Promise.all([
    convertLegacyOfficeBuffer(OLE, 'one.xls', 'xlsx', { convert }),
    convertLegacyOfficeBuffer(OLE, 'two.xls', 'xlsx', { convert }),
  ]);
  assert.equal(new Set(dirs).size, 2);
  for (const dir of dirs) assert.equal(existsSync(dir), false);
});

test('removal retries a held folder briefly and logs a final failure instead of hiding it', async () => {
  const convert = async (_source, output) => writeFile(output, 'x');
  let calls = 0;
  const flaky = async (dir, options) => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    return rm(dir, options);
  };
  await convertLegacyOfficeBuffer(OLE, 'a.xls', 'xlsx', {
    convert,
    remove: flaky,
    retryMs: 1,
    log: () => assert.fail('logged'),
  });
  assert.equal(calls, 3);

  const logged = [];
  let stuckDir = '';
  const convertStuck = async (source, output) => {
    stuckDir = dirname(source);
    await writeFile(output, 'x');
  };
  const stuck = async () => {
    throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
  };
  const result = await convertLegacyOfficeBuffer(OLE, 'a.xls', 'xlsx', {
    convert: convertStuck,
    remove: stuck,
    retryMs: 1,
    log: (line) => logged.push(line),
  });
  assert.equal(result.filename, 'a.xlsx');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /could not be removed: resource busy/);
  await rm(stuckDir, { recursive: true, force: true });
});

test('a cancel that lands while the folder is being removed still cancels a successful conversion', async () => {
  const controller = new AbortController();
  const convert = async (_source, output) => writeFile(output, minimalXlsx('late'));
  let dir = '';
  const abortingRemove = async (target, options) => {
    dir = target;
    controller.abort();
    return rm(target, options);
  };
  await assert.rejects(
    convertLegacyOfficeBuffer(OLE, 'a.xls', 'xlsx', { convert, remove: abortingRemove, signal: controller.signal }),
    { name: 'AbortError' }
  );
  assert.equal(existsSync(dir), false);
});

test('a cancel right after the converter finished is not turned into a stored attachment', async () => {
  const controller = new AbortController();
  const convert = async (_source, output) => {
    await writeFile(output, minimalXlsx('late'));
    controller.abort();
  };
  await assert.rejects(
    preparePromptSubmissionForProvider(legacyPrompt(), {}, { convertLegacy: convert, signal: controller.signal }),
    { name: 'AbortError' }
  );
});
