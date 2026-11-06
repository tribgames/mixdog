# Mixdog store on-disk format (frozen)

Status: **frozen** (P0-STORE). The types, constants and DDL live in `src/schema/`; the
vectors in `src/schema/vectors/` are checked by `src/schema/tests.rs`. A change to anything
below is a format change: it changes the vectors, the generator and this file together.

Inputs: `spec-v2/store-migration.md` (SM) §3, §5, §6, §10, §11.5 and `spec-v2/SPEC.md`
R2, R26–R35, §4.11. Where this file differs from them, §11 lists the decision and why.
`<D>` = data dir, `<H>` = `~/.mixdog`, `<P>` = Electron profile (SPEC §4.11).

## 1. Layout

```
<D>/sessions/<id>/log.<nnnnnn>                 framed records (§2–§7); nnnnnn = 6 decimal digits from 000000
<D>/prompt-attachments/sha256/<ab>/<64 hex>    the one blob store (§4)
<D>/index/store.sqlite                         derived catalog + projection (§8.2)
<D>/state/core.sqlite                          non-derived small core state (§8.3)
<D>/usage/ledger.sqlite                        usage ledger, user_version 3 (§9)
<D>/migration/{manifest.json, journal.000000, stage/, complete.json}   (§10)
<D>/quarantine/<code>/<escaped key>/{reason.json, <moved files>}      (§10.8)
```

- `<id>` matches `^[A-Za-z0-9_-]+$`. A session directory holds only `log.*` files and
  transient `.<name>.tmp-<16 hex>` files of `publish_file`; nothing else.
- `log.000000` starts with the `session` frame. Every later file starts with a
  `checkpoint` frame and is created whole through `publish_file` (synced, then renamed).
  No append makes a file exceed `ROTATE_AT` = 64 MiB; the next batch goes to a new file.
  Files other than the newest are immutable.
- No store file is memory-mapped.

## 2. Frame

```
<ordinal:16 hex> SP <len:8 hex> SP <crc:8 hex> SP <hcrc:8 hex> SP <payload: len bytes> LF
```

| Bytes | Content |
|---|---|
| `[0,16)` | ordinal, lowercase hex, zero-padded |
| `16` | `0x20` |
| `[17,25)` | `len` = payload byte count, lowercase hex |
| `25` | `0x20` |
| `[26,34)` | `crc` = CRC-32C of the payload, lowercase hex |
| `34` | `0x20` |
| `[35,43)` | `hcrc` = CRC-32C of bytes `[0,35)`, lowercase hex |
| `43` | `0x20` |
| `[44, 44+len)` | payload: one record (§5.1) |
| `44+len` | `0x0A` |

- Header = 44 bytes; a frame is `45 + len` bytes.
- CRC-32C = Castagnoli: reflected polynomial `0x82F63B78`, init and final XOR
  `0xFFFFFFFF`; check value of `123456789` = `e3069283`.
- The header checks itself: `hcrc` covers the ordinal, `len`, `crc` and their
  separators, so a header is valid or damaged on its own, before any payload byte is
  read. `crc` covers the payload only.
- Ordinals are contiguous per session lineage: `session` has 0, or
  `base.end_ordinal_exclusive` for a fork. The migration journal counts from 0.
- **F1 (line property).** The writer's payload never contains `0x0A` or `0x00`
  (`serde_json` escapes every control character) and no header byte is `0x00`. A
  committed frame is therefore exactly one LF-terminated line, and the file's trailing
  run of `0x00` bytes is never part of a written frame.

## 3. Reading frames

### 3.1 Terms

A *frame start* is a known boundary: offset 0 of a file, the end of a committed frame,
or the start of a committed `checkpoint`/`session` frame found by the reverse scan
(§3.5). `expected` is the ordinal due there.

### 3.2 Classification (forward scan from a frame start `p`)

`W` = the *written end* of the file: the offset just past its last non-zero byte (0 if
none). By F1, `[W, EOF)` holds no written frame byte: it is what a filesystem shows for
appended bytes that never reached the disk. A byte is *present* iff it lies before `W`.

Evaluate in this order; the first rule that applies decides.

