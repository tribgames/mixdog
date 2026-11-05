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
pub mod error;
pub mod maintenance;
pub mod measure;
pub mod repair;
pub mod requests;
pub mod rollup;
pub mod schema;
pub mod sums;
pub mod time;

pub use error::LedgerError;
pub use error::Result;
