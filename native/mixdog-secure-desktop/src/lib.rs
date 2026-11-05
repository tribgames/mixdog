//! The secure-desktop bridge as a library: the wire contract, the security
//! logic, and the client other Mixdog components link to read the secure
//! desktop and send input to it. The `mixdog-secure-desktop` executable
//! is a thin command dispatcher over these modules.

// Pure, portable modules: the wire contract and the security logic. These carry
// the unit tests and build on any host.
pub mod paths;
pub mod protocol;
pub mod security;

// Lifecycle logging is std-only and useful everywhere.
pub mod log;

#[cfg(windows)]
pub mod acl;
#[cfg(windows)]
pub mod capture;
#[cfg(windows)]
pub mod delegation;
#[cfg(windows)]
pub mod desktop;
#[cfg(windows)]
pub mod helper;
#[cfg(windows)]
pub mod inject;
#[cfg(windows)]
pub mod install;
#[cfg(windows)]
pub mod ipc;
#[cfg(windows)]
pub mod launch;
#[cfg(windows)]
pub mod logon;
#[cfg(windows)]
pub mod probe;
#[cfg(windows)]
pub mod service;
#[cfg(windows)]
pub mod shutdown;
#[cfg(windows)]
pub mod signature;
#[cfg(windows)]
pub mod winutil;

#[cfg(windows)]
pub mod client;