1. `p == EOF` → **clean end**.
2. `p ≥ W` (only zeros remain) → **torn at `p`**.
3. **Header fields.** Let `h` = the present header bytes, `[p, min(W, p+44))` (1 to 44
   of them). One procedure checks `h` whether it is complete or not; each step looks at
   the bytes of its field that are present. A field whose bytes are all present gets
   the exact check; the one field cut off by `W` (if any) gets the same check on its
   present prefix, which is "the present bytes are a prefix of some value the writer
   could put there". The first failing step decides, with its cause:
   1. `hcrc` (bytes 35–43, the checksum digits and the final SP): the present bytes
      differ from the start of `hex8(CRC-32C(h[0..35])) SP` → **corrupt `header`**.
      (Any `hcrc` byte present implies bytes 0–34 are, so the expected text is known.)
   2. ordinal (bytes 0–15): the present bytes differ from the start of `expected` as 16
      lowercase hex digits → **corrupt `ordinal`** (gap, repeat, wrong fork start,
      another log's frame, `xyz`).
   3. separators (bytes 16, 25, 34): a present one is not SP → **corrupt `header`**.
   4. `len` (bytes 17–24): a present byte is not a lowercase hex digit, or the present
      digits followed by `0`s up to 8 digits exceed `MAX_FRAME_PAYLOAD` (no completion is
      in range; for a complete field, the value itself) → **corrupt `length`**.
   5. `crc` (bytes 26–33): a present byte is not a lowercase hex digit → **corrupt
      `crc`** (its value is checked against the payload in rule 6).
4. `|h| < 44` (the header is not fully present; rule 3 passed, so `h` is a prefix of a
   header the writer can produce for `expected`) → **torn at `p`**. No frame fits there:
   a complete frame ends with a present LF, at least 45 bytes after `p`.
5. `p + 44 + len > W` (the payload is not fully present) → **torn at `p`**: an
   incomplete frame after a valid header, followed by zeros or end of file.
6. The payload's CRC-32C is not `crc` → **corrupt `crc`**. A fully present payload is
   judged by its CRC alone, whatever follows it.
7. `p + 44 + len == W` (the LF is not present) → **torn at `p`**.
8. Byte `p + 44 + len` is not LF (another byte, or a `0x00` with written bytes after it)
   → **corrupt `framing`**.
9. Otherwise the frame is **committed**: `p += 45 + len`, `expected += 1`.

So 43 bytes with a wrong checksum are corrupt `header`, exactly as the same bytes plus
the final SP are; 43 bytes with the right checksum are torn.

Committed means header-valid, in sequence, payload CRC-valid and terminated, nothing
else. A committed frame past the last acknowledged barrier is still committed (its op was
answered `unknown`, never `failed`). Torn is decided only where no complete frame can lie
in `[p, EOF)`: rules 2, 4, 5 and 7 each leave every byte from `p` on either absent or part
of the one frame at `p`, which is not complete. The frame layer does not parse JSON: a
committed frame whose payload is not a valid record is damage of the record layer at that
frame (same handling as §3.4).

The table in `src/schema/vectors/frames.json` (`classification`, each case naming its
rule) is the normative example set: clean, NUL extension, torn inside each header field
and a partial header prefix, a header missing only its final SP with a correct `hcrc`;
short tails that no writer could produce (`xyz`, a wrong ordinal, a wrong separator, a
letter in `len`, `crc` or `hcrc`, a complete or partial `len` out of range, a wrong
`hcrc` with only the final SP missing) as damage; torn payload (also with zeros past the frame end and with a hole at end of
file), missing LF (with and without zeros); the review's damage cases — a complete payload
with a bad CRC and no LF (with and without zeros), a partial frame with the wrong ordinal,
impossible header bytes followed by zeros, an LF inside a complete payload; CRC flips
(middle and last frame), wrong `crc` field, wrong `hcrc` field, a flipped header digit,
uppercase hex, a zero hole followed by a valid frame, ordinal gap/repeat/wrong fork start,
`len` over the maximum, wrong terminator, a zero terminator followed by a frame, and
committed frames containing NUL or non-JSON.

### 3.3 Byte bounds

| Constant | Value | Rule |
|---|---|---|
| `INLINE_MAX` | 256 KiB | A body slot whose encoding is longer is a blob; an item's `body` and `prompt` share it (§4.2). |
| `NON_BODY_MAX` | 40 KiB | Everything of a record but its slots' inline values, at the type bounds below; the largest kind (`item`, its body inline at `INLINE_MAX` and so its `prompt` a blob reference) needs 34,487 bytes. |
| `MAX_FRAME_PAYLOAD` | 296 KiB (`0x4a000`) | `INLINE_MAX + NON_BODY_MAX`. A larger declared `len` is corruption. |
| `MAX_BLOB_BYTES` | 64 MiB | Larger bodies are refused at write (`itemTooLarge`); in migration, quarantine `item_too_large`. |
| `CHECKPOINT_EVERY` | 1 MiB | §6.1 |
| `DURABILITY_WINDOW_BYTES` | 4 MiB | RL §6.2; the most one write batch holds. |
| `REVERSE_SCAN_MAX` | 9 MiB = `CHECKPOINT_EVERY + 2·DURABILITY_WINDOW_BYTES` | §6.3 |
| `ROTATE_AT` | 64 MiB | §1 |

Every field outside a record's one body slot has a bounded type (`src/schema/bounded.rs`),
checked when the payload is parsed, so the bound follows from the types:

| Type | Bound | Used for |
|---|---|---|
| `Id` = `Text<256>` | 256 UTF-8 bytes | session, item, run, approval, queue, compaction, segment and client ids |
| `Name` = `Text<128>` | 128 bytes | `role`, op `method`, attribution fields |
| `Text<64>`, `Text<24>`, `Text<264>` | bytes | op id, `log_id` / bare SHA-256, `origin.item_key` (`session/<id>`) |
| `Digest` | `sha256:` + 64 lowercase hex | `refs[]` (≤ `MAX_REFS` = 128), op `digest`, `source_digest` |
| `Json<16384>` | 16 KiB encoded | `op.result` |
| `BodyBlob` | protocol `BlobDescriptor` with a `Digest` and `mediaType` `application/json` | the blob form of every slot |
| integers, enums, `archive.at` (a JSON number) | ≤ 24 bytes | the rest |

A `Text<N>` encodes to at most `6N + 2` bytes (every byte a `\u00XX` escape). The test
`every_record_kind_fits_a_frame_at_its_type_bounds` encodes every kind at these bounds
with an inline body of `INLINE_MAX` (an item's `prompt` then a blob reference) and checks
it against `MAX_FRAME_PAYLOAD`. Migration
journal entries use `ItemKey` = `Text<4096>` and fit as well.

### 3.4 Torn tail and corruption handling

- A torn tail is truncated by the first open-for-append, under the writer claim:
  `ftruncate(p)` then `sync_file`. Its bytes were never acknowledged; nothing is kept.
- Corruption is never skipped. The session opens read-only with status
  `damaged{file_no, offset, ordinal}` (catalog `sessions.damage`, JSON as in §8.2); rows before it stay
  pageable; writes answer `storeDamaged`. A positioned read that fails the CRC check in an
  older file marks the session damaged the same way.
- The only repair is the user-confirmed `session.repair{confirm}`: move the bytes from the
  damage point to the end of that file, and every newer log file, to
  `quarantine/session_damage/<escaped "damage/<id>/<file_no>/<offset>">/`, truncate at the
  damage point, `sync_file`, then append `meta{set:{repairedAt, repairCutOrdinal}}`.

### 3.5 Reverse scan

Used by open (§6.3). From the end of the newest file: skip the trailing `0x00` run and the
final line if it has no LF; then walk LF-delimited lines backwards. By F1 every committed
frame is one line. The scan stops at the newest line that is a frame on its own — its
first 44 bytes pass rule 3, `len` equals the line length minus 45, the payload passes the
CRC — and whose payload starts with `{"k":"checkpoint",` or `{"k":"session",` (the writer
puts `k` first). Lines that fail (torn or damaged bytes of the newest batch) are passed
over; the forward scan classifies them. The found frame is the frame start for a forward
scan (§3.2) to the end of the file with `expected` = its ordinal.

## 4. Blobs

### 4.1 Store

`<D>/prompt-attachments/sha256/<first 2 hex>/<64 hex>`, named by the SHA-256 of the bytes
(the 1.4.5 path; 1.4.5 attachments are already blobs). Reads verify the SHA-256; a
mismatch answers `blobCorrupt{digest}` for that body only.

### 4.2 Body slots and the reference shape

Each record kind has exactly one body slot (★); an `item` also has its `prompt` slot
(below). A slot is written as
`{"inline": <value>}` when the encoding of `<value>` is ≤ `INLINE_MAX` bytes, else
as `{"blob": {"digest": "sha256:<hex>", "bytes": n, "mediaType": "application/json"}}`
whose blob bytes are that encoding. The inner object is `mixdog_protocol::BlobDescriptor`,
the one blob reference shape of SPEC R2 (also used on the wire), parsed as `BodyBlob`
(well-formed digest, `mediaType` `application/json`, unknown fields rejected);
`INLINE_MAX` and `MAX_BLOB_BYTES` are also `mixdog-protocol`'s (`inlineMax`,
`maxBlobBytes` in `mixdog-app-protocol/schema/constants.json`). Size alone decides; there
is no other rule.

An `item` has a second slot, `prompt` (its value a JSON string), under the same rule with
the inline bytes its `body` leaves: `body` is decided first against `INLINE_MAX`; `prompt`
is inline when its encoding is ≤ `INLINE_MAX` minus the encoding of the inline `body`
value (0 when `body` is a blob), else a blob of its own of that encoding. The inline
values of one frame thus never exceed `INLINE_MAX` together, and `MAX_FRAME_PAYLOAD` holds.
The writer's codec (`encode::encode_record`, `encode::slot_within`) and migration apply
the same rule.

### 4.3 References

`refs` (item, amend) lists, sorted and unique, every `sha256:` digest the record
references: each content part's `attachmentRef` (bare 64 hex in 1.4.5 message bodies,
kept verbatim in the body) and the record's own slot blobs (an item's `body` and
`prompt`, an amend's `body`). The index projects them into
`blob_refs` in the same transaction as the record's history row. GC deletes a blob only
under SM §9's four conditions.

### 4.4 Publication order

`publish_file(blob)` (synced, renamed, parent synced) precedes the `append_barrier` of
the first record that references it. A record therefore never references a missing blob;
a blob without a reference is garbage, never corruption.

## 5. Records

### 5.1 Payload encoding and parsing

