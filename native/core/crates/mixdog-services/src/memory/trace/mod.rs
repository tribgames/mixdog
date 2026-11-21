//! Sink B of the agent trace: Node's `trace.trace_events` store (the memory service's
//! `/admin/trace-record`), over the memory stack's Postgres pool.

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
