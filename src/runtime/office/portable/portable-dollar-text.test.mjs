import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { applyTabularBatch } from '../core/tabular.mjs';
import { addDocxComment } from './portable-docx-edits.mjs';
import { xmlEncode } from './portable-xml.mjs';
import {
  addPackageRelationship,
  ensureContentTypeOverride,
  ensureDefaultContentType,
  zipText,
} from './portable-opc.mjs';

// `$$`, `$&`, `$'` and "$`" are String.replace patterns: user text that holds
// them must land in the file exactly as written.
const DOLLARS = "math $$x$$ cost $& and $' or $` then $1";

test('office find/replace writes replacement text that holds $ patterns verbatim', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-office-dollar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'sheet.csv');
  await writeFile(file, 'name\r\nTBD\r\n', 'utf8');
  await applyTabularBatch(file, 'csv', [{ op: 'replace_text', find: 'TBD', replace: DOLLARS }]);
  assert.equal(await readFile(file, 'utf8'), `name\r\n${DOLLARS}\r\n`);
});

test('a DOCX comment keeps $ patterns in its text', async () => {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  );
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hello there</w:t></w:r></w:p></w:body></w:document>'
  );
  await addDocxComment(zip, { op: 'add_comment', find: 'hello', text: DOLLARS, author: 'a' });
  assert.ok((await zipText(zip, 'word/comments.xml')).includes(xmlEncode(DOLLARS)));
});

test('package parts keep $ patterns in content types and relationship targets', async () => {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  );
  await ensureContentTypeOverride(zip, '/p$$q.xml', 'text/$1$`x');
  await ensureDefaultContentType(zip, 'a$$b', 'text/$1$`x');
  const types = await zipText(zip, '[Content_Types].xml');
  assert.ok(types.includes('PartName="/p$$q.xml" ContentType="text/$1$`x"'));
  assert.ok(types.includes('Extension="a$$b" ContentType="text/$1$`x"'));
  await addPackageRelationship(zip, '_rels/.rels', 'http://example.test/rel', 'files/$$x$`y.xml');
  assert.ok((await zipText(zip, '_rels/.rels')).includes('Target="files/$$x$`y.xml"'));
});
