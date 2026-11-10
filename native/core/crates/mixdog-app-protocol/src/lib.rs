//! The Mixdog wire contract (protocol 2): the JSON-RPC envelope over
//! WebSocket, every client method with its scope/class/mutation/origins row,
//! server requests, notifications, error reasons, `initialize` limits and
//! capabilities, the X17 media frame header and the host channel. JSON Schema
//! and TypeScript goldens are generated from these types (`export`, behind the
//! `codegen` feature, which the crate's own tests enable).
//!
//! Unknown fields: params accept and ignore unknown fields, so older cores
//! serve newer clients. Only settings and update params (`*Set*Params`,
//! `*UpdateParams`, `config/value/write`, `config/batchWrite`,
//! `git/globalConfig/write`, `SubmitOptions`) deny them, because there an
//! ignored field is a requested change that silently did not happen.
//! `BlobDescriptor` is server-produced and also denies them, because store
//! records embed it and parse it strictly.

pub mod common;
pub mod error;
#[cfg(feature = "codegen")]
pub mod export;
pub mod inventory;
pub mod limits;
pub mod media;
pub mod mgmt;
pub mod methods;
pub mod notifications;
pub mod remote_flags;
pub mod rpc;
pub mod server_requests;
pub mod v1;
pub mod v2;

pub use common::*;
pub use error::ErrorData;
pub use methods::*;
pub use notifications::*;
pub use rpc::*;
pub use server_requests::*;
