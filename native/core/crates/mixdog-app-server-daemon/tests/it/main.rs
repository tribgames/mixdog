//! One test binary for the crate's integration tests: each extra binary is one more link of the whole dependency graph.
//! nextest runs every test in its own process, so the real-executor boot (`real_executors::rt`) stays per test.
mod credential_source_scan;
mod late_cells;
mod real_executors;
mod temp_names_replay;

#[path = "../boundary_cross_area.rs"]
mod boundary_cross_area;
#[path = "../credential_reads_tests.rs"]
mod credential_reads_tests;
#[path = "../window_origin.rs"]
mod window_origin;
