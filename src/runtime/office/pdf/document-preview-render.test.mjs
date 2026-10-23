import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { documentPreviewPdf } from './document-preview.mjs';

function fixture(t, name = 'review.xlsx') {
  const dir = mkdtempSync(join(tmpdir(), 'doc-render-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, name);
  writeFileSync(source, 'source bytes');
  return { dir, source, cacheRoot: join(dir, 'cache') };
}

function engines(overrides = {}) {
  const calls = { libreOffice: [], detect: [], office: [] };
  return {
    calls,
    engines: {
      libreOfficeAvailable: async () => false,
      renderLibreOffice: async (path, output) => {
        calls.libreOffice.push({ path, output });
        writeFileSync(output, 'pdf from libreoffice');
      },
      detectOffice: async (request) => {
        calls.detect.push(request);
        return { ok: true, available: true, applications: [{ format: 'xlsx', installed: true }] };
      },
      callOffice: async (payload, options) => {
        calls.office.push({ payload, options, copyExisted: existsSync(payload.path) });
        writeFileSync(payload.output, 'pdf from office');
        return { ok: true, output: payload.output };
      },
      ...overrides,
    },
  };
}

test('without LibreOffice, Microsoft Office renders a read-only copy and cleans it up', async (t) => {
  const f = fixture(t);
  const e = engines();
  const result = await documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines });
  assert.equal(e.calls.libreOffice.length, 0);
  assert.deepEqual(e.calls.detect, [{ format: 'xlsx' }]);
  assert.equal(e.calls.office.length, 1);
  const { payload, copyExisted } = e.calls.office[0];
  assert.equal(payload.action, 'render');
  assert.equal(payload.format, 'xlsx');
  assert.equal(payload.readOnly, true, 'the host opens the document read-only');
  assert.equal(payload.mode, 'background');
  assert.notEqual(payload.path, f.source, 'the source itself is never handed to Office');
  assert.equal(basename(payload.path), 'review.xlsx');
  assert.equal(copyExisted, true);
  assert.equal(existsSync(dirname(payload.path)), false, 'the private copy is removed');
  assert.equal(readFileSync(f.source, 'utf8'), 'source bytes');
  assert.equal(payload.output, result.path);
  assert.equal(readFileSync(result.path, 'utf8'), 'pdf from office');
  assert.equal(result.cached, false);
  // The second open is served from the cache without another render.
  const again = await documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines });
  assert.equal(again.cached, true);
  assert.equal(e.calls.office.length, 1);
});

test('concurrent opens of one document share a single Office render', async (t) => {
  const f = fixture(t);
  const e = engines();
  const options = { cacheRoot: f.cacheRoot, engines: e.engines };
  await Promise.all([documentPreviewPdf(f.source, options), documentPreviewPdf(f.source, options)]);
  assert.equal(e.calls.office.length, 1);
});

test('a failed Office render surfaces its error and leaves no cache entry or copy', async (t) => {
  const f = fixture(t);
  const e = engines({
    callOffice: async (payload) => {
      e.calls.office.push({ payload });
      return { ok: false, error: 'Excel could not open the file' };
    },
  });
  await assert.rejects(
    documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines }),
    /Excel could not open the file/
  );
  assert.equal(existsSync(dirname(e.calls.office[0].payload.path)), false);
  assert.deepEqual(readdirSync(join(f.cacheRoot, 'document-previews')), []);
});

test('a password-protected document is reported plainly, not as the raw host error', async (t) => {
  const f = fixture(t);
  const e = engines({
    callOffice: async (payload) => {
      e.calls.office.push({ payload });
      return { ok: false, error: 'This file is password-protected. (OFFICE_PREVIEW_PASSWORD_PROTECTED)' };
    },
  });
  await assert.rejects(
    documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines }),
    (error) => {
      assert.equal(error.code, 'OFFICE_PREVIEW_PASSWORD_PROTECTED');
      assert.equal(error.message, "This file is password-protected and can't be previewed. (OFFICE_PREVIEW_PASSWORD_PROTECTED)");
      return true;
    }
  );
  assert.deepEqual(readdirSync(join(f.cacheRoot, 'document-previews')), []);
});

// A CurrentUserAtom as PowerPoint writes it: record type 0x0FF6, length, size, then the headerToken.
const currentUser = (token) =>
  Buffer.concat([Buffer.alloc(40), Buffer.from([0, 0, 0xf6, 0x0f, 0x18, 0, 0, 0, 0x14, 0, 0, 0]), Buffer.from(token), Buffer.alloc(40)]);

test('an encrypted binary .ppt is refused before PowerPoint is started', async (t) => {
  const f = fixture(t, 'old.ppt');
  writeFileSync(f.source, currentUser([0xdf, 0xc4, 0xd1, 0xf3]));
  const e = engines({
    detectOffice: async () => ({ ok: true, applications: [{ format: 'pptx', installed: true }] }),
  });
  await assert.rejects(documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines }), (error) => {
    assert.equal(error.code, 'OFFICE_PREVIEW_PASSWORD_PROTECTED');
    return true;
  });
  assert.equal(e.calls.office.length, 0, 'Office is never asked to open it');
  assert.deepEqual(readdirSync(join(f.cacheRoot, 'document-previews')), []);
});

test('an unencrypted binary .ppt, or stray token bytes, still render through Office', async (t) => {
  for (const content of [
    currentUser([0x5f, 0xc0, 0x91, 0xe3]),
    Buffer.concat([Buffer.alloc(64), Buffer.from([0xdf, 0xc4, 0xd1, 0xf3]), Buffer.alloc(64)]),
  ]) {
    const f = fixture(t, 'old.ppt');
    writeFileSync(f.source, content);
    const e = engines({
      detectOffice: async () => ({ ok: true, applications: [{ format: 'pptx', installed: true }] }),
    });
    await documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines });
    assert.equal(e.calls.office.length, 1);
    assert.equal(e.calls.office[0].payload.format, 'pptx');
  }
});

test('with neither LibreOffice nor Microsoft Office, the error says what to install', async (t) => {
  const f = fixture(t);
  const e = engines({
    detectOffice: async () => ({ ok: true, available: false, applications: [{ format: 'xlsx', installed: false }] }),
  });
  await assert.rejects(
    documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines }),
    (error) => {
      assert.equal(error.code, 'OFFICE_PREVIEW_UNAVAILABLE');
      assert.match(error.message, /needs LibreOffice or Microsoft Office/);
      assert.match(error.message, /Extensions → Built-in → Office/);
      assert.doesNotMatch(error.message, /background mode/);
      return true;
    }
  );
  assert.equal(e.calls.office.length, 0);
});

test('Office installed for another format only does not count', async (t) => {
  const f = fixture(t, 'deck.pptx');
  const e = engines();
  await assert.rejects(
    documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines }),
    /needs LibreOffice or Microsoft Office/
  );
  assert.deepEqual(e.calls.detect, [{ format: 'pptx' }]);
});

test('with LibreOffice present the LibreOffice path is unchanged', async (t) => {
  const f = fixture(t);
  const e = engines({ libreOfficeAvailable: async () => true });
  const result = await documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines });
  assert.equal(e.calls.libreOffice.length, 1);
  assert.equal(e.calls.libreOffice[0].path, f.source);
  assert.equal(e.calls.detect.length, 0);
  assert.equal(e.calls.office.length, 0);
  assert.equal(readFileSync(result.path, 'utf8'), 'pdf from libreoffice');
});
