//! The format vectors (`vectors/*.json`, written by `vectors/generate.py`, an independent
//! encoder) checked against the frozen types, constants and DDL. `scan` below is the
//! reference statement of the FORMAT.md §3.2 rules; the store's frame reader must give the
//! same result on every vector.

use std::collections::BTreeSet;
use std::ops::Range;

use mixdog_protocol::INLINE_MAX;
use rusqlite::Connection;
use serde::Deserialize;

use super::blob::MAX_REFS;
use super::bounded::*;
use super::frame::*;
use super::migration::Complete;
use super::migration::ItemState;
use super::migration::JournalRecord;
use super::migration::Manifest;
use super::migration::QuarantineCode;
use super::migration::QuarantineReason;
use super::record::Record;
use super::sql::*;

const FRAMES: &str = include_str!("vectors/frames.json");
const RECORDS: &str = include_str!("vectors/records.json");

#[derive(Deserialize)]
struct FramesDoc {
    constants: Constants,
    single: Vec<Single>,
    classification: Vec<Case>,
}

#[derive(Deserialize)]
struct Constants {
    header_len: usize,
    hcrc_covered: usize,
    frame_overhead: usize,
    inline_max: usize,
    max_frame_payload: usize,
    crc32c_check_input: String,
    crc32c_check: String,
}

#[derive(Deserialize)]
struct Single {
    ordinal: u64,
    payload: String,
    hex: String,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    rule: String,
    start_ordinal: u64,
    record_layer: bool,
    hex: String,
    expect: Expect,
}

#[derive(Deserialize)]
struct Expect {
    committed: usize,
    end: ScanEnd,
}

#[derive(Deserialize)]
struct RecordsDoc {
    records: Vec<Named>,
    journal: Vec<Named>,
    manifest: String,
    complete: String,
    reason: String,
}

#[derive(Deserialize)]
struct Named {
    name: String,
    payload: String,
}

fn frames_doc() -> FramesDoc {
    serde_json::from_str(FRAMES).expect("frames.json")
}

