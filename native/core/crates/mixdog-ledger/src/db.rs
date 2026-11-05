//! The one place the ledger names its SQLite types. Ledger code runs inside the closures
//! `SqliteStore` hands out (a writer step with `&mut Connection`, a reader snapshot with
//! `&Connection`), so it never opens, pools or threads a connection itself.

pub use rusqlite::Connection;
pub use rusqlite::OptionalExtension;
pub use rusqlite::Transaction;
pub use rusqlite::TransactionBehavior;
pub use rusqlite::params;
pub use rusqlite::params_from_iter;
