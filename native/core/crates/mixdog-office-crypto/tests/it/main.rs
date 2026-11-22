//! One test binary for the crate's integration tests: each extra binary is one more link of the whole dependency graph.

#[path = "../cfb_bounds.rs"]
mod cfb_bounds;
#[path = "../derivation.rs"]
mod derivation;
