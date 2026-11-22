//! The replays of every area in one test binary: each extra binary is one more link of the whole dependency graph. An
//! edit of a replay rebuilds this binary only, not the library's unit-test binary.

#[path = "../agents/main.rs"]
mod agents;
#[path = "../quota/main.rs"]
mod quota;
#[path = "../stores/main.rs"]
mod stores;
#[path = "../threads/main.rs"]
mod threads;
