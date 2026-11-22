//! One test binary for the crate's integration tests: each extra binary is one more link of the whole dependency graph.
//! nextest runs every test in its own process, so a test still runs alone in its program.

#[path = "../cfg_test_guard.rs"]
mod cfg_test_guard;
#[path = "../native_mirrors.rs"]
mod native_mirrors;
#[path = "../own_checkout.rs"]
mod own_checkout;
