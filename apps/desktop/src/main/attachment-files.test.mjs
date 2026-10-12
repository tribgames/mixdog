import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('writeAttachmentFile stages allowlisted types and rejects the rest before touching disk', async () => {
  const { writeAttachmentFile } = await import('./attachment-files.ts');
  const temp = await mkdtemp(join(tmpdir(), 'mixdog-stage-'));
  try {
    const file = await writeAttachmentFile(temp, 'data:application/pdf;base64,aGk=', 'My Report.PDF');
    assert.match(file, /mixdog-attachments[\\/].+\.pdf$/);
    assert.equal((await readFile(file)).toString(), 'hi');
    assert.equal(await writeAttachmentFile(temp, 'data:application/pdf;base64,aGk=', 'My Report.PDF'), file);
    for (const [mime, name] of [
      ['application/x-msdownload', 'setup.exe'],
      ['application/octet-stream', 'run.bat'],
      ['application/x-sh', 'a.sh'],
    ]) {
      await assert.rejects(writeAttachmentFile(temp, `data:${mime};base64,aGk=`, name), TypeError, `${mime} ${name}`);
    }
    await assert.rejects(writeAttachmentFile(temp, 'http://x/a.txt', 'a.txt'), TypeError);
    assert.equal((await readdir(join(temp, 'mixdog-attachments'))).length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
