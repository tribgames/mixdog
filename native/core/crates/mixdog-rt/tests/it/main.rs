//! One test binary for the crate's integration tests: each extra binary is one more link of the whole dependency graph.
//! nextest runs every test in its own process, so a test still runs alone in its program. The cores clock_control starts
//! are this executable on its `clock_control::core` test. mixdog-rt-feature-off builds the same files but clock_control
//! from feature-off/tests/it/main.rs.

#[path = "../clock_control.rs"]
mod clock_control;
#[path = "../elastic.rs"]
mod elastic;
#[path = "../executors.rs"]
mod executors;
#[path = "../lane_wedged.rs"]
mod lane_wedged;
#[path = "../submit_wait.rs"]
mod submit_wait;
#[path = "../ticker.rs"]
mod ticker;
#[path = "../time_interval.rs"]
mod time_interval;
