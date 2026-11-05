//! Domain-internal traits shared by providers, tools, file and process
//! services, the extension host, computer use, media and login (P0-DOMAIN).
//!
//! Invariants these contracts encode:
//! - no content-timing timers: no method takes or arms a stream, first-byte
//!   or idle timeout; streams die by facts only ([`provider::TransportFault`]);
//! - transport keepalive is the only half-open detection
//!   ([`keepalive::TransportKeepalive`]);
//! - one retry policy as data rows plus one verdict, with delivery state
//!   ([`retry`], [`provider::DeliveryState`]);
//! - file I/O is lane-typed with the `mixdog-rt` tokens ([`fs::FileService`]);
//! - one process manager for shell, tasks, terminals and LSP
//!   ([`process::ProcessManager`]).
//!
//! With feature `mock`, every trait has an in-memory mock in [`mock`] and a
//! reusable conformance check in [`conformance`] that real implementations
//! run in their own tests.

pub mod approval;
pub mod common;
pub mod computer;
pub mod ext;
pub mod fs;
pub mod keepalive;
pub mod login;
pub mod media;
pub mod ownership;
pub mod process;
pub mod provider;
pub mod repo;
pub mod retry;
pub mod tool;

#[cfg(feature = "mock")]
pub mod conformance;
#[cfg(feature = "mock")]
pub mod mock;