- The writer encodes a record with `serde_json` (compact): UTF-8, no whitespace; strings
  escape `"`, `\` and U+0000–U+001F; key `"k"` first (records and journal entries), then
  the fields in the order of the Rust declaration in `src/schema/`; absent options
  omitted; opaque objects (`header`, bodies, details) in `serde_json` map order (keys
  sorted). The vectors fix this output byte for byte, which is a writer property only.
- The reader parses with the same types. It rejects unknown kinds, unknown fields
  (`deny_unknown_fields`, also inside `BodyBlob`), missing fields and out-of-bound values
  (§3.3). It does not check the encoding: the CRC already proves the bytes are the
  writer's, so a re-encode comparison would only double the parse cost.
- Strings are Unicode scalar values. New writers never produce a lone UTF-16 surrogate:
  every truncation in the Rust core cuts at a `char` boundary. 1.4.5 data can hold them
  (1.4.5 `src/runtime/agent/orchestrator/session/agent-room.mjs:779` truncates by UTF-16 code unit and persists the result);
  migration replaces each by U+FFFD (§10.9).

### 5.2 Kinds (`src/schema/record.rs`)

| `k` | Fields (★ = body slot) | Meaning |
|---|---|---|
| `session` | `v:2, id, log_id, base?{session, log_id, end_ordinal_exclusive}, origin?{migration{manifest_sha256, item_key, source_digest}}, op?`, ★`header` | First frame of `log.000000`. `header` = every header key (the 1.4.5 record minus `messages`). `log_id` = 24 lowercase hex. |
| `meta` | `op?`, ★`change{set, unset[]}` | Header change: remove `unset`, then merge `set`. Title, close/tombstone, generation, worker map, desktop metadata, `deleted`, repair marks, … |
| `item` | `iid, turn?, role?, form:"message"\|"display", model, visible, archive?{seq, at?, origin}, op?, ★`prompt?`, refs[]`, ★`body` | One history row. `turn` = the run id; a run's input rows are its rows before its `run{started}`. `display` rows are imported 1.4.5 archive items, always `model:false`. `prompt` is present exactly when the row counts for prompt history (a 1.4.5 `kind:"user"` transcript row, own room lines included; never notices, tool cards, skill or hook rows) and holds that row's display text (paste/file chips, image lines and feedback rewrites applied); written by the session at commit and by migration, never derived from `body` by the store; a slot sharing `INLINE_MAX` with `body` (§4.2), with no length bound of its own (1.4.5 caps neither prompt history nor display text). `archive.at` = the source number (absent for a missing or `null` source value); `archive.origin` = `segment{id, prev?, count, bytes}` or `pending{divider, cleared_through?, max_bytes?}`. |
| `amend` | `iid, op?, refs[]`, ★`body` | Replaces the body of row `iid` (redaction, offload pruning, reactions). |
| `rewind` | `to_ordinal, reason:"rewind"\|"edit"\|"clear", op?` | Supersedes records with ordinal in `[to_ordinal, this)`; `history_rev += 1`. In a fork, `to_ordinal` may lie below `base.end_ordinal_exclusive` (§5.3 lineage cut). |
| `compacted` | `cid, summary_iid?, op?, at?, dropped_count?, dropped?{messageIds[], callIds[]}`, ★`replacement[{iid, body}]` | Model context restarts at `replacement`; history rows stay. `at` (ms since the Unix epoch, the compaction's `Date.now()`) is the only field the "Conversation compacted" divider shows besides its constant label. `dropped_count` and `dropped` are the compaction event's `droppedMessages` and `droppedIdentities` (null → absent); the writer always sets `dropped_count` (0 when the pass took out nothing visible) and `dropped` when it has identities. 1.4.5 `compactionArchivedRows` decides from them (`compaction_view.rs`): `dropped` present → by id (a text row by `iid`, a tool card by call id; this includes a kept message that lost its text or some calls), whatever the count says; else `dropped_count` 0 → no row; else (positive, or absent as in imported 1.4.5 history) → every row before the divider. |
| `run` | `rid, phase:"started"\|"attempt"\|"completed"\|"failed"\|"interrupted", attribution?{provider, model, account?, route, preset?, effort?}, attempt?{n, delivery:"notSent"\|"ambiguous"\|"accepted"}, at?, op?`, ★`detail?` | Turn lifecycle; `attempt` records one provider attempt's delivery state (SPEC §4.9). `started` only after its input rows are durable; on open a `started` without terminal phase gets `interrupted`. |
| `approval` | `aid, rid, phase:"requested"\|"decided"\|"expired", by_client?, at, op?`, ★`body?` | `body` = the request (`requested`) or the decision (`decided`). |
| `queue` | `qid, action:"enqueue"\|"update"\|"dequeue", reason?:"delivered"\|"cancelled", op?`, ★`entry?` | `entry` (enqueue; `update` replaces a queued entry in place and keeps its position) = the 1.4.5 pending-entry shape minus `id`: `{message, notificationKind?, mode?, executionId?, execution?, enqueuedAt?}`. |
| `op` | `op{id, method, digest, result?}, state:"applied"\|"rejected"\|"fenced"\|"externalPending"\|"externalUnknown", at`, ★`detail?` | A thread-scope op outcome with no mutation record of its own (P §9.2–§9.6). |
| `checkpoint` | ★`state` | §6. |
| `model_switch` | `anchor{iid, ordinal}, op?, ★entry{provider, modelId, at}` | A display-only model-switch boundary: `entry` is the 1.4.5 `meta.modelSwitches` entry (`set-route.mjs` `switchSessionInPlace`: `{provider, modelId: route.model, at: Date.now()}`) that 1.4.5 appends to the anchor message's `meta`; here it is appended to the log instead and the stored anchor is never rewritten. `provider` and `modelId` are unbounded strings, as in 1.4.5 (a preset's model id skips the 160-character raw-id check, `config-helpers.mjs` `validateRequestedModelSelector`), so `entry` is the record's ★ slot. `anchor` = the message 1.4.5 `modelSwitchAnchorIndex` picks, in the session's lineage view, `ordinal` below this record's own: an `item` row (`ordinal`, `iid` = the row's), or, when that message is a replacement entry of a `compacted` frame with no history row (the summary, the context ack), that entry (`ordinal` = the `compacted` frame's, `iid` = the entry's; the writer finds it with `compaction_entry`, which gives the frame's ordinal and `cid`: the newest live `compacted` frame of the lineage whose replacement holds the entry, a `message_rows` seek per lineage level). A message with a history row is anchored on the row. Not part of the model context, the fold or the catalog. |

`op{id, method, digest, result?}` on a mutation record is that op's record (P §9.2: effect
and op record are one durable write). `digest` = `sha256:` of the params without `opId`
as P §9.2 defines it; `result` only when its encoding is ≤ 16 KiB. Timestamps (`at`) are
integer milliseconds since the Unix epoch; imported source times stay in the opaque
values that carry them (`archive.at` keeps the source value).

### 5.3 Fold

SM §5.2, with: inputs of run `r` = `item`s with `turn == r` before `run{r, started}`;
`amend` applies by `iid` unless superseded; a `rewind` before the newest `compacted`
makes the context start at the newest non-superseded `compacted` before it (from the
index `compactions` table, itself a projection of the frames). The fold is a pure
function of the frames.

A `model_switch` belongs to its anchor row, as the 1.4.5 entry belongs to the anchor
message's `meta`: it is shown exactly while that row is live in the reader's view, and
no rewind marks it. A rewind that keeps the anchor keeps it even when the rewind covers
the record's own ordinal (1.4.5 anchors before a trailing unanswered prompt so that a
retry's rewind keeps the boundary); a rewind that removes the anchor removes it. A
reader's records are the session's own log and each base level's records before its
fork point (`end_ordinal_exclusive`, not `base_cut`: a fork copied the anchor with its
boundaries). Shown after the anchor's own items, oldest level first, then in record
order (1.4.5 `restoreTranscriptRange` pushes `meta.modelSwitches` in array order after the
message's items, its failed-turn rows and its `sessionInheritances`). A record whose
anchor ordinal is not below its own fails the fold (`AnchorNotBefore`); one whose `iid`
does not match the row at that ordinal is never shown.

A boundary anchored on a replacement entry belongs to that compaction's divider (§8.2
`dividers`), as 1.4.5 shows the summary message's `meta.modelSwitches` where the summary
stands: it is shown right after the divider while the compaction is live in the reader's
view (a rewind before the `compacted` frame removes divider and boundaries), ordered by
the entry's position in the replacement, then oldest level first, then record order (1.4.5
walks `session.messages` in order). One whose `iid` names no entry of that frame is never
shown.

Lineage cut: a fork's `rewind` with `to_ordinal` below `base.end_ordinal_exclusive`
supersedes every record of the fork's own log and sets `base_cut = min(base_cut,
to_ordinal)`. The fork's history is then its own live rows followed by the lineage rows
(the base and, transitively, its bases) with ordinal < `base_cut`; the base logs are not
written. A base row's liveness for the fork is decided at the fork point as before
(`superseded_rev` ≥ the level's `end_ordinal_exclusive` counts as live).

### 5.4 Identity

Session ids are preserved by migration. Item ids follow SM §11.3 (`meta.transcript.messageId`,
the 1.4.5 stamping rule, `pos:<session>:<ordinal>` for string-marker rows,
`arc:<seq>:<index>` or the display item's own `id`). A migrated `log_id` =
`hex(sha256(manifest_sha256 ‖ session id))[0..24]`; a new one is 24 random hex. Content is
never compared for identity.

## 6. Checkpoints, rotation, bounded open

### 6.1 Placement (writer obligation)

- A `checkpoint` frame is always the **first frame of its write batch**. The writer
  places one at the start of the next batch once the bytes written since the previous
  `checkpoint` (or `session`) frame reach `CHECKPOINT_EVERY`, at clean close, and as the
  first frame of every rotated file (that file is published whole).
- Batches of one session are strictly sequential: batch *n+1* is written only after batch
  *n*'s barrier succeeded (one durability job in flight per session, RL §6.1). A batch
  holds at most `DURABILITY_WINDOW_BYTES` (≥ `MAX_FRAME_LEN`).
- A batch whose barrier failed is truncated away before any later append (SM §8
  `RollingBack`/`PendingRollback`), so at any time at most one unsynced batch exists, at
  the end of the newest file.
- Consequence: everything before a persisted `checkpoint` was synced before the
  checkpoint was written.
- Migration writes logs with the same file rules (rotation at `ROTATE_AT`, each later
  file starting with a `checkpoint`) and ends every log with a `checkpoint`.

### 6.2 State (`src/schema/checkpoint.rs`)

`{log_id, covers_ordinal, history_rev, rows, visible_rows, base?, base_cut?, context?: FramePos,
runs[{rid, started}], approvals[{aid, rid, requested}], queue[{qid, enqueued, updated?}], header}`
with `FramePos = {ordinal, file_no, offset}`. `covers_ordinal` is the checkpoint frame's
own ordinal; the state folds exactly the frames before it. `context` is the newest
non-superseded `compacted` frame (the model-context start).

It holds no history-dependent list: older compactions are rows of the index
`compactions` table, log files are the directory listing (each file's first ordinal is
its first frame's), rows are the `history` table. Its size is bounded by the header and
the open sets (open runs, pending approvals, queued entries), never by history length, so
writing a checkpoint costs the same at the first and the ten-thousandth compaction. It
goes out of line by the §4.2 rule like any body.

### 6.3 Open

1. List `sessions/<id>/` (≤ `ceil(size / ROTATE_AT)` log names plus tmp names).
2. Reverse scan (§3.5) the newest file to the newest committed `checkpoint`/`session`.
   The bytes from its start to the end of file are fewer than `REVERSE_SCAN_MAX` = 9 MiB
   (proof below).
3. Load the state (one blob read if out of line); check `covers_ordinal` = the frame's
   ordinal and `log_id`.
4. Forward scan (§3.2) from that frame to EOF; record a torn tail.

**Bound.** Let `C` be the newest committed `checkpoint`/`session` frame of the newest
file (one exists: `log.000000` starts with `session`, every later file with a
`checkpoint` published whole). `C` is the first frame of its batch `B0` (§6.1). Let
`B1 … Bm` be the later batches whose barrier succeeded and `B*` the one unsynced batch,
if any (§6.1: at most one, last in the file). By A1 the file ends where the writer's last
append ended, so `EOF = end(B*)` or `end(Bm)`.
- No `Bi` (1 ≤ i ≤ m) starts with a checkpoint: it would be committed (synced, A1) and
  newer than `C`. So each `Bi` started with fewer than `CHECKPOINT_EVERY` bytes since
  `start(C)` (§6.1), giving `start(Bm) − start(C) < CHECKPOINT_EVERY` and
  `end(Bm) − start(C) < CHECKPOINT_EVERY + DURABILITY_WINDOW_BYTES`. With `m = 0` the same
  holds, as `|B0| ≤ DURABILITY_WINDOW_BYTES`. If `C` itself lies in the unsynced batch
  (fully written, not yet synced), then `B0 = B*` and `EOF − start(C) ≤
  DURABILITY_WINDOW_BYTES`.
- `|B*| ≤ DURABILITY_WINDOW_BYTES`, whether its bytes read back as written, partly or
  wholly as zeros (a failed barrier whose size reached the disk), or as a checkpoint that
  is not committed.
- Hence `EOF − start(C) < CHECKPOINT_EVERY + 2·DURABILITY_WINDOW_BYTES`. The zeros of
  `B*` are part of this bound; nothing else can extend the file.

A clean close ends the file with a checkpoint, so the common open reads one frame. Open
cost is independent of history length. History rows, pages and the model context come
from the projection (§8.2) by ordinal with positioned reads.

### 6.4 Model context

The model context of a thread is what 1.4.5 replays from its last `compacted` record for
the next turn (`session-log-reader.mjs`): the newest live `compacted` replacement, then
every later `model:true` message `item` in ordinal order, each with the body of its live
`amend`. Hidden model rows (`visible:false`) are part of it; `display` rows never are.
Across a fork lineage (`lineage[0]` the thread, then its bases with the fork point `end`;
`cut` = the thread's `base_cut`): the thread's own live rows from its newest live
compaction; without one, first each base's rows below `min(end, cut)` as they were at that
point (versions with `ver` below it, not superseded before it), from the base's newest
compaction live at that point, down the lineage until a level has one.

The read is index-backed (`message_rows`, whose versions locate the frame holding their
body) and paged in context order, oldest first: one page is at most the requested rows and
`PAGE_MAX_BYTES` of frames (at least one row). Its steps are lane jobs: the page's rows and
frames (interactive I/O), the records parsed (interactive CPU), out-of-line bodies read
(interactive I/O, only when present), those bodies parsed (interactive CPU). A page cursor
is bound to the thread's `history_rev` and context start; after a rewind or a new
compaction it is stale and the read restarts. Golden: `mixdog-migrate`
`tests/model_context_corpus.rs` against Node's reader over the migration corpus
(`tests/vectors/generate_context.mjs` there).

## 7. Crash consistency

Assumption A1 (filesystem): after a crash, synced bytes are intact; past them the file
reads back as a prefix of the bytes appended after the last sync, followed by `0x00`
bytes or end of file — never stale data, never written bytes after a zero hole.

1. **No acknowledged loss.** An acknowledged frame was synced with every frame before it
   (§6.1 sequential batches), so each is intact, header-valid, in sequence, CRC-valid and
   terminated: the forward scan commits all of them, and any torn offset lies after the
   last acknowledged frame. Truncating a torn tail removes only unacknowledged bytes, and
   never a complete frame (§3.2).
2. **A crash is recovered automatically.** A crash during a batch leaves, after the last
   synced frame, a prefix of the batch's bytes and then zeros or end of file. Every
   complete frame of that prefix is committed; the first incomplete one ends in the zero
   run or at EOF, so it is torn by rule 2, 4, 5 or 7 — never corrupt, since its header,
   if present, is the writer's and its payload, if present, is the writer's.
3. **Damage is never silent.** A header failing its checksum, a wrong ordinal, an
   impossible length, a present payload failing its CRC, or a wrong terminator stops the
   scan as corruption; nothing after it is adopted. The reverse scan cannot hide damage of
   the newest batch: a checkpoint is the first frame of its batch (§6.1), so every
   un-synced byte lies after the checkpoint the reverse scan starts from.
4. Bytes that violate A1 (stale data, a zero hole followed by written bytes) classify as
   corruption wherever a complete frame is affected: no silent loss, the user decides
   (§3.4). A1 decides only whether recovery is automatic, never safety.
5. Barrier failure, rollback and `PendingRollback` are SM §8 with SPEC R26 (the
   `DurabilityTask` owns the state machine; `Ownership::revalidate()` precedes the sync).

## 8. SQLite databases

### 8.1 Common

Every database is opened through `SqliteStore` (one writer thread, a read pool, a
maintenance reader; SPEC R31) with `journal_mode=WAL`, `synchronous=FULL`,
`wal_autocheckpoint=0`, `busy_timeout=0`. Maintenance job cursors are rows
`meta`/`metadata` key `job:<id>`, written in the step's own transaction. The DDL scripts
run once on an empty file, outside a transaction (they set `auto_vacuum`).

### 8.2 `index/store.sqlite` (`src/schema/sql/index.sql`)

`application_id` `0x4D584958` ('MXIX'), `user_version` 7. Every change to the DDL bumps
`user_version` (2: the frame location of each `message_rows` version; 3: `history.facets`,
`compactions.drop_mode` and `compaction_dropped`; 4: `sessions.title`; 5: the worker index;
6: `agent_tag` over the agent registry's sessions, in its walk order; 7: `model_switches`).

Derived. `SqliteStore::open` (one maintenance-lane job, the only way to open the index)
rebuilds it from the logs when the file is missing, is not a readable SQLite database, or
has another `application_id`/`user_version`; such a file is never opened or altered in
place, and callers never see the rebuild as an error. The rebuild:

- projects every directory of `sessions/` holding `log.000000`, each log read forward once
  and written in the writer's bounded transactions, into a staged file beside the index;
  then removes the old file's `-wal`/`-shm`/`-journal` and publishes the staged file by a
  durable rename. A crash before the rename leaves a file that fails its open again, so the
  next open rebuilds again; a stale staged file is swept first.
- costs one sequential read of every log byte plus the index writes: linear in the data
  dir, no index-backed bound. The open returns only when the rebuild is done; it reports
  no progress, and nothing is served from the old file meanwhile.
- never fails on a session's own log. A log that cannot be read to its end is a damaged
  session through the one damage state of §3.4 (`sessions.status = 'damaged'`, and
  `sessions.damage` = JSON `{path, error}` plus `file_no, offset, ordinal` when the reader
  names the bad frame), as 1.4.5 treats a log it cannot read (`session-log-reader.mjs`
  `parseSessionLog`, `store/listing.mjs` `listStoredSessions`, `load-session.mjs`
  `resolveSessionCopy`):
  - with a readable `session` frame, the frames before the failure are projected and the
    session is listed, read-only, as on the live path;
  - without one, the row has no header and an empty `log_id`: never listed, searched or
    summarized (1.4.5 leaves the file out of the list and loads it as no session), and
    only its damage is kept.

  Only an index write error fails the rebuild (`DbError::Write`); it never yields a
  partial index.

| Table | Rows | Notes |
|---|---|---|
| `sessions` | one per session | `sid` (stable integer key of the search index; rows are upserted with `ON CONFLICT(id) DO UPDATE`, never `OR REPLACE`), `id`. Projection state `log_id, newest_file_no, projected_file_no, projected_offset, projected_ordinal` (next to project), `history_rev, row_count, visible_count`; RL §9.2 `dirty` mark (committed before the first append of an activation, cleared on retire; boot reconciles `WHERE dirty=1` only); `status` ok/damaged/indeterminate with `damage` JSON; `deleted` (the header's delete mark `deleted: true`, written by a `meta` record, so a rebuild keeps it; once set it stays set: `summary`, `title` and the listings skip the row, `SqliteStore::deleted` reads it, and the core's open answers `threadNotFound`), `base_session`; list columns `activity, created_at, updated_at, closed, archived_at, cwd, visibility, owner_session_id, parent_session_id, agent, source_type`; search columns `classification, archived, title_kind, id_key` and the seven folds `title_fold, preview_fold, cwd_fold, project_fold, id_fold, model_fold, source_fold`; `summary` = the JSON list row (its `title` the cleaned one); `title` = the header's raw `title`, the metadata read's 1.4.5 `readStoredSessionMetadata` `session.title || null` (`SqliteStore::title`; NULL when absent, empty or not a string); the worker index: `worker` = the header's `worker` map (the 1.4.5 worker row of `agent-workers.json`, with its reap tombstone and closed-by-owner marker) as JSON, and its keys normalized as 1.4.5 `agent-tool` reads a row (`worker.rs` `WorkerKeys`): `worker_tag` = `clean(tag)` ('' for none), `worker_owner` = `clean(parentSessionId \|\| ownerSessionId)` (NULL when empty), `worker_host_pid` = `positiveInt(clientHostPid)`; all NULL without a map object and for a Lead pool row (`agent` "lead", which 1.4.5 `normalizeWorkerRows` hides); `agent_tag` = the session's own `clean(agentTag)` and `agent_owner` = its parent link `clean(parentSessionId \|\| ownerSessionId)` (`TagKeys`: 1.4.5 `lastTagSession` walks the agent registry, `agent-tree.mjs` `listSessions`, whose stored sessions are the rehydration candidates of `agent-rehydrate.mjs`), set only for a session in that registry (visibility `agent-only` or `owner` "agent", parent link a session id other than its own) with a tag and not Lead pool (`agent \|\| sourceName` "lead"). `newest_tag_session` keeps 1.4.5's first-of-greatest-`createdAt`: `ORDER BY created_at DESC` (a missing `createdAt` counts 0, NULL here, last), then the registry walk order, which a boot fills from the stored listing by newest `updatedAt` (`summary-cache.mjs`), so `updated_at DESC`, then `id` for the listing's own ties (a directory scan order in 1.4.5). Written only by the catalog upsert, in the transaction of the header write it follows (create, `meta`, rebuild); a deleted or damage-only session is never returned. Lookups (`SqliteStore::worker_rows(tag?, scope)` with scope owner / host pid / all as 1.4.5 `sessionMatchesContext`, `newest_tag_session(tag, owner)` as `lastTagSession` over `agent_tag`, `agent_only_sessions()` for agent rehydration) are each a seek on `sessions_worker_tag`, `sessions_worker_owner`, `sessions_worker_pid`, `sessions_workers`, `sessions_agent_tag` or `sessions_visibility_recent`, newest `created_at` first, then id. |
| `session_search` | FTS5 over the seven folds | external content (`sessions`, rowid `sid`), `tokenize='trigram case_sensitive 1'`, kept in step by three triggers on `sessions` (insert, delete, `UPDATE OF` the seven folds). |
| `compactions` | one per `compacted` frame | `cid`, location, `boundary` (where the divider sits among this session's own rows: the oldest own row the replacement kept, else the compaction's ordinal; a read moves it to the oldest kept row of a base level when the replacement keeps rows the fork inherited, `SqliteStore::dividers`, `Divider.level`), `at` (the record's optional `at`), `drop_mode` (0 every row before `boundary`, 1 none, 2 by id: from `dropped_count`/`dropped`), `superseded_rev`; partial index on live rows. |
| `compaction_dropped` | one per id of a `drop_mode` 2 compaction | `(session, kind 0 message / 1 call, id, ordinal)`; live exactly while its `compactions` row is. A page marks a history row archived when some compaction of the reader's lineage after it (a fork's compactions apply to the rows it inherits) takes out every part of it: the classifier is `compaction_view::ArchivedRows` over the row's `facets`. |
| `history` | one per `item` frame | `iid, turn, form (0 message, 1 display), model, visible`, item frame location `file_no, frame_offset, frame_len`, `amend_ordinal` of the live amend, `superseded_rev`, `facets` (JSON `{role, text, calls[]}` of a model message: its text row and tool cards). |
| `amends` | one per `amend` frame | `target_ordinal`, location, `superseded_rev`. |
| `model_switches` | one per `model_switch` frame | `anchor_ordinal, anchor_iid`, the entry `provider, model_id, at`; no `superseded_rev` (§5.3: it lives while its anchor does). A history page returns each row's boundaries (`HistoryRow.model_switches`), one seek on `model_switches_anchor` per lineage level at or after the row's; `dividers` returns each divider's (`Divider.model_switches`), the same seek joined to the frame's `message_rows` entries by `iid`. |
| `turns` | one per run | `started_ordinal, end_ordinal, phase, superseded_rev`. |
| `approvals` | pending approvals | the cross-session enumerator. |
| `blob_refs` | `(digest, session, ordinal)` | §4.3. |
| `fork_edges` | `(base, child)` | a base with children keeps its files. A deleted session goes (`SqliteStore::purge_deleted`, run after a delete) once no edge names it as base: its first log file is unlinked (a rebuild indexes only folders holding it), then its folder, on the maintenance lane; then its index rows in maintenance steps of at most `STEP_ROWS` deletions, its own edge and catalog row last and counted. Its base, if deleted too and without other children, goes next in the same call. A folder without `log.000000` is incomplete by construction (a create publishes it before anything else in the folder; a purge unlinks it first): the boot purge (run by `SqliteStore::open` before it returns the store, so before any thread opens or is created) removes every such folder and its id's index rows, then runs `purge_deleted`, so a crash mid-create or mid-purge, with or without a rebuild after it, leaves nothing unreachable. |
| `message_rows` | immutable versions of the model-context messages | `(session, ordinal, idx, ver, file_no, frame_offset, frame_len, iid, counted, real, incoming, place, preview, line, routine, live, superseded_rev)`: the catalog's message state (1.4.5 `_sessionMessageProjection`) and the model-context read (§6.4; `file_no, frame_offset, frame_len` locate the frame at `ver` holding the version's body; partial index `message_rows_live` holds the live versions). An `item` with `form:"message"`, `model:true` is row `(ordinal, 0)`, first version `ver` = its ordinal; each entry of a `compacted` replacement is `(compacted ordinal, position)`. An `amend` of `iid` (an item or a replacement entry — 1.4.5 edits `session.messages` in place and its summary re-reads it) adds a version (`ver` = the amend's ordinal) to the newest live row with that `iid` and moves `live` to it; `counted` and `place` stay the row's. A `rewind` sets `superseded_rev` (its ordinal) on the versions with `ver` in the removed range and hands each row back to its newest remaining version, so rewinding past an amend restores the earlier content. `counted` = role `user`/`assistant`; `real` = `isRealTurnMessage`; `incoming` = an incoming-kind message with a `line`; `preview` = first-prompt candidate; `line` = last-message line; `routine` = its provenance JSON; `place` = 1-based place among the epoch's counted rows when written. Partial indexes `message_rows_preview/_line/_incoming` hold the live versions, so first prompt, last line and incoming places are seeks (`INDEXED BY`, checked with `EXPLAIN`). |
| `message_epochs` | one per context epoch | `(session, start, count, real, superseded_rev)`: the root (`start` 0) or a `compacted` frame; the live epoch is the newest not superseded. `count`/`real` are this session's own rows, moved by deltas on append, amend and rewind (each O(1) per row; a rewind is bounded per transaction and resumable). |
| `message_views` | what a fork inherits | `(session, valid_from, base, position, state, count, real, preview, line, routine, incoming, cursor…)`: the base's state as of `position` (the fork point, or lower after a rewind of the child into the base range), snapshotted once and never changed by later base rewinds or amends; versioned by the frame that set it (`valid_from`); the view in force at a position is the newest with a lower `valid_from`, and rewinds never remove one. Taken at creation when the base's projection ends at `position`; otherwise `pending` while bounded maintenance steps (`STEP_ROWS` versions, a keyset cursor over `(ordinal, idx, ver)`) scan the base rows as of `position`. A view becomes `ready` only once the base's projected watermark has reached `position`, and the child's catalog row is held back until then. The live stats of a session are its live epoch plus, for the root epoch, its live view: no lineage is walked at any depth. |
| `thread_ops` | thread-scope ops | `op_id, method, payload_digest, state` and the location of the record carrying it (P §9.2 lookup). |
| `prompt_occurrences` | one per prompt row | `(session, ordinal, key, text, superseded_rev)` for every `item` with a `prompt` whose key is not empty: `text` = `prompt` trimmed (JS `trim`); `key` = 1.4.5 `promptHistoryKey` = `text.trim().replace(/\s+/g, ' ')` (vectors `src/schema/vectors/prompts.json`). Superseded by rewinds like `history`. |
| `prompt_history` | one per live prompt key | `(session, key, ordinal, text)`: the newest live occurrence of `key`. A rewind (and `clear`) supersedes the occurrences it covers and moves each affected key to its newest live occurrence, or removes it. `OpenedLog.prompts` = `SELECT text … WHERE session = ? ORDER BY ordinal DESC LIMIT 50` (`prompt_history_recent`). |
| `meta` | key/value | GC state `gc:*`; job cursors `job:<id>`, among them `job:refold_titles` (present while the placeholder-title refold is pending, value `0`); `ui:placeholder_labels` = JSON `[image, video, file]` labels of the UI language the title folds use (absent: English `Image`, `Video`, `File`). |

Every interactive query is index-backed with a `LIMIT`; the test runs `EXPLAIN QUERY
PLAN` on the catalog, page, model-context, previous-compaction, iid, blob-ref, fork, turn
and the three session-search queries and rejects any table scan (allowed: the dirty-row
and placeholder-title partial indexes and the trigram `MATCH`) and any sort except the
trigram query's sort of its matches.

**Session search** reproduces today's desktop search
(`apps/desktop/src/renderer/session-search.ts` `sessionSearchResults`):

- Rows: `classification` ∈ {`task`, `project`}, not deleted.
- Needle: the query trimmed (the JS `String.prototype.trim` set: White_Space plus
  U+FEFF) and folded. `fold(x)` = the Unicode default lowercase mapping of `x` (Rust
  `str::to_lowercase`, which also applies the final-sigma rule as JS does); no
  normalization. (`:61`)
- Match: the needle is a substring of the fold of at least one of seven fields, each
  separately: display title (`sessionDisplayTitle(session, '')`, i.e. `sessionSummaryTitle`
  with an `[Image]`/`[Video]`/`[File]` placeholder shown as its label in the UI
  language), `preview`, `cwd`, `projectPath`, `id`, `model`, `sourceName`; an absent field
  is the empty string. (`:66`)
- Order: live before archived, then `activity` (`activityAt`, else `updatedAt`) newest
  first, then `id` in `localeCompare` order, stored as `id_key` = `session_id_key(id)`
  (ICU root order for the id alphabet: primary `_` < `-` < digits < letters case-blind,
  then lowercase before uppercase; checked against Node `localeCompare`). (`:79`)
- Empty query: the live rows only, first 10.

The catalog writer stores the seven folds (`title_kind` marks placeholder titles; when
the UI language changes it refolds `WHERE title_kind IS NOT NULL`, served by
`sessions_title_kind`). Queries, `?2` = page size, keyset cursor on
`(archived, activity, id_key)` for later pages:

- Empty: `… WHERE deleted = 0 AND classification IN ('task','project') AND archived = 0
  ORDER BY archived, activity DESC, id_key LIMIT 10` → `SEARCH s USING INDEX
  sessions_search_order (deleted=? AND archived=?)`, no sort.
- Needle ≥ 3 characters: `SELECT s.summary FROM session_search f JOIN sessions s ON
  s.sid = f.rowid WHERE session_search MATCH ?1 AND s.deleted = 0 AND s.classification
  IN ('task','project') ORDER BY s.archived, s.activity DESC, s.id_key LIMIT ?2`, `?1` =
  the needle as one FTS5 phrase (`"` doubled) → `SCAN f VIRTUAL TABLE INDEX 0:M7`
  (trigram posting lists), `SEARCH s USING INTEGER PRIMARY KEY (rowid=?)`, `USE TEMP
  B-TREE FOR ORDER BY` over the matching rows only. A phrase never spans two columns, so
  it is exactly "substring of one field".
