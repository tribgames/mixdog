//! The office engine: the Word, Excel, PowerPoint and PDF tool's contract, and what runs it.
//!
//! [`capabilities`] holds the model-facing contract as checked-in data (the operation catalogue, input signatures,
//! aliases and the tool definition) with typed lookups over it.
//! [`snapshot`] reads a session's document as the model sees it: page
//! requests and cursors, the review of what the document says to the agent, query, the snapshot contract.

pub mod bounded;
pub mod capabilities;
pub mod digest;

/// The CSV/TSV backend: parsing, edits, snapshots and validation.
pub mod tabular;
pub mod contracts;
pub mod describe;
pub mod session;
pub mod snapshot;
