// Node's recording native/core/fixtures/agent-room-cases/golden.json (record-agent-room-cases.mjs at b6f10295a), cases 3, 25, 27,
// 45 and 47: a stored room message as the transcript row a client shows (`roomRowItem`, `restoreTranscriptItems`) and as the row the
// room host reads back (`roomRowsOfItems`). One chain: the recorded inputs went through the core (mixdog-core
// `run_host::room_rows_replay`, the room log's append and `thread/read`, and mixdog-core-rooms `agent_room_replay` for case 25's
// exchange), whose output is agent-room-core.json / agent-room-core-exchange.json; here the client's `rowOf` turns the core's
// `roomRow` lines into rows, and each case is compared whole, in recorded key order, with the recording.
//
// A line's item id is minted per run; the core file holds `<item-id>` and each line gets the id the recorder passed to `roomRowItem`
// (the manifest's `replay.normalised.lineItemId`).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Obj } from '../src/obj.ts';
import { rowOf } from '../src/rows.ts';

type O = Record<string, any>;
const read = (url: URL): O => JSON.parse(readFileSync(url, 'utf8'));
const goldenBytes = readFileSync(new URL('../../../native/core/fixtures/agent-room-cases/golden.json', import.meta.url));
const golden = JSON.parse(goldenBytes.toString('utf8'));
/** The core's half (`mixdog_testkit::chain_output`), refused when it was made from another recording. */
function coreOf(name: string): O {
  const file = read(new URL(name, import.meta.url));
  assert.equal(file.inputs, createHash('sha256').update(goldenBytes).digest('hex'), `${name} was made from another golden.json: run the Rust replay`);
  return file.core;
}
const core = coreOf('agent-room-core.json');
const exchange = coreOf('agent-room-core-exchange.json');
const { exact, fromExact } = (await import(new URL('../../../benchmarks/rust-core/recorders/lib/exact.mjs', import.meta.url).href)) as {
  exact: (value: unknown) => unknown;
  fromExact: (encoded: unknown) => any;
};

/** The client's row of a core line, under the item id the recorder gave `roomRowItem` (none: `undefined`). */
function row(line: O, id?: string): O {
  const { id: _minted, ...rest } = line;
  const shown = rowOf((id === undefined ? rest : { ...rest, id }) as Obj);
  assert.ok(shown, 'a room line has a row');
  return shown;
}

/** The recorded value of case `index`, checked to be the case named `name`. */
function recorded(index: number, name: string): O {
  const c = golden.cases[index];
  assert.equal(c.case, name, `case ${index}`);
  return c.observed;
}

/** Whole and in order: the encoded value equals the recording byte for byte. */
function same(got: O, want: O, what: string): void {
  const encoded = exact(got);
  assert.deepStrictEqual(encoded, want, what);
  assert.equal(JSON.stringify(encoded), JSON.stringify(want), `${what}: key order`);
}

test('case 3: a row keeps its addressees as an ordered list; older single ids read the same', () => {
  const want = recorded(3, 'a row keeps its addressees as an ordered list; older single ids read the same');
  const legacy = row(core['3'].legacyLines[0]).room;
  same(
    {
      normalizedRow: core['3'].normalizedRow,
      legacyInput: fromExact(want.legacyInput),
      legacyItemRoomTo: legacy.to,
      targetsOfSingle: legacy.to.map((id: string, i: number) => ({ id, name: legacy.toName[i] })),
    },
    want,
    'case 3',
  );
});

test('case 25: a member is named exactly by id or name; a row from another session keeps and shows its sender', () => {
  const want = recorded(25, 'a member is named exactly by id or name; a row from another session keeps and shows its sender');
  const [bot, lead, own] = core['25'].lines;
  same(
    {
      named: core['25'].named,
      row: core['25'].row,
      botItem: row(bot, 'm1'),
      leadItem: row(lead, 'm2'),
      ownItem: row(own, 'm3'),
      onlyExchange: { spec: fromExact(want.onlyExchange.spec), ...exchange['25'].onlyExchange },
    },
    want,
    'case 25',
  );
});

test('case 27: rows a member was already handed never come back as new', () => {
  const want = recorded(27, 'rows a member was already handed never come back as new');
  same(
    {
      rows: fromExact(want.rows),
      calls: (fromExact(want.calls) as O[]).map(({ cursor, self, handedId, rows }, i) => ({ cursor, self, handedId, rows, result: core['27'].calls[i] })),
      rowAtFromTranscript: core['27'].readBack[0].at,
    },
    want,
    'case 27',
  );
});

test('case 45: stored rows restore as a user bubble or a room notice and read back', () => {
  const want = recorded(45, 'stored rows restore as a user bubble or a room notice and read back');
  const [user, speech] = core['45'].lines;
  same({ user: row(user, 'h1'), speech: row(speech, 'h2'), rowsOfItems: core['45'].readBack }, want, 'case 45');
});

test("case 48: the log's intake stores a user row's files as a chat prompt's and hands back references", () => {
  const want = recorded(48, "the log's intake stores a user row's files as a chat prompt's and hands back references");
  const c = core['48'];
  // The notice a runtime hosting the log shows: the fields Node's delivery picks of `roomRowItem` (agent-room-delivery.mjs commit).
  const notices = (c.lines as O[]).map((line) => {
    const { text, tone, room, messageId, attachments, images } = row(line);
    return { text, tone, room, messageId, attachments, images };
  });
  same(
    { input: fromExact(want.input), added: c.added, rows: c.rows, storedBytes: c.storedBytes, sessionMessages: c.sessionMessages, notices },
    want,
    'case 48',
  );
});

test('case 47: a user row keeps its stored files through the log and a restore; no bytes; peer speech keeps only its produced files', () => {
  const want = recorded(47, 'a user row keeps its stored files through the log and a restore; no bytes; peer speech keeps only its produced files');
  const c = core['47'];
  same(
    {
      rowInput: fromExact(want.rowInput),
      message: c.message,
      itemFromRow: row(c.lines[0]),
      restored: row(c.lines[0]),
      rowsOfRestored: c.readBack,
      speechRow: c.speechRow,
      speechMessage: c.speechMessage,
      speechItemAttachments: row(c.speechLines[0]).attachments,
      passRow: c.passRow,
    },
    want,
    'case 47',
  );
});