- Needle of 1–2 characters (no trigram exists): `… WHERE deleted = 0 AND classification
  IN ('task','project') AND (instr(title_fold, ?1) OR … OR instr(source_fold, ?1)) ORDER
  BY archived, activity DESC, id_key LIMIT ?2` → `SEARCH s USING INDEX
  sessions_search_order (deleted=?)`, a walk in result order that stops at the page
  size; worst case the searchable session count, never history.

**Write cost.** The preview changes every turn. The folds are columns of the catalog
row, so the search index is maintained only where that row is written: in the
asynchronous, batched catalog writer (RL §9.2), never on the turn's append or barrier
path. Turns of one session coalesced into one batch cost one row update. Per update
whose folds changed, the trigger tokenizes the old and the new seven fields: about
`2 × L` trigram postings, `L` = their total length in characters (preview ≤ 160,
1.4.5 `store-summary-last-message.mjs:13`; typically a few hundred characters in all),
plus FTS5's amortized segment merging inside the same transaction. An update that
leaves the folds unchanged (activity, dirty mark) does not fire the trigger.

### 8.3 `state/core.sqlite` (`src/schema/sql/state_v1.sql`)

`application_id` `0x4D585354` ('MXST'), `user_version` 1. User data (SPEC R30).

| Table | Rows |
|---|---|
| `projects(path, alias, hidden, hidden_rank, last_used_at)` | desktop project preferences; converted from `desktop-projects.json` `{version:2, aliases, hidden[]}` (`hidden_rank` keeps the array order) |
| `rooms(room_id, doc)` | group room documents, JSON text |
| `ops(scope, op_id, method, payload_digest, state, outcome, created_at, completed_at)` | op records of every non-thread scope, written in the same transaction as the domain change; `inProgress` at boot becomes `externalUnknown` (P §9.6) |
| `op_watermarks(scope, watermark)` | P §9.5 retention |
| `meta` | `job:*`, `migration:<item key>` (§10.4), `seq:<name>` = the next unreserved value (decimal) of a durable id counter; ids are reserved in blocks, start at 1, never repeat (`seq:approval`: approval ids, P §8.2) |

