//! A ledger as 1.4.5 left it: exactly the objects 1.4.5 created, holding a few requests of two days.

#![allow(clippy::disallowed_types, clippy::disallowed_methods, reason = "test fixture I/O")]

use std::path::Path;

use mixdog_ledger::db::Connection;
use mixdog_store::schema::sql::LEDGER_V2_BASE;

/// Three requests on 2026-11-04 and 2026-11-05 of the sessions `a` and `b`, written to `path`.
pub fn write_v145(path: &Path) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(LEDGER_V2_BASE).unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();
    conn.execute("INSERT INTO usage_sessions(value) VALUES ('a'),('b')", []).unwrap();
    conn.execute("INSERT INTO usage_routes(signature) VALUES ('[\"p\",\"m\",\"k\",\"s\",\"provider\",null,\"live\",0]')", []).unwrap();
    // The per-day sums 1.4.5 kept beside the events: two requests on the 4th, one on the 5th.
    conn.execute("INSERT INTO daily VALUES ('2026-11-04', 0, 'p', 'm', 'k', 's', 0, 2, 20, 10, 2, 4, 1.0, 200, 0)", []).unwrap();
    conn.execute("INSERT INTO daily VALUES ('2026-11-05', 0, 'p', 'm', 'k', 's', 0, 1, 10, 5, 1, 2, 0.5, 100, 0)", []).unwrap();
    for (id, ts, day, session) in [(1u8, 1_793_750_000_000_i64, 20_261_104, 1), (2, 1_793_800_000_000, 20_261_104, 2), (3, 1_793_880_000_000, 20_261_105, 1)] {
        conn.execute("INSERT INTO usage_events VALUES (?1, ?2, ?3, 1, ?4, 10, 5, 1, 2, 0.5, 100)", rusqlite::params![vec![id; 16], ts, day, session]).unwrap();
    }
}
