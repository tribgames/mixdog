import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyHostBook,
  extractPairingLink,
  forgetHost,
  parsePairingLink,
  readHostBook,
  rememberHost,
} from './hosts.ts';
import { pairingBackAction } from './pairing-ui.ts';
import { PICKER_NATIVE_THEME, syncPickerNativeTheme } from './picker-theme.ts';

const ID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

test('pairing links are canonical routes, never credentials', () => {
  assert.deepEqual(parsePairingLink(`https://relay.example.com/d/${ID.toUpperCase()}/?x=1#frag`), {
    url: `https://relay.example.com/d/${ID}/`,
    deviceId: ID,
  });
  assert.equal(parsePairingLink(`http://relay.example.com/d/${ID}/`), null);
  assert.ok(parsePairingLink(`http://localhost:8787/d/${ID}/`));
  assert.equal(parsePairingLink(`https://user:pw@relay.example.com/d/${ID}/`), null);
  assert.equal(parsePairingLink('https://relay.example.com/'), null);
  assert.equal(parsePairingLink('nonsense'), null);
  assert.equal(extractPairingLink(`Open this: https://r.example.com/d/${ID}/ thanks`)?.deviceId, ID);
});

test('paired hosts are remembered, ordered and forgotten', () => {
  const a = parsePairingLink(`https://a.example.com/d/${ID}/`)!;
  const b = parsePairingLink(`https://b.example.com/d/${ID}/`)!;
  let book = rememberHost(emptyHostBook(), a, 1);
  book = rememberHost(book, b, 2);
  assert.deepEqual(
    book.hosts.map((host) => host.url),
    [b.url, a.url]
  );
  assert.equal(book.last, b.url);
  book = rememberHost(book, a, 3);
  assert.equal(book.hosts.length, 2);
  assert.equal(book.last, a.url);
  assert.equal(readHostBook(JSON.stringify(book)).hosts.length, 2);
  assert.deepEqual(readHostBook('{bad'), emptyHostBook());
  assert.equal(forgetHost(book, a.url).last, '');
});

test('bundled mobile pairing screens arm Back for every sub-step and update offer, never the plain PC list', () => {
  assert.equal(pairingBackAction({ step: 'start' }), null);
  assert.equal(
    pairingBackAction({
      step: 'start',
      pcs: [{ url: `https://a.example.com/d/${ID}/`, name: 'PC', last: true }],
    }),
    null
  );
  assert.equal(
    pairingBackAction({
      step: 'start',
      update: { version: '2.0.0', phase: 'available' },
    }),
    'dismiss-update'
  );
  assert.equal(
    pairingBackAction({
      step: 'start',
      update: { version: '2.0.0', phase: 'failed' },
    }),
    'dismiss-update'
  );
  assert.equal(
    pairingBackAction({
      step: 'start',
      update: { version: '2.0.0', phase: 'available' },
      opening: `https://a.example.com/d/${ID}/`,
    }),
    'dismiss-update',
    'update offer shown over an opening PC must dismiss the update offer first'
  );
  assert.equal(
    pairingBackAction({
      step: 'start',
      opening: `https://a.example.com/d/${ID}/`,
    }),
    'cancel'
  );
  for (const step of ['code', 'waiting', 'waiting-offline', 'result'] as const) {
    assert.equal(pairingBackAction({ step }), 'cancel');
  }
});

test('bundled picker synchronizes its dark #181818 backing to Android and iOS bridges', () => {
  const androidMessages: unknown[] = [];
  const iosMessages: unknown[] = [];
  syncPickerNativeTheme({
    MixdogNativeTheme: {
      postMessage(message) {
        androidMessages.push(JSON.parse(message));
      },
    },
    webkit: {
      messageHandlers: {
        mixdogTheme: {
          postMessage(payload) {
            iosMessages.push(payload);
          },
        },
      },
    },
  });
  assert.deepEqual(androidMessages, [PICKER_NATIVE_THEME]);
  assert.deepEqual(iosMessages, [PICKER_NATIVE_THEME]);
  assert.deepEqual(PICKER_NATIVE_THEME, { surface: '#181818', band: '#181818', followSystem: false });
});