## 9. Usage ledger (`usage/ledger.sqlite`)

### 9.1 Shapes at `user_version` 2

Read from the corpus ledger (read-only) and from a fresh ledger made by the 1.4.5 tag's
own code:

| Shape | Objects | Source |
|---|---|---|
| `Tag145` | 13 tables, 7 indexes, view `events`, 16 triggers (`sql/ledger_v2_base.sql`) | written by 1.4.5 (tag 69fe41b05) |
| `Dev146` | `Tag145` + 5 tables + 16 triggers (`sql/ledger_v2_session_days.sql`) = 18 tables, 7 indexes, 1 view, 32 triggers | written by the 1.4.6-dev line (the corpus ledger) |

The 37 shared objects have byte-identical SQL in both. A shape is recognized by the exact
set of `(type, name, sql)` in `sqlite_master`; any other set blocks the migration
(`migration_blocked{ledger_schema}`). `application_id` stays 0.

### 9.2 Version 3

The dev line's `session_days_route` trigger rewrites `provider, model` of every
`usage_session_days` row of a route whenever that route's signature changes: one write
fans out to every session-day the route was ever used on (a probe changed 603 rows with
`SCAN`), inside the shared writer. v3 removes the copy instead of maintaining it:
`usage_session_days` holds `route` only, and readers take provider and model from
`usage_routes` through `route` (a primary-key lookup) when they read a sum.

