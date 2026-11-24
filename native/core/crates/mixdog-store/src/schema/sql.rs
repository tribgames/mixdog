//! SQLite DDL of the three databases (FORMAT.md §8–§9). Each constant is one script for
//! `execute_batch`.

/// `index/store.sqlite`, run once on an empty file (sets `auto_vacuum`, so not inside a
/// transaction).
pub const INDEX_DDL: &str = include_str!("sql/index.sql");
pub const INDEX_APPLICATION_ID: i32 = 0x4D58_4958;
/// 17: `submissions` and `sessions.listed`. 18: the `blob_refs`, `refs_unknown` and `refs_backfill` tables of the dev
/// builds are no longer made; an index that still has them ignores them, and one of version 17 is rebuilt from the logs.
/// 19: `sessions.listed` also holds `modelParameters`, which the agent pool's listing reads; an index of version 18 is
/// brought to it in place at open (`sqlite.rs` `upgrade_from_18`).
/// 20: the `history_turn` index, by which a transcript page finds the model messages of one turn; an index of version
/// 19 gains it in place at open (`upgrade_from_19`), one `CREATE INDEX` over `history`.
/// 21: `turns.end_form` and `history.end_form` (where a turn's end is stored) and the
/// `compactions_cid` index, by which a page lists a compaction's boundary as an occurrence of its own; an index of
/// version 20 gains them in place at open (`upgrade_from_20`): no log an index of 20 was projected from holds an end
/// form.
pub const INDEX_USER_VERSION: i32 = 21;
/// The first released index version: an index of it is brought to [`INDEX_USER_VERSION`] in place at open, never rebuilt
/// from the logs (on a long-used data directory the rebuild held the first start after an update for minutes).
pub const FIRST_RELEASED_INDEX_VERSION: i32 = 18;

/// `sessions.id_key`: a session id (`^[A-Za-z0-9_-]+$`, FORMAT.md §1) as bytes whose
/// order is JavaScript `localeCompare` (ICU root collation) on the id: the primary
/// weights (`_` < `-` < digits < letters, case-blind), `0x00`, then the tertiary weights
/// (lowercase before uppercase).
pub fn session_id_key(id: &str) -> Vec<u8> {
    let primary = id.bytes().map(|b| match b {
        b'_' => 0x01,
        b'-' => 0x02,
        b'0'..=b'9' => 0x10 + (b - b'0'),
        b'a'..=b'z' | b'A'..=b'Z' => 0x20 + (b.to_ascii_lowercase() - b'a'),
        _ => 0xFF,
    });
    let tertiary = id.bytes().map(|b| if b.is_ascii_uppercase() { 0x02 } else { 0x01 });
    primary.chain([0x00]).chain(tertiary).collect()
}

/// `state/core.sqlite`, run once on an empty file (as `INDEX_DDL`).
pub const STATE_DDL: &str = concat!(include_str!("sql/state_v1.sql"), include_str!("sql/state_v2_delta.sql"));
/// The v2 delta over `state_v1.sql`, run on an existing version 1 file.
pub const STATE_V2_DELTA: &str = include_str!("sql/state_v2_delta.sql");
pub const STATE_APPLICATION_ID: i32 = 0x4D58_5354;
pub const STATE_USER_VERSION: i32 = 2;

/// The 37 ledger objects written by the 1.4.5 tag (13 tables, 7 indexes, 1 view,
/// 16 triggers), text byte-identical to its `sqlite_master.sql`.
pub const LEDGER_V2_BASE: &str = include_str!("sql/ledger_v2_base.sql");
/// The 21 objects the 1.4.6-dev line added at `user_version` 2 (5 tables, 16 triggers)
/// plus their two seed rows. Recognition of `Dev146` only; never part of v3.
pub const LEDGER_V2_DEV: &str = include_str!("sql/ledger_v2_session_days.sql");
/// Removes the `LEDGER_V2_DEV` objects.
pub const LEDGER_DROP_DEV: &str = include_str!("sql/ledger_v3_drop_dev.sql");
/// The v3 delta over `LEDGER_V2_BASE`: route-id day sums, build cursor, revisions,
/// `rollup_days`, their triggers and `user_version = 3`.
pub const LEDGER_V3_DELTA: &str = include_str!("sql/ledger_v3.sql");
pub const LEDGER_USER_VERSION: i32 = 3;
/// The v4 delta over a v3 ledger: the per-record 1-hour cache-write counts, out of the route signature. The routes that
/// held them are merged by the ledger crate's upgrade in the same transaction.
pub const LEDGER_V4_DELTA: &str = include_str!("sql/ledger_v4.sql");
pub const LEDGER_V4_USER_VERSION: i32 = 4;
/// The ledger keeps 1.4.5's `application_id` (0).
pub const LEDGER_APPLICATION_ID: i32 = 0;

/// Ledger shapes found at `user_version` 2, told apart by the exact set of
/// `sqlite_master` objects (name and SQL text), never by row data. Both upgrade, in one
/// `BEGIN IMMEDIATE`, to the `LEDGER_NEW_SCRIPTS` schema with the day sums unbuilt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerShape {
    /// Exactly the `LEDGER_V2_BASE` objects: upgrade runs `LEDGER_V3_DELTA`.
    Tag145,
    /// Exactly `LEDGER_V2_BASE` + `LEDGER_V2_DEV` objects: upgrade runs
    /// `LEDGER_DROP_DEV` then `LEDGER_V3_DELTA`.
    Dev146,
}

/// Scripts that create a new v3 ledger, in order, in one transaction.
pub const LEDGER_NEW_SCRIPTS: [&str; 2] = [LEDGER_V2_BASE, LEDGER_V3_DELTA];

/// Object counts of a v3 ledger: tables, indexes with SQL, views, triggers.
pub const LEDGER_V3_OBJECTS: (usize, usize, usize, usize) = (19, 7, 1, 31);
