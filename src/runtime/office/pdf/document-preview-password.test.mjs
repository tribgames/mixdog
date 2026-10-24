import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildCfb, encryptOoxmlEntries, wordDocumentStream } from './cfb-fixture.mjs';
import {
  documentPreviewPages,
  documentPreviewPdf,
  removeTrackedPreviewScratchSync,
  trackedPreviewScratch,
} from './document-preview.mjs';
import { ooxmlEncryption, ooxmlKeyDerivations, ooxmlPasswordKey } from './ooxml-crypto.mjs';

const PASSWORD = 'Kor\u00e9e p\u00e4ss \u{1F511}';
const PLAIN = Buffer.concat([Buffer.from('PK\x03\x04 plain package '), Buffer.alloc(9000, 0x41)]);

function fixture(t, name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-password-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, name);
  writeFileSync(source, content);
  return { dir, source, cacheRoot: join(dir, 'cache') };
}

function engines({ libreOffice = false, installed = ['docx', 'xlsx', 'pptx'], office } = {}) {
  const calls = { libreOffice: [], detect: [], office: [] };
  return {
    calls,
    engines: {
      libreOfficeAvailable: async () => libreOffice,
      renderLibreOffice: async (path, output) => {
        calls.libreOffice.push({ path, content: readFileSync(path) });
        writeFileSync(output, 'pdf from libreoffice');
      },
      detectOffice: async (request) => {
        calls.detect.push(request);
        return { ok: true, applications: installed.map((format) => ({ format, installed: true })) };
      },
      callOffice: async (payload) => {
        calls.office.push({ payload, content: readFileSync(payload.path) });
        if (office) return office(payload);
        writeFileSync(payload.output, 'pdf from office');
        return { ok: true, output: payload.output };
      },
    },
  };
}

const cachedDocuments = (f) =>
  existsSync(join(f.cacheRoot, 'document-previews')) ? readdirSync(join(f.cacheRoot, 'document-previews')) : [];
const rejectsWith = (promise, code, check = () => {}) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.ok(!String(error.message).includes(PASSWORD), 'the password is never in the error');
    check(error);
    return true;
  });

for (const scheme of ['agile', 'standard']) {
  test(`${scheme} encryption: without a password the preview asks for one before any engine starts`, async (t) => {
    const f = fixture(t, 'secret.docx', buildCfb(encryptOoxmlEntries(PLAIN, PASSWORD, { scheme })));
    const e = engines({ libreOffice: true });
    await rejectsWith(
      documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines }),
      'OFFICE_PREVIEW_PASSWORD_PROTECTED'
    );
    assert.deepEqual([e.calls.libreOffice.length, e.calls.detect.length, e.calls.office.length], [0, 0, 0]);
    assert.deepEqual(cachedDocuments(f), []);
  });

  test(`${scheme} encryption: a wrong password is its own coded error, decided before any engine starts`, async (t) => {
    const f = fixture(t, 'secret.xlsx', buildCfb(encryptOoxmlEntries(PLAIN, PASSWORD, { scheme })));
    const e = engines({ libreOffice: true });
    await rejectsWith(
      documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines, password: `${PASSWORD}x` }),
      'OFFICE_PREVIEW_WRONG_PASSWORD',
      (error) => assert.equal(error.message, "That password didn't work. (OFFICE_PREVIEW_WRONG_PASSWORD)")
    );
    assert.deepEqual([e.calls.libreOffice.length, e.calls.office.length], [0, 0]);
    assert.deepEqual(cachedDocuments(f), []);
  });

  test(`${scheme} encryption: the right password renders the decrypted package with LibreOffice`, async (t) => {
    const f = fixture(t, 'secret.docx', buildCfb(encryptOoxmlEntries(PLAIN, PASSWORD, { scheme })));
    const e = engines({ libreOffice: true });
    const result = await documentPreviewPdf(f.source, {
      cacheRoot: f.cacheRoot,
      engines: e.engines,
      password: PASSWORD,
    });
    assert.equal(e.calls.libreOffice.length, 1);
    const [{ path, content }] = e.calls.libreOffice;
    assert.notEqual(path, f.source);
    assert.ok(content.equals(PLAIN), 'LibreOffice converts the decrypted package');
    assert.equal(existsSync(dirname(path)), false, 'the decrypted copy is removed after the render');
    assert.equal(readFileSync(result.path, 'utf8'), 'pdf from libreoffice');
    assert.ok(!result.path.startsWith(f.cacheRoot), 'the unlocked PDF never lands in the preview cache');
    assert.deepEqual(cachedDocuments(f), []);
  });
}

