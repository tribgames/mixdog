//! mixdog-rt's integration tests without `virtual-clock`, in one binary as mixdog-rt builds them (tests/it/main.rs there).
//! clock_control needs the feature and is not built here.

#[path = "../../../tests/elastic.rs"]
mod elastic;
#[path = "../../../tests/executors.rs"]
mod executors;
#[path = "../../../tests/lane_wedged.rs"]
mod lane_wedged;
#[path = "../../../tests/submit_wait.rs"]
mod submit_wait;
#[path = "../../../tests/ticker.rs"]
mod ticker;
#[path = "../../../tests/time_interval.rs"]
mod time_interval;
