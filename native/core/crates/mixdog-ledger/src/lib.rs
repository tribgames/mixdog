//! The usage ledger, schema v3 (`mixdog-store/FORMAT.md` §9): upgrade from the 1.4.5 and
//! dev shapes, the append path, the resumable per-session day-sum build, and the rollup,
//! session-usage and token reads. Every function takes the `rusqlite` connection the
//! store's writer or reader hands it.

// The ledger's SQL runs on the connection `SqliteStore` lends it; until `mixdog-store::sqlite`
// lands, `rusqlite::Connection` is named directly (through `db`).
#![allow(
    clippy::disallowed_types,
    reason = "mixdog-store::sqlite has not landed"
)]

pub mod append;
pub mod backup;
pub mod bucket;
pub mod db;
#[cfg(test)]
mod dst_tests;
pub mod error;
pub mod hours;
pub mod ledger;
pub mod maintenance;
pub mod measure;
pub mod period;
pub mod quota;
pub mod quota_estimate;
pub mod reader;
pub mod refresh;
pub mod repair;
mod reply;
pub mod requests;
pub mod rollup;
pub mod schema;
pub mod stats;
pub mod sums;
// Calendar-day keys and `NaiveDate` adapters over `mixdog_js::time`, which owns the zone and
// the DST rules; nothing outside this crate needs them.
mod time;
pub mod writer;

pub use error::LedgerError;
pub use error::Result;
