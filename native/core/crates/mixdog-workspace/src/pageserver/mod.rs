//! The core's local page server: the pure rules (asset policy, leases, the storage shim, loopback ports) and the HTTP server built on them.

pub mod http;
pub mod lease;
pub mod policy;
pub mod ports;
pub mod serve;
pub mod shim;

pub use serve::{PageAuthority, PageServer, Refusal};
