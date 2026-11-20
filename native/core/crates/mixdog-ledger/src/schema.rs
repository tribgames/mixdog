//! Ledger schema state and the one-time upgrade (FORMAT.md §9).
//!
//! A shape is recognized by the exact set of `(type, name, sql)` in `sqlite_master`, never
//! by row data. Both `user_version` 2 shapes upgrade, in one `BEGIN IMMEDIATE`, to the same
//! v3 schema with the day sums unbuilt (cursor 0); the resumable build in [`crate::sums`]
//! then runs from there.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use mixdog_store::schema::sql::LEDGER_DROP_DEV;
use mixdog_store::schema::sql::LEDGER_NEW_SCRIPTS;
use mixdog_store::schema::sql::LEDGER_USER_VERSION;
use mixdog_store::schema::sql::LEDGER_V2_BASE;
use mixdog_store::schema::sql::LEDGER_V2_DEV;
use mixdog_store::schema::sql::LEDGER_V3_DELTA;
use mixdog_store::schema::sql::LEDGER_V4_DELTA;
use mixdog_store::schema::sql::LEDGER_V4_USER_VERSION;
pub use mixdog_store::schema::sql::LedgerShape;

use crate::db::Connection;
use crate::db::TransactionBehavior;
use crate::error::LedgerError;
use crate::error::Result;

type Objects = BTreeSet<(String, String, String)>;

/// What a ledger file is, before anything is written to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerState {
    /// No objects, `user_version` 0: [`create`] makes a new v4 ledger.
    Empty,
    /// Exactly the v4 objects.
    Current,
    /// A `user_version` 2 ledger of a recognized shape: [`upgrade`] makes it v3, then [`upgrade_v4`] v4.
    Upgradable(LedgerShape),
    /// Exactly the v3 objects: [`upgrade_v4`] makes it v4.
    V3,
}

fn objects(conn: &Connection) -> Result<Objects> {
    let mut stmt = conn.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn scripted(scripts: &[&str]) -> Objects {
    let conn = Connection::open_in_memory().expect("in-memory database");
    for script in scripts {
        conn.execute_batch(script).expect("frozen ledger script");
    }
    objects(&conn).expect("frozen ledger objects")
}

struct Expected {
    tag145: Objects,
    dev146: Objects,
    v3: Objects,
    v4: Objects,
}

fn expected() -> &'static Expected {
    static EXPECTED: OnceLock<Expected> = OnceLock::new();
    EXPECTED.get_or_init(|| Expected {
        tag145: scripted(&[LEDGER_V2_BASE]),
        dev146: scripted(&[LEDGER_V2_BASE, LEDGER_V2_DEV]),
        v3: scripted(&LEDGER_NEW_SCRIPTS),
        v4: scripted(&[LEDGER_NEW_SCRIPTS[0], LEDGER_NEW_SCRIPTS[1], LEDGER_V4_DELTA]),
    })
}

pub fn user_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

/// Reads the file's state. Anything that is not exactly an empty file, a v3 ledger or a
/// recognized `user_version` 2 shape is an error (`migration_blocked{ledger_schema}`).
pub fn classify(conn: &Connection) -> Result<LedgerState> {
    let version = user_version(conn)?;
    let found = objects(conn)?;
    let expected = expected();
    match version {
        0 if found.is_empty() => Ok(LedgerState::Empty),
        2 if found == expected.tag145 => Ok(LedgerState::Upgradable(LedgerShape::Tag145)),
        2 if found == expected.dev146 => Ok(LedgerState::Upgradable(LedgerShape::Dev146)),
        3 if found == expected.v3 => Ok(LedgerState::V3),
        4 if found == expected.v4 => Ok(LedgerState::Current),
        0 | 2 | 3 | 4 => Err(LedgerError::UnrecognizedSchema),
        other => Err(LedgerError::UnsupportedVersion(other)),
    }
}

/// Creates a new v4 ledger on an empty file, in one transaction.
pub fn create(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for script in LEDGER_NEW_SCRIPTS {
        tx.execute_batch(script)?;
    }
    tx.execute_batch(LEDGER_V4_DELTA)?;
    tx.commit()?;
    Ok(())
}

/// Upgrades a v3 ledger to v4 in one transaction: the 1-hour cache-write counts leave the route signatures for
/// `usage_event_cache_1h`, and the routes that differed only by them become one.
pub fn upgrade_v4(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(LEDGER_V4_DELTA)?;
    crate::route_merge::merge_cache_1h_routes(&tx)?;
    tx.commit()?;
    debug_assert_eq!(user_version(conn)?, i64::from(LEDGER_V4_USER_VERSION));
    Ok(())
}

/// Upgrades a recognized `user_version` 2 ledger to v3 in one transaction. A dev-written
/// ledger first loses the 21 objects it added (derived sums and in-memory cache counters).
pub fn upgrade(conn: &mut Connection, shape: LedgerShape) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if shape == LedgerShape::Dev146 {
        tx.execute_batch(LEDGER_DROP_DEV)?;
    }
    tx.execute_batch(LEDGER_V3_DELTA)?;
    tx.commit()?;
    debug_assert_eq!(user_version(conn)?, i64::from(LEDGER_USER_VERSION));
    Ok(())
}

/// What [`prepare`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prepared {
    Created,
    Upgraded(LedgerShape),
    /// A v3 ledger made v4.
    UpgradedV3,
    Current,
}

/// Brings any acceptable ledger file to v4.
pub fn prepare(conn: &mut Connection) -> Result<Prepared> {
    match classify(conn)? {
        LedgerState::Empty => create(conn).map(|()| Prepared::Created),
        LedgerState::Upgradable(shape) => {
            upgrade(conn, shape)?;
            upgrade_v4(conn)?;
            Ok(Prepared::Upgraded(shape))
        }
        LedgerState::V3 => upgrade_v4(conn).map(|()| Prepared::UpgradedV3),
        LedgerState::Current => Ok(Prepared::Current),
    }
}
