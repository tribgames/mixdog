//! Sink B of the agent trace: Node's `trace.trace_events` store (the memory service's
//! `/admin/trace-record`), over the memory stack's Postgres pool. `sql` is generated from the
//! recorded Node statements, `rows` turns events into the rows Node binds, `store` bootstraps the
//! schema, runs the write queue and the retention pass.

mod rows;
mod sql;
mod store;

pub use rows::Event;
pub use rows::RowError;
pub use store::RecordReply;
pub use store::TraceStore;
pub use store::retention_days;
pub use store::trace_enabled;
pub use store::trace_marker_name;
pub use store::trace_marker_path;

#[cfg(test)]
mod golden_tests;
