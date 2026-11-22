//! The replays of every area in one test binary: each extra binary is one more link of the whole dependency graph. An
//! edit of a replay rebuilds this binary only, not the library's unit-test binary.

#[path = "../dispatch/main.rs"]
mod dispatch;
#[path = "../process/main.rs"]
mod process;
#[path = "../surface/main.rs"]
mod surface;
#[path = "../workflow/main.rs"]
mod workflow;