test('an unlocked document serves later page requests without its password, and keeps pages off disk', async (t) => {
  const f = fixture(t, 'deck.pptx', buildCfb(encryptOoxmlEntries(PLAIN, PASSWORD)));
  const e = engines({ libreOffice: true });
  const first = await documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines, password: PASSWORD });
  const again = await documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines });
  assert.equal(again.path, first.path);
  assert.equal(again.cached, true);
  assert.equal(e.calls.libreOffice.length, 1, 'no second render');
  const renderPages = async (_path, { pages }) => ({
    pageCount: 3,
    images: pages.map((page) => ({ page, width: 10, height: 10, mimeType: 'image/png', data: 'AAAA' })),
  });
  const pages = await documentPreviewPages(first.path, { pages: [1], cacheRoot: f.cacheRoot, renderPages });
  assert.equal(pages.pageCount, 3);
  assert.equal(existsSync(join(f.cacheRoot, 'document-preview-pages')), false, 'no page raster is stored on disk');
  // A changed document is a new identity: it asks for its password again.
  writeFileSync(f.source, buildCfb(encryptOoxmlEntries(PLAIN, PASSWORD)));
  await rejectsWith(
    documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines }),
    'OFFICE_PREVIEW_PASSWORD_PROTECTED'
  );
});

test('without LibreOffice the decrypted package goes to Microsoft Office, which never gets the password', async (t) => {
  const f = fixture(t, 'secret.xlsx', buildCfb(encryptOoxmlEntries(PLAIN, PASSWORD)));
  const e = engines();
  await documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines, password: PASSWORD });
  assert.equal(e.calls.office.length, 1);
  const [{ payload, content }] = e.calls.office;
  assert.equal(payload.format, 'xlsx');
  assert.equal(payload.readOnly, true);
  assert.equal('password' in payload, false);
  assert.ok(content.equals(PLAIN));
});

const encryptedDoc = (encrypted) =>
  buildCfb([wordDocumentStream(encrypted), { name: '1Table', data: Buffer.alloc(5000, 2) }]);

test('an encrypted .doc without Word says Microsoft Office is needed, never offering a password', async (t) => {
  const f = fixture(t, 'old.doc', encryptedDoc(true));
  const e = engines({ libreOffice: true, installed: [] });
  await rejectsWith(
    documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines }),
    'OFFICE_PREVIEW_PASSWORD_NEEDS_OFFICE'
  );
  assert.deepEqual(e.calls.detect, [{ format: 'docx' }]);
  assert.equal(e.calls.libreOffice.length, 0);
});

test('an encrypted .doc asks for its password, then Word opens it with that password from the request', async (t) => {
  const f = fixture(t, 'old.doc', encryptedDoc(true));
  const e = engines({ libreOffice: true });
  await rejectsWith(
    documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines }),
    'OFFICE_PREVIEW_PASSWORD_PROTECTED'
  );
  assert.equal(e.calls.office.length, 0, 'Word is not started without a password');
  const result = await documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines, password: PASSWORD });
  assert.equal(e.calls.libreOffice.length, 0, 'LibreOffice takes no password, so Word renders it');
  assert.equal(e.calls.office.length, 1);
  assert.equal(e.calls.office[0].payload.format, 'docx');
  assert.equal(e.calls.office[0].payload.password, PASSWORD, 'the password travels in the request body (stdin)');
  assert.equal(readFileSync(result.path, 'utf8'), 'pdf from office');
  assert.deepEqual(cachedDocuments(f), []);
});