v3 = the `Tag145` objects + `sql/ledger_v3.sql`. The 31 objects it adds:

- tables `usage_session_days` (`session, day, route`, the sums; no `provider`/`model`),
  `usage_session_days_state`, `usage_session_revisions`, `usage_key_revisions`,
  `usage_membership_revision`, `rollup_days(day TEXT PRIMARY KEY, fingerprint TEXT NOT
  NULL, value TEXT NOT NULL) WITHOUT ROWID`;
- triggers `session_days_duplicate`, `session_days_id`, `session_days_insert`,
  `session_days_delete`, `session_days_update` (sums by route id only),
  `key_revision_event_route`, `key_revision_daily_insert`, `key_revision_daily_delete`,
  `key_revision_daily_update`, `membership_usage_routes_update`,
  `membership_usage_routes_delete`, `membership_usage_sessions_update`,
  `membership_usage_sessions_delete`, `membership_usage_session_owners_update`,
  `membership_usage_session_owners_delete`;
- seeds `usage_session_days_state = (1, NOT EXISTS(events), 0)`,
  `usage_membership_revision = (1, 0)`; `user_version = 3`.

Full v3 object list: 19 tables — `metadata`, `usage_routes`, `usage_sessions`,
`usage_events`, `usage_session_owners`, `daily`, `day_sessions`, `legacy_days`,
`quota_samples`, `day_revisions`, `usage_requests`, `usage_request_first_output`,
`usage_request_requested_provider` (`Tag145`) plus the six above; 7 indexes
(`usage_events_time`, `usage_events_time_usage`, `usage_events_session`,
`usage_session_owners_owner`, `usage_requests_status_time`, `usage_events_route_time`,
`usage_routes_model`); view `events`; 31 triggers (the 16 `day_rev_*` of `Tag145` + the
15 above). The test
`new_ledger_has_the_v3_object_set` pins the counts and both upgrade paths to the same
`sqlite_master`.