fn records_doc() -> RecordsDoc {
    serde_json::from_str(RECORDS).expect("records.json")
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn crc32c(data: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ CRC32C_POLY_REFLECTED
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn encode(ordinal: u64, payload: &[u8]) -> Vec<u8> {
    let covered = format!(
        "{ordinal:016x} {:08x} {:08x} ",
        payload.len(),
        crc32c(payload)
    );
    let mut out = format!("{covered}{:08x} ", crc32c(covered.as_bytes())).into_bytes();
    out.extend_from_slice(payload);
    out.push(TERMINATOR);
    out
}

fn is_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

/// FORMAT.md §3.2 rule 3: the present header bytes `h` (1..=`HEADER_LEN`), complete or
/// not, through one procedure. Each field gets its check on the bytes of it that are
/// present: a complete field the exact check, a cut-off field "is a prefix of a value the
/// writer can put there". `Ok(Some(len))` for a complete valid header, `Ok(None)` for a
/// prefix of a header the writer can produce for `expected` (rule 4, torn).
fn check_header(h: &[u8], expected: u64) -> Result<Option<usize>, CorruptCause> {
    let field = |at: usize, digits: usize| &h[at.min(h.len())..(at + digits).min(h.len())];
    let prefix_of = |present: &[u8], whole: &[u8]| whole.starts_with(present);
    // 1. hcrc and the final SP (any byte of them present implies bytes 0..35 are).
    let hcrc = format!("{:08x} ", crc32c(&h[..HCRC_COVERED.min(h.len())]));
    if !prefix_of(field(HCRC_AT, HCRC_DIGITS + 1), hcrc.as_bytes()) {
        return Err(CorruptCause::Header);
    }
    // 2. ordinal.
    if !prefix_of(
        field(ORDINAL_AT, ORDINAL_DIGITS),
        format!("{expected:016x}").as_bytes(),
    ) {
        return Err(CorruptCause::Ordinal);
    }
    // 3. separators 16, 25, 34 (43 belongs to step 1).
    if SEPARATORS[..3]
        .iter()
        .any(|&at| h.get(at).is_some_and(|&b| b != SEPARATOR))
    {
        return Err(CorruptCause::Header);
    }
    // 4. len: hex digits whose smallest completion (trailing `0`s) is in range.
    let len_digits = field(LEN_AT, LEN_DIGITS);
    if !len_digits.iter().all(|&b| is_hex(b)) {
        return Err(CorruptCause::Length);
    }
    let smallest = len_digits
        .iter()
        .chain(std::iter::repeat(&b'0'))
        .take(LEN_DIGITS)
        .fold(0usize, |value, &b| {
            value * 16 + (b as char).to_digit(16).expect("hex") as usize
        });
    if smallest > MAX_FRAME_PAYLOAD {
        return Err(CorruptCause::Length);
    }
    // 5. crc: hex digits (the value is checked against the payload in rule 6).
    if !field(CRC_AT, CRC_DIGITS).iter().all(|&b| is_hex(b)) {
        return Err(CorruptCause::Crc);
    }
    Ok((h.len() == HEADER_LEN).then_some(smallest))
}

/// Forward scan from a frame start at offset 0 (FORMAT.md §3.2, rules in order). Returns
/// the payload ranges of the committed frames and how the scan ended.
fn scan(buf: &[u8], start_ordinal: u64) -> (Vec<Range<usize>>, ScanEnd) {
    // The written end: past it the file holds only zeros (writer bytes never contain 0x00
    // in a header or terminator, so the last non-zero byte bounds what was written).
    let written = buf.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
    let mut committed = Vec::new();
    let mut p = 0;
    let mut expected = start_ordinal;
    loop {
        let torn = ScanEnd::Torn { offset: p as u64 };
        let corrupt = |cause| ScanEnd::Corrupt {
            offset: p as u64,
            ordinal: expected,
            cause,
        };
        // 1–2: end, zeros only.
        if p == buf.len() {
            return (committed, ScanEnd::Clean);
        }
        if written <= p {
            return (committed, torn);
        }
        // 3–4: one check of the present header bytes, complete or not.
        let h = &buf[p..written.min(p + HEADER_LEN)];
        let len = match check_header(h, expected) {
            Err(cause) => return (committed, corrupt(cause)),
            Ok(None) => return (committed, torn),
            Ok(Some(len)) => len,
        };
        // 5: payload not fully written.
        let payload_end = p + HEADER_LEN + len;
        if payload_end > written {
            return (committed, torn);
        }
        // 6: payload CRC.
        if &h[CRC_AT..CRC_AT + CRC_DIGITS]
            != format!("{:08x}", crc32c(&buf[p + HEADER_LEN..payload_end])).as_bytes()
        {
            return (committed, corrupt(CorruptCause::Crc));
        }
        // 7–8: terminator.
        if payload_end == written {
            return (committed, torn);
        }
        if buf[payload_end] != TERMINATOR {
            return (committed, corrupt(CorruptCause::Framing));
        }
        // 9: committed.
        committed.push(p + HEADER_LEN..payload_end);
        p = payload_end + 1;
        expected += 1;
    }
}

/// Parses `text` as `T` and checks the writer reproduces the vector bytes.
fn round_trip<T>(name: &str, text: &str) -> T
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let value: T = serde_json::from_str(text).unwrap_or_else(|e| panic!("{name}: {e}"));
    assert_eq!(
        serde_json::to_string(&value).expect("encode"),
        text,
        "{name}"
    );
    value
}

fn kind_of(payload: &str) -> String {
    let value: serde_json::Value = serde_json::from_str(payload).expect("json");
    value["k"].as_str().expect("k").to_string()
}

#[test]
fn constants_match_the_independent_generator() {
    let c = frames_doc().constants;
    assert_eq!(c.header_len, HEADER_LEN);
    assert_eq!(c.hcrc_covered, HCRC_COVERED);
    assert_eq!(c.frame_overhead, FRAME_OVERHEAD);
    assert_eq!(c.inline_max, INLINE_MAX);
    assert_eq!(c.max_frame_payload, MAX_FRAME_PAYLOAD);
    assert_eq!(c.crc32c_check, format!("{CRC32C_CHECK:08x}"));
    assert_eq!(crc32c(c.crc32c_check_input.as_bytes()), CRC32C_CHECK);
    assert_eq!(
        SEPARATORS,
        [
            ORDINAL_DIGITS,
            LEN_AT + LEN_DIGITS,
            CRC_AT + CRC_DIGITS,
            HCRC_AT + HCRC_DIGITS
        ]
    );
    assert_eq!(SEPARATORS.map(|at| at + 1)[..3], [LEN_AT, CRC_AT, HCRC_AT]);
    assert_eq!(
        (HCRC_COVERED, HCRC_AT + HCRC_DIGITS + 1),
        (HCRC_AT, HEADER_LEN)
    );
    assert_eq!(REVERSE_SCAN_MAX, 9 * 1024 * 1024);
}

/// Every prefix of a valid header is torn and the whole header is accepted, by the same
/// procedure: the short-tail and full-header paths cannot disagree.
#[test]
fn every_header_prefix_is_a_prefix() {
    let frame = encode(7, br#"{"k":"rewind","to_ordinal":1,"reason":"edit"}"#);
    for n in 1..HEADER_LEN {
        assert_eq!(check_header(&frame[..n], 7), Ok(None), "{n} bytes");
    }
    assert_eq!(
        check_header(&frame[..HEADER_LEN], 7),
        Ok(Some(frame.len() - FRAME_OVERHEAD))
    );
}

#[test]
fn single_frames_encode_identically() {
    for single in frames_doc().single {
        let bytes = encode(single.ordinal, single.payload.as_bytes());
        assert_eq!(bytes, unhex(&single.hex), "ordinal {}", single.ordinal);
        let (committed, end) = scan(&bytes, single.ordinal);
        assert_eq!((committed.len(), end), (1, ScanEnd::Clean));
    }
}

#[test]
fn classification_table_matches_every_vector() {
    let doc = frames_doc();
    let mut seen = BTreeSet::new();
    for case in &doc.classification {
        let bytes = unhex(&case.hex);
        let (committed, end) = scan(&bytes, case.start_ordinal);
        assert_eq!(
            (committed.len(), end),
            (case.expect.committed, case.expect.end),
            "{} (rule {})",
            case.name,
            case.rule
        );
        assert!(
            (1..=9).map(|n| n.to_string()).any(|n| n == case.rule),
            "{}",
            case.name
        );
        if case.record_layer {
            for range in committed {
                let payload = std::str::from_utf8(&bytes[range]).expect("utf-8 payload");
                round_trip::<Record>(&case.name, payload);
            }
        }
        seen.insert(match end {
            ScanEnd::Clean => "clean".to_string(),
            ScanEnd::Torn { .. } => "torn".to_string(),
            ScanEnd::Corrupt { cause, .. } => format!("{cause:?}"),
        });
    }
    let all: BTreeSet<String> = [
        "clean", "torn", "Header", "Length", "Framing", "Crc", "Ordinal",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(seen, all, "every scan outcome has a vector");
}

#[test]
fn every_record_kind_parses_and_encodes_to_its_vector() {
    let doc = records_doc();
    let mut kinds = BTreeSet::new();
    for named in &doc.records {
        round_trip::<Record>(&named.name, &named.payload);
        assert!(named.payload.starts_with("{\"k\":"), "{}", named.name);
        assert!(!named.payload.contains('\n'), "{}", named.name);
        kinds.insert(kind_of(&named.payload));
    }
    let expected: BTreeSet<String> = [
        "session",
        "meta",
        "item",
        "amend",
        "rewind",
        "compacted",
        "run",
        "approval",
        "queue",
        "op",
        "checkpoint",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(kinds, expected);
}

#[test]
fn migration_files_parse_and_encode_to_their_vectors() {
    let doc = records_doc();
    let mut kinds = BTreeSet::new();
    for named in &doc.journal {
        round_trip::<JournalRecord>(&named.name, &named.payload);
        kinds.insert(kind_of(&named.payload));
    }
    assert_eq!(kinds.len(), 7, "every journal kind has a vector");
    let manifest: Manifest = round_trip("manifest", &doc.manifest);
    assert!(
        manifest.items.windows(2).all(|w| w[0].key < w[1].key),
        "items sorted by key"
    );
    let complete: Complete = round_trip("complete", &doc.complete);
    assert_eq!(complete.kinds.desktop_profile.quarantined_unexpected, 0);
    let reason: QuarantineReason = round_trip("reason", &doc.reason);
    assert_eq!(reason.expected, reason.code.expected());
}

#[test]
fn invalid_payloads_are_refused() {
    let digest = format!("sha256:{}", "a".repeat(64));
    let long_id = "x".repeat(ID_MAX + 1);
    let refs = format!(
        "[{}]",
        vec![format!("\"{digest}\""); MAX_REFS + 1].join(",")
    );
    for text in [
        // unknown field
        r#"{"k":"rewind","to_ordinal":1,"reason":"edit","extra":1}"#.to_string(),
        // missing field
        r#"{"k":"amend","iid":"a","body":{"inline":{}}}"#.to_string(),
        // slot without its tag
        r#"{"k":"amend","iid":"a","refs":[],"body":{"content":"x"}}"#.to_string(),
        // checkpoint carries no op
        format!(
            r#"{{"k":"checkpoint","op":{{"id":"a","method":"m","digest":"{digest}"}},"state":{{"inline":{{}}}}}}"#
        ),
        // unknown kind
        r#"{"k":"segment"}"#.to_string(),
        // id over its bound
        format!(r#"{{"k":"amend","iid":"{long_id}","refs":[],"body":{{"inline":1}}}}"#),
        // too many refs
        format!(r#"{{"k":"amend","iid":"a","refs":{refs},"body":{{"inline":1}}}}"#),
        // malformed digest
        r#"{"k":"amend","iid":"a","refs":["sha256:AB"],"body":{"inline":1}}"#.to_string(),
        // body blob of another media type
        format!(
            r#"{{"k":"amend","iid":"a","refs":[],"body":{{"blob":{{"digest":"{digest}","bytes":1,"mediaType":"text/plain"}}}}}}"#
        ),
        // unknown field inside the blob descriptor
        format!(
            r#"{{"k":"amend","iid":"a","refs":[],"body":{{"blob":{{"digest":"{digest}","bytes":1,"mediaType":"application/json","x":1}}}}}}"#
        ),
        // op result over its bound
        format!(
            r#"{{"k":"rewind","to_ordinal":1,"reason":"edit","op":{{"id":"a","method":"m","digest":"{digest}","result":"{}"}}}}"#,
            "r".repeat(OP_RESULT_MAX)
        ),
    ] {
        assert!(
            serde_json::from_str::<Record>(&text).is_err(),
            "{}",
            &text[..text.len().min(120)]
        );
    }
}

/// The largest encoding of every record kind, every non-body field at its type bound
/// (worst escaping) and the body slot inline at `INLINE_MAX`, fits `MAX_FRAME_PAYLOAD`.
#[test]
fn every_record_kind_fits_a_frame_at_its_type_bounds() {
    use serde_json::json;
    let text = |max: usize| "\u{1}".repeat(max);
    let id = text(ID_MAX);
    let name = text(NAME_MAX);
    let digest = format!("sha256:{}", "f".repeat(64));
    let body = json!("b".repeat(INLINE_MAX - 2));
    assert_eq!(encoded_len(&body), INLINE_MAX);
    let op = json!({
        "id": text(OP_ID_MAX), "method": name, "digest": digest,
        "result": "r".repeat(OP_RESULT_MAX - 2),
    });
    let slot = json!({ "inline": body });
    let big = u64::MAX;
    let neg = i64::MIN;
    let at = -2.2250738585072014e-308_f64;
    let records = [
        json!({"k": "session", "v": u32::MAX, "id": id, "log_id": text(LOG_ID_MAX),
               "base": {"session": id, "log_id": text(LOG_ID_MAX), "end_ordinal_exclusive": big},
               "origin": {"migration": {"manifest_sha256": text(SHA256_HEX_MAX), "item_key": text(ID_MAX + 8),
                                        "source_digest": digest}},
               "op": op, "header": {"inline": {"k": "b".repeat(INLINE_MAX - 8)}}}),
        json!({"k": "meta", "op": op, "change": {"inline": {"set": {}, "unset": ["u".repeat(INLINE_MAX - 22)]}}}),
        json!({"k": "item", "iid": id, "turn": id, "role": name, "form": "display", "model": false,
               "visible": false,
               "archive": {"seq": big, "at": at,
                           "origin": {"segment": {"id": id, "prev": id, "count": big, "bytes": big}}},
               "op": op,
               "prompt": {"blob": {"digest": digest, "bytes": big, "mediaType": "application/json"}},
               "refs": vec![digest.clone(); MAX_REFS], "body": slot}),
        json!({"k": "amend", "iid": id, "op": op, "refs": vec![digest.clone(); MAX_REFS], "body": slot}),
        json!({"k": "rewind", "to_ordinal": big, "reason": "rewind", "op": op}),
        json!({"k": "compacted", "cid": id, "summary_iid": id, "op": op,
               "replacement": {"inline": [{"iid": "i", "body": "b".repeat(INLINE_MAX - 25)}]}}),
        json!({"k": "run", "rid": id, "phase": "interrupted",
               "attribution": {"provider": name, "model": name, "account": name, "route": name,
                               "preset": name, "effort": name},
               "attempt": {"n": u32::MAX, "delivery": "ambiguous"}, "at": neg, "op": op, "detail": slot}),
        json!({"k": "approval", "aid": id, "rid": id, "phase": "requested", "by_client": id, "at": neg,
               "op": op, "body": slot}),
        json!({"k": "queue", "qid": id, "action": "enqueue", "reason": "cancelled", "op": op, "entry": slot}),
        json!({"k": "op", "op": op, "state": "externalPending", "at": neg, "detail": slot}),
    ];
    let mut largest = 0;
    for value in records {
        let encoded = serde_json::to_string(&value).expect("encode");
        let record: Record =
            serde_json::from_str(&encoded).unwrap_or_else(|e| panic!("{}: {e}", value["k"]));
        let len = encoded_len(&record);
        assert!(len <= MAX_FRAME_PAYLOAD, "{}: {len}", value["k"]);
        largest = largest.max(len);
    }
    // The bound is the item kind's (the body inline at INLINE_MAX leaves the prompt none,
    // so it is a blob reference); NON_BODY_MAX keeps it with headroom.
    assert_eq!(largest - INLINE_MAX, 34_487, "update NON_BODY_MAX's note");
}

#[test]
fn item_state_machine() {
    use ItemState::*;
    let paths: [&[ItemState]; 4] = [
        &[Planned, Staged, Published, Verified, Disposed],
        &[Planned, Verified, Disposed],
        &[Planned, Staged, Published, Quarantined, Disposed],
        &[Planned, Quarantined, Disposed],
    ];
    for path in paths {
        assert!(path.windows(2).all(|w| w[0].can_advance(w[1])), "{path:?}");
    }
    for (from, to) in [
        (Published, Staged),
        (Verified, Quarantined),
        (Disposed, Planned),
        (Planned, Disposed),
    ] {
        assert!(!from.can_advance(to), "{from:?} -> {to:?}");
    }
    assert!(QuarantineCode::CarriedSetAside.expected());
    assert!(!QuarantineCode::DigestMismatch.expected());
}

fn objects(conn: &Connection) -> Vec<(String, String, String)> {
    let mut stmt = conn
        .prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
        )
        .expect("prepare");
    stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .map(|row| row.expect("row"))
        .collect()
}

fn pragma(conn: &Connection, name: &str) -> i64 {
    conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
        .expect(name)
}

fn count(objects: &[(String, String, String)], kind: &str) -> usize {
    objects.iter().filter(|(t, _, _)| t == kind).count()
}

fn plan(conn: &Connection, sql: &str) -> String {
    let mut stmt = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .expect(sql);
    let rows: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(3))
        .expect("plan")
        .map(|row| row.expect("row"))
        .collect();
    rows.join(" | ")
}

#[test]
fn ddl_has_no_carriage_returns() {
    for ddl in [
        INDEX_DDL,
        STATE_DDL,
        LEDGER_V2_BASE,
        LEDGER_V2_DEV,
        LEDGER_DROP_DEV,
        LEDGER_V3_DELTA,
    ] {
        assert!(!ddl.contains('\r'));
    }
}

#[test]
fn index_ddl_creates_the_catalog_and_serves_bounded_queries() {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(INDEX_DDL).expect("index ddl");
    assert_eq!(
        pragma(&conn, "application_id"),
        i64::from(INDEX_APPLICATION_ID)
    );
    assert_eq!(pragma(&conn, "user_version"), i64::from(INDEX_USER_VERSION));
    let tables: Vec<String> = objects(&conn)
        .into_iter()
        .filter(|(t, _, _)| t == "table")
        .map(|(_, name, _)| name)
        .collect();
    assert_eq!(
        tables,
        [
            "amends",
            "approvals",
            "blob_refs",
            "compaction_dropped",
            "compactions",
            "fork_edges",
            "history",
            "message_epochs",
            "message_rows",
            "message_views",
            "meta",
            "prompt_history",
            "prompt_occurrences",
            "session_search",
            "session_search_config",
            "session_search_data",
            "session_search_docsize",
            "session_search_idx",
            "sessions",
            "thread_ops",
            "turns"
        ]
    );
    for query in [
        "SELECT ordinal, file_no, frame_offset, frame_len FROM compactions WHERE session = 'a' AND ordinal < 99 AND superseded_rev IS NULL ORDER BY ordinal DESC LIMIT 1",
        SEARCH_EMPTY,
        SEARCH_TRIGRAM,
        SEARCH_SHORT,
        "SELECT sid FROM sessions WHERE title_kind IS NOT NULL",
        "SELECT id FROM sessions WHERE dirty = 1",
        "SELECT summary FROM sessions WHERE deleted = 0 ORDER BY activity DESC, id LIMIT 200",
        "SELECT sid FROM sessions WHERE id = 'a'",
        "SELECT ordinal, file_no, frame_offset, frame_len FROM history WHERE session = 'a' AND ordinal < 99 AND visible = 1 AND superseded_rev IS NULL ORDER BY ordinal DESC LIMIT 200",
        "SELECT ordinal FROM history WHERE session = 'a' AND ordinal > 5 AND model = 1 AND superseded_rev IS NULL ORDER BY ordinal LIMIT 500",
        "SELECT ordinal FROM history WHERE session = 'a' AND iid = 'x'",
        "SELECT 1 FROM blob_refs WHERE digest = 'sha256:00' LIMIT 1",
        "SELECT child FROM fork_edges WHERE base = 'a' LIMIT 1",
        "SELECT rid FROM turns WHERE session = 'a' AND started_ordinal < 99 ORDER BY started_ordinal DESC LIMIT 50",
    ] {
        let plan = plan(&conn, query);
        // Allowed scans: the partial indexes of dirty rows and placeholder titles, and the
        // trigram index MATCH.
        let full_scan = plan.split(" | ").any(|step| {
            step.starts_with("SCAN")
                && !step.contains("sessions_dirty")
                && !step.contains("sessions_title_kind")
                && !step.contains("VIRTUAL TABLE INDEX 0:M")
        });
        assert!(!full_scan, "{query}: {plan}");
        assert!(
            !plan.contains("TEMP B-TREE") || query == SEARCH_TRIGRAM,
            "{query}: {plan}"
        );
    }
}

const SEARCHABLE: &str = "s.deleted = 0 AND s.classification IN ('task','project')";
const SEARCH_ORDER: &str = "ORDER BY s.archived, s.activity DESC, s.id_key";

/// Empty query: the newest live sessions.
const SEARCH_EMPTY: &str = "SELECT s.summary FROM sessions s
    WHERE s.deleted = 0 AND s.classification IN ('task','project') AND s.archived = 0
    ORDER BY s.archived, s.activity DESC, s.id_key LIMIT 10";
/// Needle ≥ 3 characters: `?1` = the folded needle as one FTS5 phrase (`"` doubled).
const SEARCH_TRIGRAM: &str = "SELECT s.summary FROM session_search f JOIN sessions s ON s.sid = f.rowid
    WHERE session_search MATCH '\"spec\"' AND s.deleted = 0 AND s.classification IN ('task','project')
    ORDER BY s.archived, s.activity DESC, s.id_key LIMIT 50";
/// Needle of 1–2 characters: the walk in result order, stopping at the page size.
const SEARCH_SHORT: &str = "SELECT s.summary FROM sessions s
    WHERE s.deleted = 0 AND s.classification IN ('task','project')
      AND (instr(s.title_fold, 'ab') OR instr(s.preview_fold, 'ab') OR instr(s.cwd_fold, 'ab')
        OR instr(s.project_fold, 'ab') OR instr(s.id_fold, 'ab') OR instr(s.model_fold, 'ab')
        OR instr(s.source_fold, 'ab'))
    ORDER BY s.archived, s.activity DESC, s.id_key LIMIT 50";

#[test]
fn session_search_matches_the_desktop_contract() {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(INDEX_DDL).expect("index ddl");
    let upsert = "INSERT INTO sessions (id, dirty, status, deleted, log_id, newest_file_no, projected_file_no,
            projected_offset, projected_ordinal, history_rev, row_count, visible_count, activity, closed,
            classification, archived, id_key, title_fold, preview_fold, cwd_fold, project_fold, id_fold,
            model_fold, source_fold, summary)
        VALUES (?1, 0, 'ok', 0, 'l', 0, 0, 0, 0, 0, 0, 0, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, NULL, lower(?1), ?9,
            NULL, ?1)
        ON CONFLICT(id) DO UPDATE SET activity = excluded.activity, archived = excluded.archived,
            title_fold = excluded.title_fold, preview_fold = excluded.preview_fold";
    let rows = [
        (
            "sess_A",
            5.0_f64,
            "task",
            0,
            "store format spec",
            "last answer",
            "c:/project/mixdog",
            "claude-opus",
        ),
        (
            "sess_b",
            2.0,
            "project",
            0,
            "시험 세션",
            "the spec review",
            "c:/work",
            "gpt-5",
        ),
        (
            "sess_c",
            9.0,
            "task",
            1,
            "archived spec notes",
            "",
            "c:/x",
            "gpt-5",
        ),
        (
            "sess_d",
            7.0,
            "chat",
            0,
            "spec in a chat",
            "",
            "c:/x",
            "gpt-5",
        ),
        (
            "sess_e", 5.0, "task", 0, "other", "nothing", "c:/specs", "gpt-5",
        ),
        (
            "Sess_e", 5.0, "task", 0, "other", "nothing", "c:/y", "gpt-5",
        ),
    ];
    for (id, activity, class, archived, title, preview, cwd, model) in rows {
        conn.execute(
            upsert,
            rusqlite::params![
                id,
                activity,
                class,
                archived,
                session_id_key(id),
                title,
                preview,
                cwd,
                model
            ],
        )
        .expect("row");
    }
    let search = |needle: &str| -> Vec<String> {
        let phrase = format!("\"{}\"", needle.replace('"', "\"\""));
        let sql = format!(
            "SELECT s.id FROM session_search f JOIN sessions s ON s.sid = f.rowid
             WHERE session_search MATCH ?1 AND {SEARCHABLE} {SEARCH_ORDER} LIMIT 50"
        );
        let mut stmt = conn.prepare(&sql).expect("prepare");
        stmt.query_map([phrase], |row| row.get(0))
            .expect("query")
            .map(|row| row.expect("row"))
            .collect()
    };
    // Title, preview and cwd hits; not the `chat` row; the archived match ranks last even
    // though it is newest; equal activity breaks ties in localeCompare order.
    assert_eq!(search("spec"), ["sess_A", "sess_e", "sess_b", "sess_c"]);
    assert_eq!(search("opus"), ["sess_A"], "model");
    assert_eq!(search("sess_e"), ["sess_e", "Sess_e"], "id, folded");
    assert_eq!(search("험 세"), ["sess_b"]);
    assert_eq!(search("spec n"), ["sess_c"]);
    assert_eq!(
        search("specc:"),
        Vec::<String>::new(),
        "a needle never spans two fields"
    );
    assert_eq!(
        search("SPEC"),
        Vec::<String>::new(),
        "the writer folds; the index does not"
    );
    // A turn updates the preview: the next search sees it.
    conn.execute(
        upsert,
        rusqlite::params![
            "sess_b",
            2.0,
            "project",
            0,
            session_id_key("sess_b"),
            "시험 세션",
            "new reply",
            "c:/work",
            "gpt-5"
        ],
    )
    .expect("turn");
    assert_eq!(search("spec"), ["sess_A", "sess_e", "sess_c"]);
    conn.execute("DELETE FROM sessions WHERE id = 'sess_A'", [])
        .expect("delete");
    assert_eq!(search("spec"), ["sess_e", "sess_c"]);
}

#[test]
fn state_ddl_creates_the_core_state() {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(STATE_DDL).expect("state ddl");
    assert_eq!(
        pragma(&conn, "application_id"),
        i64::from(STATE_APPLICATION_ID)
    );
    assert_eq!(pragma(&conn, "user_version"), i64::from(STATE_USER_VERSION));
    let tables: Vec<String> = objects(&conn)
        .into_iter()
        .filter(|(t, _, _)| t == "table")
        .map(|(_, name, _)| name)
        .collect();
    assert_eq!(
        tables,
        ["meta", "op_watermarks", "ops", "projects", "rooms"]
    );
}

fn new_ledger() -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch("BEGIN IMMEDIATE").expect("begin");
    for script in LEDGER_NEW_SCRIPTS {
        conn.execute_batch(script).expect("ledger script");
    }
    conn.execute_batch("COMMIT").expect("commit");
    conn
}

#[test]
fn new_ledger_has_the_v3_object_set() {
    let conn = new_ledger();
    let objs = objects(&conn);
    let (tables, indexes, views, triggers) = LEDGER_V3_OBJECTS;
    assert_eq!(
        (
            count(&objs, "table"),
            count(&objs, "index"),
            count(&objs, "view"),
            count(&objs, "trigger")
        ),
        (tables, indexes, views, triggers)
    );
    assert_eq!(
        pragma(&conn, "user_version"),
        i64::from(LEDGER_USER_VERSION)
    );
    assert_eq!(
        pragma(&conn, "application_id"),
        i64::from(LEDGER_APPLICATION_ID)
    );
    let seeds: (i64, i64, i64) = conn
        .query_row(
            "SELECT s.complete, s.next, m.rev FROM usage_session_days_state s, usage_membership_revision m",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("seeds");
    assert_eq!(seeds, (1, 0, 0));
}

const ROUTE_OPENAI: &str = r#"'["openai","gpt-5","api","lead","catalog",null,"live",0]'"#;

#[test]
fn both_v2_ledger_shapes_upgrade_to_the_new_schema() {
    for dev in [false, true] {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(LEDGER_V2_BASE).expect("1.4.5 objects");
        if dev {
            conn.execute_batch(LEDGER_V2_DEV).expect("dev objects");
        }
        conn.execute_batch("PRAGMA user_version = 2").expect("v2");
        let v2 = objects(&conn);
        let expected = if dev { (18, 7, 1, 32) } else { (13, 7, 1, 16) };
        assert_eq!(
            (
                count(&v2, "table"),
                count(&v2, "index"),
                count(&v2, "view"),
                count(&v2, "trigger")
            ),
            expected
        );
        conn.execute_batch(&format!(
            "INSERT INTO usage_routes VALUES (1, {ROUTE_OPENAI});
             INSERT INTO usage_sessions VALUES (1, 'sess_a');
             INSERT INTO usage_events VALUES (X'0001', 1, 20260101, 1, 1, 10, 20, 0, 0, 0.1, 2000);"
        ))
        .expect("rows");
        conn.execute_batch("BEGIN IMMEDIATE").expect("begin");
        if dev {
            conn.execute_batch(LEDGER_DROP_DEV).expect("drop dev");
        }
        conn.execute_batch(LEDGER_V3_DELTA).expect("v3");
        conn.execute_batch("COMMIT").expect("commit");
        assert_eq!(objects(&conn), objects(&new_ledger()), "dev={dev}");
        assert_eq!(
            pragma(&conn, "user_version"),
            i64::from(LEDGER_USER_VERSION)
        );
        // Either way the per-session sums are then built by the resumable step (cursor 0).
        let state: (i64, i64) = conn
            .query_row(
                "SELECT complete, next FROM usage_session_days_state",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("state");
        assert_eq!(state, (0, 0), "dev={dev}");
    }
}

fn total_changes(conn: &Connection) -> i64 {
    conn.query_row("SELECT total_changes()", [], |row| row.get(0))
        .expect("total_changes")
}

/// The group token's route-key term (`readUsageToken`), with provider and model read
/// from the route at read time.
const KEY_TOKEN: &str = "SELECT COALESCE(SUM(k.rev),0) FROM usage_key_revisions k WHERE EXISTS (
    SELECT 1 FROM usage_session_days d JOIN usage_routes r ON r.id = d.route
    WHERE d.session IN (SELECT value FROM json_each(?1)) AND d.day = k.day
      AND json_extract(r.signature,'$[0]') = k.provider AND json_extract(r.signature,'$[1]') = k.model)";

#[test]
fn a_route_rewrite_touches_no_session_day_rows() {
    let conn = new_ledger();
    conn.execute_batch(&format!(
        "INSERT INTO usage_routes VALUES (1, {ROUTE_OPENAI})"
    ))
    .expect("route");
    for session in 1..=600 {
        conn.execute(
            "INSERT INTO usage_sessions VALUES (?1, 'sess_' || ?1)",
            [session],
        )
        .expect("session");
        conn.execute(
            "INSERT INTO usage_events VALUES (randomblob(16), 1, 20260101, 1, ?1, 10, 20, 0, 0, 0.1, 2000)",
            [session],
        )
        .expect("event");
    }
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM usage_session_days", [], |row| {
            row.get(0)
        })
        .expect("rows");
    assert_eq!(rows, 600);
    conn.execute_batch("INSERT INTO usage_key_revisions VALUES (20260101,'anthropic','claude',1)")
        .expect("key rev");
    let before = total_changes(&conn);
    conn.execute_batch(
        r#"UPDATE usage_routes SET signature = '["anthropic","claude","api","lead","catalog",null,"live",0]' WHERE id = 1"#,
    )
    .expect("rewrite");
    // The route row, the global day revision and the membership revision.
    assert_eq!(total_changes(&conn) - before, 3);
    // Read time sees the new provider/model through the route id.
    let token: i64 = conn
        .query_row(KEY_TOKEN, ["[1,2]"], |row| row.get(0))
        .expect("token");
    assert_eq!(token, 1);
    let plan = plan(&conn, &KEY_TOKEN.replace("?1", "'[1]'"));
    assert!(plan.contains("SEARCH d USING PRIMARY KEY"), "{plan}");
    assert!(
        plan.contains("SEARCH r USING INTEGER PRIMARY KEY"),
        "{plan}"
    );
}