test("Word's incorrect-password result is the wrong-password error, and engine text never carries the password", async (t) => {
  const f = fixture(t, 'old.doc', encryptedDoc(true));
  const wrong = engines({
    office: async () => ({ ok: false, error: "That password didn't work. (OFFICE_PREVIEW_WRONG_PASSWORD)" }),
  });
  await rejectsWith(
    documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: wrong.engines, password: PASSWORD }),
    'OFFICE_PREVIEW_WRONG_PASSWORD'
  );
  const echoing = engines({ office: async () => ({ ok: false, error: `Word failed opening ${PASSWORD} somehow` }) });
  await assert.rejects(
    documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: echoing.engines, password: PASSWORD }),
    (error) => {
      assert.equal(error.message, 'Word failed opening *** somehow');
      return true;
    }
  );
});

test('an unencrypted .doc still converts with LibreOffice', async (t) => {
  const f = fixture(t, 'plain.doc', encryptedDoc(false));
  const e = engines({ libreOffice: true });
  await documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines });
  assert.equal(e.calls.libreOffice.length, 1);
  assert.equal(e.calls.detect.length, 0);
});

test('extensible encryption (version x.3) and malformed descriptors are not guessed at', () => {
  assert.equal(ooxmlEncryption(Buffer.from([4, 0, 3, 0, 0, 0, 0, 0, 1, 2, 3, 4])), null);
  assert.equal(ooxmlEncryption(Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0, ...Buffer.from('<encryption/>')])), null);
  const [info] = encryptOoxmlEntries(PLAIN, PASSWORD);
  // Hash names are matched exactly as [MS-OFFCRYPTO] 2.3.4.10 writes them: "SHA512", never "SHA-512" or "sha512".
  for (const name of ['SHA-512', 'sha512']) {
    assert.equal(ooxmlEncryption(Buffer.from(info.data.toString('utf8').replaceAll('SHA512', name), 'utf8')), null);
  }
  assert.equal(ooxmlEncryption(info.data)?.type, 'agile');
});

// The \EncryptionInfo of an agile fixture, with its descriptor XML rewritten.
const AGILE_HEADER = Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]);
const descriptorXml = (info) => info.subarray(8).toString('utf8');
const withXml = (xml) => Buffer.concat([AGILE_HEADER, Buffer.from(xml, 'utf8')]);
const ENCRYPTION_NS = 'http://schemas.microsoft.com/office/2006/encryption';
const PASSWORD_NS = 'http://schemas.microsoft.com/office/2006/keyEncryptor/password';

test('the agile descriptor is read by namespace and schema, not by text patterns', async () => {
  const [info] = encryptOoxmlEntries(PLAIN, PASSWORD);
  const xml = descriptorXml(info.data);
  const opens = async (text) => {
    const descriptor = ooxmlEncryption(withXml(text));
    return Boolean(descriptor && (await ooxmlPasswordKey(descriptor, PASSWORD)));
  };
  // The same descriptor with the encryption namespace on a prefix, a comment that looks like a keyData, a
  // certificate key encryptor ahead of the password one, and a uri with surrounding whitespace.
  const prefixed = xml
    .replace(`xmlns="${ENCRYPTION_NS}"`, `xmlns:e="${ENCRYPTION_NS}"`)
    .replace(/<(\/?)(encryption|keyData|dataIntegrity|keyEncryptors|keyEncryptor)\b/g, '<$1e:$2');
  assert.equal(await opens(prefixed), true, 'prefixed');
  assert.equal(await opens(xml.replace('<keyData', '<!-- <keyData saltSize="1"/> --><keyData')), true, 'comment');
  const certificate =
    '<keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate">' +
    '<c:encryptedKey xmlns:c="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate" encryptedKeyValue="" X509Certificate="" certVerifier=""/>' +
    '</keyEncryptor>';
  assert.equal(await opens(xml.replace('<keyEncryptors>', `<keyEncryptors>${certificate}`)), true, 'certificate');
  assert.equal(await opens(xml.replace(`uri="${PASSWORD_NS}"`, `uri="  ${PASSWORD_NS} "`)), true, 'token');

  const refused = {
    'a DTD': xml.replace('?>', '?><!DOCTYPE encryption [<!ENTITY x "SHA512">]>'),
    'an external entity': xml.replace('?>', `?><!DOCTYPE encryption SYSTEM "file:///etc/passwd">`),
    'an undefined entity': xml.replace('hashAlgorithm="SHA512"', 'hashAlgorithm="&x;"'),
    'another encoding': xml.replace('encoding="UTF-8"', 'encoding="UTF-16"'),
    'the password key outside its namespace': xml.replace(/<p:encryptedKey\b/, '<encryptedKey'),
    'keyData in no namespace': xml.replace('<keyData', `<keyData xmlns=""`),
    'dataIntegrity after keyEncryptors': xml
      .replace(/<dataIntegrity[^>]*\/>/, '')
      .replace('</encryption>', `${xml.match(/<dataIntegrity[^>]*\/>/)[0]}</encryption>`),
    'two keyData elements': xml.replace(/(<keyData[^>]*\/>)/, '$1$1'),
    'an element the schema does not have': xml.replace('<keyEncryptors>', '<extra/><keyEncryptors>'),
    'a child inside keyData': xml.replace(/<keyData([^>]*)\/>/, '<keyData$1><x/></keyData>'),
    'two password key encryptors': xml.replace(/(<keyEncryptor\b.*<\/keyEncryptor>)/, '$1$1'),
    'no password key encryptor': xml.replace(`uri="${PASSWORD_NS}"`, 'uri="urn:other"'),
    'a spinCount over 10,000,000': xml.replace('spinCount="1000"', 'spinCount="10000001"'),
    'an empty spinCount': xml.replace('spinCount="1000"', 'spinCount=""'),
    'a salt that is not base64': xml.replace(/(<keyData[^>]*saltValue=")[^"]*/, '$1***'),
    'malformed XML': xml.replace('</keyEncryptors>', ''),
  };
  for (const [name, text] of Object.entries(refused)) assert.equal(ooxmlEncryption(withXml(text)), null, name);
  // The upper bound itself is allowed.
  assert.equal(ooxmlEncryption(withXml(xml.replace('spinCount="1000"', 'spinCount="10000000"'))).spinCount, 10_000_000);
});