A route rewrite now costs three row writes (the route, `day_revisions['']`,
`usage_membership_revision`); the membership revision already invalidates every group
token, and reads see the new provider/model through the route id. The route-key term of
the group token becomes

```sql
SELECT COALESCE(SUM(k.rev),0) FROM usage_key_revisions k WHERE EXISTS (
  SELECT 1 FROM usage_session_days d JOIN usage_routes r ON r.id = d.route
  WHERE d.session IN (<members>) AND d.day = k.day
    AND json_extract(r.signature,'$[0]') = k.provider AND json_extract(r.signature,'$[1]') = k.model)
```

(plan: `SEARCH d USING PRIMARY KEY (session=? AND day=?)`, `SEARCH r USING INTEGER
PRIMARY KEY`); the session read already resolved provider/model through `usage_routes`.
The build step inserts the sums without `provider`/`model`.

Upgrade, in one `BEGIN IMMEDIATE` with `synchronous=FULL`:

- `Tag145` → `ledger_v3.sql`;
- `Dev146` → `ledger_v3_drop_dev.sql` (drops the 21 dev objects, leaving `Tag145`) +
  `ledger_v3.sql`. The dropped sums and revision counters are derived (counters only key
  in-memory caches, which a migration restart empties).

Both land on the same schema and the same state: sums unbuilt (`complete = 0` when events
exist, `next = 0`), built by the resumable maintenance step (`next` is its cursor). A new
ledger runs `ledger_v2_base.sql` + `ledger_v3.sql`. Triggers remain the only invalidation
mechanism; `rollup_days.fingerprint` is `"<global rev>:<day rev>"` from `day_revisions`.
Verification compares each `Tag145` table's row count and ordered-row SHA-256 and the SQL
text of every `Tag145` object before and after; the added objects equal these scripts.

## 10. One-time migration bookkeeping (`src/schema/migration.rs`)

### 10.1 Files

`migration/manifest.json` (`Manifest`), `migration/journal.000000` (frames, §2, payloads
`JournalRecord`), `migration/stage/<escaped key>/` (staged output; for a session its
`log.*` files), `migration/complete.json` (`Complete`). Every whole file goes through
`publish_file`; the journal is created by `publish_file` with its `plan` frame and then
appended with barriers.

*Escaped key*: every byte outside `[A-Za-z0-9._-]` becomes `%XX` (uppercase hex), so
`/` is `%2F`.

### 10.2 Items, kinds and contracts

Item keys: `session/<id>`, `store/<kind>`, `ledger`, `index`,
`retire/<root>/<path>`, `retain/<root>/<path>`, `desktopProfile/<kind>`. Each item has
`group` (`data` | `desktopProfile`), `kind` (closed set below), `contract`, its own
`sources`, and a `target`. Files read by several items are `shared` with their sorted
`consumers`; a shared file is disposed when all consumers are `disposed`.

| Kind(s) | Group | Contract | Target |
|---|---|---|---|
| `session` | data | convert | `session{id}`; consumes shared `session-pending/*`, `session-pending-messages.json`, `agent-workers.json`, `lead-workers.json`, `<P>/desktop-session-metadata.json` |
| `ledger` | data | convert (in place) | `ledger` |
| `index` | data | convert (build) | `index` |
| `attachmentBlobs`, `goals`, `quotaResume`, `humanGate`, `connectorAccounts`, `gatewaySessionRoutes`, `promptCacheTouches`, `promptCacheIdleGaps`, `heartbeat`, `routineResults`, `media`, `ledgerBackups`, `settings`, `coreMemory`, `projectsRegistry` (`<H>`), `agents`, `bots`, `workflows`, `schedules`, `hooks`, `skills`, `plugins`, `mcpConfig`, `projectConnectors`, `tuiPromptHistory`, `worktrees` | data | preserve (in place) | `file{root, path}` = source |
| `orphanCheckpoint` | data | retire | — |
| `ledgerLegacyInputs` | data | retire, or retain `ledger_import_incomplete` | — |
| `sessionMetadata` | desktopProfile | convert | `sessions` (per-session `meta`; unmatched entries retire, counted as `dangling`) |
| `desktopProjects`, `agentRooms` | desktopProfile | convert | `stateTable{projects \| rooms}` |
| `agentGreetings`, `notificationPreferences`, `retentionState`, `remoteActivated` | desktopProfile | convert | `configKey{agents.greeted \| notifications \| desktop.retentionState \| remote.activatedAt}` |
| `remoteAccessSettings`, `remoteClients`, `relayDevice`, `relayDeviceRevocations`, `relayE2ee`, `pairingToken`, `nativePush`, `pcAccessRevokes`, `selectedFileGrants`, `editorBackups`, `editorRecovery` | desktopProfile | preserve (move) | `file{data, remote/… \| desktop/…}` per SPEC §4.11 |
| `unclassifiedWorkspace` | desktopProfile | preserve (in place) | `configKey{desktop.unclassifiedWorkspaceRoot}` |
| `webPush` | desktopProfile | retire (or preserve its relay-path subset to `remote/push-subscriptions.json`, SPEC §4.11) | — |
| `retired` | both | retire | — |
| `setAside` | both | retain `carried_set_aside` | — |

