//! One test binary for the crate's integration tests: each extra binary is one more link of the whole dependency graph.
//! nextest runs every test in its own process, so the real-executor boot (`real_executors::rt`) stays per test.
mod legacy_clients;
mod real_executors;
