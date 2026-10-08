import assert from 'node:assert/strict';
import test from 'node:test';
import { base64ByteLength, inlineFileKind } from './inline-file-kind.mjs';

test('inlineFileKind recognises Office files by MIME type or by extension on a generic type', () => {
  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const zip = Buffer.from('PK\u0003\u0004rest', 'latin1').toString('base64');
  assert.equal(inlineFileKind(docx, zip), 'office');
  assert.equal(inlineFileKind('application/vnd.ms-excel.sheet.macroEnabled.12', zip), 'office');
  assert.equal(inlineFileKind('application/zip', zip, 'deck.PPTX'), 'office');
  assert.equal(inlineFileKind('application/octet-stream', zip, 'book.xlsm'), 'office');
  assert.equal(inlineFileKind('application/zip', zip, 'bundle.zip'), 'binary');
  assert.equal(inlineFileKind('application/zip', zip), 'binary');
  assert.equal(inlineFileKind('application/octet-stream', Buffer.from('%PDF-1.7 x').toString('base64'), 'a.docx'), 'pdf');
});

test('base64ByteLength counts decoded bytes across every padding width', () => {
  assert.equal(base64ByteLength(''), 0);
  assert.equal(base64ByteLength(null), 0);
  assert.equal(base64ByteLength('QQ=='), 1);
  assert.equal(base64ByteLength('QUI='), 2);
  assert.equal(base64ByteLength('QUJD'), 3);
  assert.equal(base64ByteLength(Buffer.alloc(1000).toString('base64')), 1000);
});