for (const hashAlgorithm of ['SHA-1', 'SHA1', 'SHA256', 'SHA384']) {
  test(`an agile descriptor hashed with ${hashAlgorithm} opens with its password`, async (t) => {
    const f = fixture(t, 'secret.docx', buildCfb(encryptOoxmlEntries(PLAIN, PASSWORD, { hashAlgorithm })));
    const e = engines({ libreOffice: true });
    await documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines, password: PASSWORD });
    assert.ok(e.calls.libreOffice[0].content.equals(PLAIN));
  });
}

// The \EncryptedPackage entry of a fixture, changed in place.
const tampered = (entries, change) => {
  const [info, encryptedPackage, ...rest] = entries;
  const data = Buffer.from(encryptedPackage.data);
  change(data);
  return [info, { ...encryptedPackage, data }, ...rest];
};

test('a package whose HMAC does not match is refused as corrupt, after the password and before any engine', async (t) => {
  const changes = {
    'one ciphertext byte': (data) => {
      data[100] ^= 1;
    },
    'the StreamSize field': (data) => data.writeBigUInt64LE(BigInt(PLAIN.length - 1), 0),
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = fixture(t, 'secret.docx', buildCfb(tampered(encryptOoxmlEntries(PLAIN, PASSWORD), change)));
    const e = engines({ libreOffice: true });
    await rejectsWith(
      documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines, password: PASSWORD }),
      'OFFICE_PREVIEW_PASSWORD_CORRUPT'
    );
    await rejectsWith(
      documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines, password: `${PASSWORD}x` }),
      'OFFICE_PREVIEW_WRONG_PASSWORD'
    );
    assert.deepEqual([e.calls.libreOffice.length, e.calls.office.length], [0, 0], name);
    assert.deepEqual(cachedDocuments(f), [], name);
  }
});

