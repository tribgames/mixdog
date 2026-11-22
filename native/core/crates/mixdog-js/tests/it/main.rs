//! One test binary for the crate's integration tests: each extra binary is one more link of the whole dependency graph.
//! nextest runs every test in its own process, so each test still starts its own V8 platform.

#[path = "../math_primitives_v8.rs"]
mod math_primitives_v8;
#[path = "../utf16_bridges_v8.rs"]
mod utf16_bridges_v8;
