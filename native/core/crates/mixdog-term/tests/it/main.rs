//! One test binary for the crate's integration tests: each extra binary is one more link of the whole dependency graph.
//! nextest runs every test in its own process, so a test still runs alone in its program. The pseudo-terminal child of
//! console_pty is this executable on its `console_pty::unix_pty::pty_child` test.

#[path = "../console_pty.rs"]
mod console_pty;
#[path = "../frame_stability.rs"]
mod frame_stability;
#[path = "../helpers_fake.rs"]
mod helpers_fake;