test('malformed integrity data is corrupt before a password is asked; absent integrity data is allowed', async (t) => {
  const [info, ...rest] = encryptOoxmlEntries(PLAIN, PASSWORD);
  const xml = descriptorXml(info.data);
  const broken = {
    'an empty HMAC key': xml.replace(/encryptedHmacKey="[^"]*"/, 'encryptedHmacKey=""'),
    // saltSize 16 and hashSize 64 pad to 16 or 64 bytes, never 32.
    'an HMAC key of neither length': xml.replace(
      /encryptedHmacKey="[^"]*"/,
      `encryptedHmacKey="${Buffer.alloc(32).toString('base64')}"`
    ),
    'an HMAC value that is not base64': xml.replace(/encryptedHmacValue="[^"]*"/, 'encryptedHmacValue="%%%%"'),
    'an HMAC value of the wrong length': xml.replace(
      /encryptedHmacValue="[^"]*"/,
      `encryptedHmacValue="${Buffer.alloc(16).toString('base64')}"`
    ),
    'no HMAC value': xml.replace(/ encryptedHmacValue="[^"]*"/, ''),
  };
  for (const [name, text] of Object.entries(broken)) {
    const f = fixture(t, 'secret.docx', buildCfb([{ ...info, data: withXml(text) }, ...rest]));
    const e = engines({ libreOffice: true });
    for (const password of ['', PASSWORD]) {
      await rejectsWith(
        documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines, password }),
        'OFFICE_PREVIEW_PASSWORD_CORRUPT'
      );
    }
    assert.equal(e.calls.libreOffice.length, 0, name);
  }
  const absent = fixture(t, 'plain-agile.docx', buildCfb(encryptOoxmlEntries(PLAIN, PASSWORD, { integrity: false })));
  const e = engines({ libreOffice: true });
  await documentPreviewPdf(absent.source, { cacheRoot: absent.cacheRoot, engines: e.engines, password: PASSWORD });
  assert.ok(e.calls.libreOffice[0].content.equals(PLAIN));
});

// [hash, keyData saltSize, HMAC salt bytes]: the salt [MS-OFFCRYPTO] 2.3.4.14 step 2 sizes by saltSize, the one Excel
// sizes by hashSize, and salts whose block padding would reach past one hash block (129 bytes pad to 144).
const INTEGRITY_SALTS = [
  ['SHA512', 16, 16],
  ['SHA512', 16, 64],
  ['SHA512', 64, 64],
  ['SHA512', 129, 129],
  ['SHA-1', 16, 16],
  ['SHA-1', 16, 20],
  ['SHA-1', 64, 64],
  ['SHA-1', 129, 129],
];

test('integrity data keyed by a saltSize or hashSize salt verifies, and one flipped byte fails it', async (t) => {
  for (const [hashAlgorithm, keySaltSize, hmacSaltSize] of INTEGRITY_SALTS) {
    const label = `${hashAlgorithm}, saltSize ${keySaltSize}, ${hmacSaltSize}-byte HMAC salt`;
    const entries = encryptOoxmlEntries(PLAIN, PASSWORD, { hashAlgorithm, keySaltSize, hmacSaltSize });
    const e = engines({ libreOffice: true });
    const intact = fixture(t, 'secret.docx', buildCfb(entries));
    await documentPreviewPdf(intact.source, { cacheRoot: intact.cacheRoot, engines: e.engines, password: PASSWORD });
    assert.ok(e.calls.libreOffice[0]?.content.equals(PLAIN), label);
    const flipped = fixture(t, 'secret.docx', buildCfb(tampered(entries, (data) => (data[100] ^= 1))));
    await rejectsWith(
      documentPreviewPdf(flipped.source, { cacheRoot: flipped.cacheRoot, engines: e.engines, password: PASSWORD }),
      'OFFICE_PREVIEW_PASSWORD_CORRUPT'
    );
    assert.equal(e.calls.libreOffice.length, 1, label);
  }
});

// A descriptor whose password hashing takes seconds: the full 10,000,000 rounds the spec allows.
const slowEntries = () => {
  const [info, ...rest] = encryptOoxmlEntries(PLAIN, PASSWORD);
  return [
    { ...info, data: withXml(descriptorXml(info.data).replace('spinCount="1000"', 'spinCount="10000000"')) },
    ...rest,
  ];
};
const until = async (condition, what) => {
  for (let waited = 0; !condition(); waited += 5) {
    assert.ok(waited < 10_000, `waiting for ${what}`);
    await sleep(5);
  }
};

