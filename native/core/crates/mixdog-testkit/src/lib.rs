//! Fixture I/O and helper processes for tests (user decision D-lint-1). Dev-dependency only.
//!
//! Tests set up and inspect files and start helper processes through this crate: it carries a
//! crate-local `clippy.toml` without the `std::fs` / `std::process` bans, so a test file needs
//! no `#[allow]`. Every function panics with the path in the message when the operation fails,
//! because a fixture that cannot be written or read is a failed test, not a value to handle.

mod chain;
pub mod exact;
mod fixture;
mod fs;
mod process;

pub use chain::chain_output;
pub use exact::Exact;
pub use fixture::Fixture;
pub use fixture::bytes as fixture_read;
pub use fixture::text as fixture_text;
pub use fs::canonical;
pub use fs::create_dir;
pub use fs::create_dir_all;
pub use fs::entry_names;
pub use fs::exists;
pub use fs::is_dir;
pub use fs::is_readonly;
pub use fs::read;
pub use fs::read_string;
pub use fs::remove_dir_all;
pub use fs::remove_file;
pub use fs::set_readonly;
pub use fs::symlink_file;
pub use fs::tree;
pub use fs::write;
pub use process::dead_pid;
pub use process::git;
pub use process::output;
pub use process::spawn_piped;