`secret: true` sources (class C) are hashed only in the manifest, never logged, and moved
with owner-only access recreated. Credentials of SM §11.2, `pgdata/`, Electron- and
Chromium-owned profile files and every unknown file are never enumerated.

### 10.3 Manifest

`{format:1, roots{data, home, profile?}, items[], shared[]}`; items sorted by key,
sources and shared files by `(root, path)` (`data < home < profile`), consumers sorted.
Source paths are relative to their root, `/`-separated, without `.`/`..`.

### 10.4 Self-identification of published targets

| Target | Published iff |
|---|---|
| session dir | its `session` frame's `origin.migration{manifest_sha256, item_key}` match |
| file (move or rewrite, incl. `mixdog-config.json`) | its SHA-256 equals the item's journaled `staged.output_sha256` |
| `state/core.sqlite` rows | `meta` row `migration:<item key>` = `manifest_sha256`, written in the rows' transaction |
| ledger | `user_version` = 3 |
| index | every catalog row has `projected_offset` = log size and `row_count` = the fold count |

Items with the same target file are converted one at a time in key order, each journaled
`published` before the next stages. `store/settings` is `verified` before any
`configKey` item stages. Disposal re-hashes only sources it deletes or moves.

### 10.5 Journal and item states

`plan{manifest_sha256, items}` (ordinal 0) → per item `staged{key, output_sha256,
replaced_surrogates}` (§10.9),
`published{key}`, `verified{key, digest?}`, `quarantined{key, code}`, `disposed{key}`;
`phase{verified_all}` once every item is `verified` or `quarantined`. `output_sha256` of
a session = SHA-256 of its staged `log.*` files concatenated in file order.

```
planned → staged → published → verified → disposed
planned → verified                                  (retire)
planned | staged | published → quarantined → disposed
```

Every other transition is a journal violation (`ItemState::can_advance`). Preserve items
journal `staged`/`published` as no-ops. Crash recovery is SM §11.5's table.

### 10.6 Verification digest

`sha256:` of the `serde_json` encoding (§5.1) of SM §11.6's `ObservableState`, computed
independently on source and target; the source side applies the §10.9 replacement first. The corpus digests (`corpus-lib.cjs`) are compared
as well; that tool orders keys itself, so the comparison is on parsed values.

### 10.7 Completion

`complete.json = {format:1, manifest_sha256, journal_end_ordinal, kinds{data,
desktopProfile}}`, each a `Counts{verified, quarantined_expected,
quarantined_unexpected, retired, retained, dangling}`. A data dir with no profile has
`desktopProfile` all zero. The runtime checks only this file before `Serving`.

### 10.8 Quarantine

`quarantine/<code>/<escaped key>/` holds the moved files (base names) and
`reason.json = {format:1, key, code, expected, detail, sources[{root, path, sha256}]}`.
Codes: `carried_set_aside`, `ledger_import_incomplete` (expected), `parse_error`,
`schema_violation`, `id_mismatch`, `item_too_large`, `archive_parse_error`,
`digest_mismatch`, `session_damage` (runtime repair, §3.4). `expected` =
`QuarantineCode::expected()`.

### 10.9 Lone surrogates

1.4.5 text can hold lone UTF-16 surrogates (a `\ud800`–`\udfff` JSON escape without its
pair): `agent-room.mjs:779` truncates by UTF-16 code unit and the result is persisted.
The store holds Unicode scalar values only (§5.1). A convert item's reader replaces each
lone surrogate with U+FFFD, one for one, and counts the replacements; the count is
journaled as `staged.replaced_surrogates`. This is the one conversion of text and the
user cannot see it: the 1.4.5 UI already renders a lone surrogate as U+FFFD. Preserve
items keep their bytes (count 0). The verification digest (§10.6) applies the same
replacement to the source, so verification compares like with like.

## 11. Decisions that differ from SM / SPEC

1. Header is 44 bytes with its own checksum `hcrc` (SM §3.1 had 36 and no header check);
   a frame is `45 + len`; `crc` covers the payload only.
2. Torn vs corrupt (§3.2): a valid header (checksum and ordinal) is required before any
   byte counts as torn; a tail shorter than a header is torn only when every present byte
   agrees with the header written for the expected ordinal; a fully present payload is
   judged by its CRC alone. SM's "< 36 bytes without LF" and the grammar-based prefix rule
   are gone.
3. `MAX_FRAME_PAYLOAD` = `INLINE_MAX + 40 KiB` = 296 KiB, not 260 KiB (SPEC R2): the
   non-body fields at their type bounds need 34,324 bytes (`MAX_REFS` = 128 refs,
   `op.result` ≤ 16 KiB, ids ≤ 256 B). Every non-body field has a bounded type (§3.3);
   `meta.unset` moved into the body slot (`change{set, unset}`), `archive.at` is a number.
4. The body slot is `{"inline": v}` or `{"blob": ref}`; the reference shape is R2's.
5. Checkpoints are the first frame of a batch (§6.1); `REVERSE_SCAN_MAX` = 9 MiB =
   1 MiB + 2 × 4 MiB (one synced tail plus one failed or torn batch, which may read back as
   zeros). R27's "1 MiB + MAX_FRAME_PAYLOAD + 36" and the earlier "≤ 5.8 MB" do not hold.
6. `covers_ordinal`/`history_rev` live in the state (it self-identifies when out of line).
   The state keeps only the newest live `compacted` (`context`); older ones are index rows
   (`compactions`), log files are the directory listing, so the state does not grow with
   history. Runs, approvals and queue entries are frame positions, not bodies.
7. Record fields: `session.created_at` dropped (`header.createdAt` is the one copy);
   `compacted.window` dropped (undefined); `run.input_iids` replaced by `item.turn`;
   `queue.op` renamed `action` (`op` is the op reference on every mutation record); queue
   fields carried as the opaque `entry`; the approval decision is the body slot; added
   kind `op`, run phase `attempt` with `delivery`, rewind reason `clear`.
8. Ledger: the corpus ledger (18 tables, 32 triggers) is dev-written; the 1.4.5 tag writes
   13 tables and 16 triggers. v3 is the 1.4.5 set + the dev additions with the day sums
   keyed by route id only (no `provider`/`model` copy, no `session_days_route`) +
   `rollup_days`: 19 tables, 7 indexes, 1 view, 31 triggers. Both shapes upgrade to it
   (§9.2).
9. Quarantine folder is the code name (`session_damage`, not `session-damage`);
   `reason.json` lists `sources[{root, path, sha256}]` instead of `source_sha256[]`.
10. `complete.json` reports counts per group (`kinds`), without a duplicate total.
11. Opaque object keys are written sorted (value-lossless; source key order is not
    kept). Lone UTF-16 surrogates become U+FFFD in migration, counted (§10.9).
12. No canonical-encoding rule: readers reject unknown fields and out-of-bound values at
    parse time and never re-encode to compare (§5.1).
13. Session search: the desktop `session-search.ts` contract (seven fields, Unicode
    default lowercase without normalization, archived last, `localeCompare` id
    tie-break) over an FTS5 trigram index of writer-folded columns (§8.2).

## 12. Vectors

`src/schema/vectors/generate.py` (its own CRC-32C and encoder, expectations by
construction) writes `frames.json` (constants, single-frame encodings, the §3.2
classification table) and `records.json` (every record kind, every journal kind, a
manifest with both groups, `complete.json`, `reason.json`, as the writer encodes them).
`src/schema/tests.rs` checks: the constants and CRC check value, byte-identical frame
encoding, every classification vector against the reference scan (and every committed
payload as a `Record`), parse-and-encode of all record and migration files reproducing
the vectors, refusal of invalid payloads (unknown fields and kinds, out-of-bound values,
malformed digests, foreign body media types), every record kind at its type bounds
fitting `MAX_FRAME_PAYLOAD`, the item state machine, and the DDL (object sets, pragmas,
query plans, title search behaviour, both ledger upgrades producing exactly the
new-ledger schema, a route rewrite writing three rows). The store's frame reader must
pass the same `frames.json` table.