test('a cancelled request ends its password derivation at once, off the event loop, leaving nothing behind', async (t) => {
  const f = fixture(t, 'slow.docx', buildCfb(slowEntries()));
  const e = engines({ libreOffice: true });
  const before = new Set(trackedPreviewScratch());
  const controller = new AbortController();
  const pending = documentPreviewPdf(f.source, {
    cacheRoot: f.cacheRoot,
    engines: e.engines,
    password: PASSWORD,
    signal: controller.signal,
  });
  const outcome = pending.then(
    () => 'rendered',
    (error) => error.name
  );
  await until(() => ooxmlKeyDerivations().running === 1, 'the derivation to start');
  const tick = performance.now();
  await sleep(20);
  assert.ok(performance.now() - tick < 500, 'timers still run while the password is hashed');
  const abortedAt = performance.now();
  controller.abort();
  assert.equal(await outcome, 'AbortError');
  assert.ok(performance.now() - abortedAt < 1000, 'the abort ends the derivation without waiting for it');
  await until(() => ooxmlKeyDerivations().running === 0, 'the derivation thread to end');
  assert.deepEqual([e.calls.libreOffice.length, e.calls.office.length], [0, 0]);
  assert.deepEqual(
    trackedPreviewScratch().filter((directory) => !before.has(directory)),
    [],
    'no scratch left'
  );
});

test('password derivations run two at a time, and a queued one is cancelled without starting', async () => {
  const descriptor = ooxmlEncryption(slowEntries()[0].data);
  const controllers = [0, 1, 2].map(() => new AbortController());
  const outcomes = controllers.map((controller) =>
    ooxmlPasswordKey(descriptor, PASSWORD, { signal: controller.signal }).then(
      () => 'derived',
      (error) => error.name
    )
  );
  assert.deepEqual(ooxmlKeyDerivations(), { running: 2, waiting: 1 });
  controllers[2].abort();
  assert.equal(await outcomes[2], 'AbortError');
  assert.deepEqual(ooxmlKeyDerivations(), { running: 2, waiting: 0 });
  controllers[0].abort();
  controllers[1].abort();
  assert.deepEqual(await Promise.all(outcomes.slice(0, 2)), ['AbortError', 'AbortError']);
  await until(() => ooxmlKeyDerivations().running === 0, 'both threads to end');
});

test('scratch directories are tracked from creation until a removal succeeds, then removed at exit', async (t) => {
  const f = fixture(t, 'secret.docx', buildCfb(encryptOoxmlEntries(PLAIN, PASSWORD)));
  const e = engines({ libreOffice: true });
  const during = [];
  const render = e.engines.renderLibreOffice;
  e.engines.renderLibreOffice = async (path, output) => {
    during.push({ copy: dirname(path), pdf: dirname(output), tracked: trackedPreviewScratch() });
    await render(path, output);
  };
  e.engines.removeBackoffMs = 1;
  e.engines.removeDirectory = async () => {
    throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  };
  const result = await documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines, password: PASSWORD });
  const [{ copy, pdf, tracked }] = during;
  assert.ok(tracked.includes(copy), 'the decrypted copy is tracked while it is rendered');
  assert.ok(tracked.includes(pdf), 'the unlocked PDF directory is tracked while it is written');
  // Every background retry fails too (1 + 2 + 4 + 8 + 16 + 32 ms).
  await sleep(200);
  assert.equal(existsSync(copy), true);
  assert.ok(trackedPreviewScratch().includes(copy), 'a removal that keeps failing stays tracked');
  // The unlocked PDF disappears: the entry is pushed out, and its directory, whose removal fails, stays tracked.
  rmSync(result.path);
  await rejectsWith(
    documentPreviewPdf(f.source, { cacheRoot: f.cacheRoot, engines: e.engines }),
    'OFFICE_PREVIEW_PASSWORD_PROTECTED'
  );
  await sleep(200);
  assert.equal(existsSync(pdf), true);
  assert.ok(trackedPreviewScratch().includes(pdf), 'a pushed-out unlocked PDF stays tracked until it is removed');
  removeTrackedPreviewScratchSync();
  assert.deepEqual([existsSync(copy), existsSync(pdf)], [false, false], 'the exit cleanup removes both');
  assert.deepEqual(
    trackedPreviewScratch().filter((directory) => directory === copy || directory === pdf),
    []
  );
});
