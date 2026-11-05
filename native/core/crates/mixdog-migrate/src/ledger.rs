//! The usage ledger, converted in place from `user_version` 2 (1.4.5 or 1.4.6-dev shape)
//! to 3 in one `BEGIN IMMEDIATE` (FORMAT.md §9.2). Its publication is its own commit:
//! a SQLite file is never renamed while it has a WAL. Self-identification:
//! `user_version` = 3. Verification: every 1.4.5 table's row count and ordered-row
//! SHA-256 equal before and after, and the schema equals a new v3 ledger exactly.

// The migration is a sanctioned blocking-I/O home (RL §13): it runs once, before the
// runtime, on its own thread.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "one-time migration: the ledger's SQLite file opened directly on the migration thread"
)]

use std::collections::BTreeSet;
use std::path::Path;

use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::KindGroup;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::Root;
use mixdog_store::schema::migration::StagedEntry;
use mixdog_store::schema::migration::Target;
use mixdog_store::schema::sql::LEDGER_DROP_DEV;
use mixdog_store::schema::sql::LEDGER_NEW_SCRIPTS;
use mixdog_store::schema::sql::LEDGER_V2_BASE;
use mixdog_store::schema::sql::LEDGER_V2_DEV;
use mixdog_store::schema::sql::LEDGER_V3_DELTA;
use mixdog_store::schema::sql::LedgerShape;
use rusqlite::Connection;
use rusqlite::OpenFlags;
use rusqlite::types::ValueRef;
use sha2::Digest as _;
use sha2::Sha256;

use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::framework::ItemContext;
use crate::framework::ItemDriver;
use crate::framework::MigrationRoots;
use crate::framework::Staged;
use crate::framework::Verdict;
use crate::framework::Wave;
use crate::json::hex;
use crate::plan;
use crate::plan::PlanSink;

pub const LEDGER_PATH: &str = "usage/ledger.sqlite";
pub const LEDGER_KEY: &str = "ledger";
/// The before-image summary written at stage, compared at verification.
const SUMMARY_FILE: &str = "tables-before.txt";

type Objects = BTreeSet<(String, String, Option<String>)>;

fn objects(conn: &Connection, path: &Path) -> Result<Objects> {
    let mut stmt = conn
        .prepare("SELECT type, name, sql FROM sqlite_master")
        .map_err(|e| Blocked::sqlite("read_schema", path, e))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| Blocked::sqlite("read_schema", path, e))?;
    rows.collect::<std::result::Result<_, _>>()
        .map_err(|e| Blocked::sqlite("read_schema", path, e))
}

fn memory_objects(scripts: &[&str]) -> Objects {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    for script in scripts {
        conn.execute_batch(script).expect("frozen ledger DDL");
    }
    objects(&conn, Path::new(":memory:")).expect("in-memory schema")
}

fn user_version(conn: &Connection, path: &Path) -> Result<i64> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| Blocked::sqlite("read_version", path, e))
}

fn shape(conn: &Connection, path: &Path) -> Result<LedgerShape> {
    let found = objects(conn, path)?;
    if found == memory_objects(&[LEDGER_V2_BASE]) {
        Ok(LedgerShape::Tag145)
    } else if found == memory_objects(&[LEDGER_V2_BASE, LEDGER_V2_DEV]) {
        Ok(LedgerShape::Dev146)
    } else {
        Err(Blocked::LedgerSchema {
            detail: format!("{} objects match neither 1.4.5 nor 1.4.6-dev", found.len()),
        })
    }
}

/// `table count sha256` per 1.4.5 table, rows in primary-key order.
fn tables_summary(conn: &Connection, path: &Path) -> Result<String> {
    let base = Connection::open_in_memory().expect("in-memory sqlite");
    base.execute_batch(LEDGER_V2_BASE).expect("frozen ledger DDL");
    let mut tables: Vec<String> = base
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
        .expect("table list");
    tables.sort();
    let mut out = String::new();
    for table in tables {
        let pk: Vec<String> = base
            .prepare("SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk")
            .and_then(|mut s| s.query_map([&table], |r| r.get(0))?.collect())
            .expect("primary key");
        let order = if pk.is_empty() {
            "rowid".to_string()
        } else {
            pk.iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let sql = format!("SELECT * FROM \"{table}\" ORDER BY {order}");
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Blocked::sqlite("read_table", path, e))?;
        let columns = stmt.column_count();
        let mut rows = stmt
            .query([])
            .map_err(|e| Blocked::sqlite("read_table", path, e))?;
        let mut hasher = Sha256::new();
        let mut count = 0u64;
        while let Some(row) = rows.next().map_err(|e| Blocked::sqlite("read_table", path, e))? {
            count += 1;
            for i in 0..columns {
                let value = row
                    .get_ref(i)
                    .map_err(|e| Blocked::sqlite("read_table", path, e))?;
                match value {
                    ValueRef::Null => hasher.update(b"n"),
                    ValueRef::Integer(n) => hasher.update(format!("i{n};")),
                    ValueRef::Real(f) => hasher.update(format!("r{:016x};", f.to_bits())),
                    ValueRef::Text(t) => {
                        hasher.update(format!("t{}:", t.len()));
                        hasher.update(t);
                    }
                    ValueRef::Blob(b) => {
                        hasher.update(format!("b{}:", b.len()));
                        hasher.update(b);
                    }
                }
            }
            hasher.update(b"\n");
        }
        out.push_str(&format!("{table} {count} {}\n", hex(&hasher.finalize())));
    }
    Ok(out)
}

fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).map_err(|e| Blocked::sqlite("open", path, e))?;
    conn.execute_batch("PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL;")
        .map_err(|e| Blocked::sqlite("pragma", path, e))?;
    Ok(conn)
}

/// Whether the ledger records a completed import of the legacy usage files.
pub fn imported_through(data: &Path) -> Result<bool> {
    let path = data.join(LEDGER_PATH);
    if !path.is_file() {
        return Ok(false);
    }
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| Blocked::sqlite("open", &path, e))?;
    let has_table: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| Blocked::sqlite("read", &path, e))?;
    if !has_table {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM metadata WHERE key='importedThrough')",
        [],
        |r| r.get(0),
    )
    .map_err(|e| Blocked::sqlite("read", &path, e))
}

#[derive(Default)]
pub struct LedgerDriver;

impl ItemDriver for LedgerDriver {
    fn plan(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        if !roots.data.join(LEDGER_PATH).is_file() {
            return Ok(());
        }
        let mut sources = Vec::new();
        for suffix in ["", "-wal", "-shm"] {
            let rel = format!("{LEDGER_PATH}{suffix}");
            if roots.data.join(&rel).is_file() {
                sources.push(sink.source(Root::Data, &rel, false)?);
            }
        }
        sink.add_item(plan::item(
            LEDGER_KEY,
            KindGroup::Data,
            ItemKind::Ledger,
            Contract::Convert,
            sources,
            Some(Target::Ledger),
        )?)
    }

    fn owns(&self, item: &ManifestItem) -> bool {
        item.kind == ItemKind::Ledger
    }

    fn wave(&self, _item: &ManifestItem) -> Wave {
        Wave::Stores
    }

    fn stage(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
        let path = cx.roots.data.join(LEDGER_PATH);
        let conn = open(&path)?;
        if user_version(&conn, &path)? != 2 {
            return Err(Blocked::LedgerSchema {
                detail: format!("user_version {}", user_version(&conn, &path)?),
            });
        }
        shape(&conn, &path)?;
        let summary = tables_summary(&conn, &path)?;
        durable::write_synced(
            &cx.stage_dir(item.key.as_str()).join(SUMMARY_FILE),
            summary.as_bytes(),
        )?;
        Ok(Staged::Output {
            output_sha256: durable::sha256_hex(summary.as_bytes()),
            replaced_surrogates: 0,
        })
    }

    fn publish(&self, cx: &ItemContext<'_>, _item: &ManifestItem, _staged: &StagedEntry) -> Result<()> {
        let path = cx.roots.data.join(LEDGER_PATH);
        let mut conn = open(&path)?;
        if user_version(&conn, &path)? == 3 {
            return Ok(());
        }
        let dev = shape(&conn, &path)? == LedgerShape::Dev146;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| Blocked::sqlite("begin", &path, e))?;
        if dev {
            tx.execute_batch(LEDGER_DROP_DEV)
                .map_err(|e| Blocked::sqlite("upgrade", &path, e))?;
        }
        tx.execute_batch(LEDGER_V3_DELTA)
            .map_err(|e| Blocked::sqlite("upgrade", &path, e))?;
        tx.commit().map_err(|e| Blocked::sqlite("commit", &path, e))?;
        conn.close().map_err(|(_, e)| Blocked::sqlite("close", &path, e))
    }

    fn verify(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Verdict> {
        let path = cx.roots.data.join(LEDGER_PATH);
        let conn = open(&path)?;
        let quarantine = |detail: String| Verdict::Quarantine {
            code: QuarantineCode::DigestMismatch,
            detail,
        };
        if user_version(&conn, &path)? != 3 {
            return Ok(quarantine("user_version is not 3".into()));
        }
        if objects(&conn, &path)? != memory_objects(&LEDGER_NEW_SCRIPTS) {
            return Ok(quarantine("schema differs from a new v3 ledger".into()));
        }
        let before = durable::read(&cx.stage_dir(item.key.as_str()).join(SUMMARY_FILE))?;
        let after = tables_summary(&conn, &path)?;
        if before != after.as_bytes() {
            return Ok(quarantine("1.4.5 table rows differ after the upgrade".into()));
        }
        Ok(Verdict::Verified {
            digest: Some(crate::json::hex_digest(&durable::sha256_hex(&before))),
        })
    }
}
