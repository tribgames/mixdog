//! The one production home of blocking `std` file I/O (user decision D-lint-1).
//!
//! Every function mirrors its `std::fs` / `Path` namesake and takes the proof that the caller
//! runs inside a lane job: reads need a [`ReadProof`] (`&InLane<L>` for the interactive,
//! durability and maintenance I/O lanes), writes need a [`WriteProof`] (durability and
//! maintenance only). The workspace `clippy.toml` bans the `std` originals everywhere else, so
//! a file call that is not routed through here, or through `mixdog-testkit` in tests, fails
//! the lint instead of carrying a per-site `#[allow]`.
//!
//! Handles are newtypes ([`File`], [`OpenOptions`], [`ReadDir`], [`DirEntry`], [`DirBuilder`]):
//! the call that opens one takes the proof, and the `Read` / `Write` / `Seek` traits work on it
//! as on the `std` handle, since the lint cannot tell those calls apart from in-memory ones.
//!
//! Process spawning is not here: `mixdog-spawn` is the sanctioned path for it.

mod dir;
pub mod elide;
mod file;
mod ops;
mod proof;

pub use dir::DirBuilder;
pub use dir::DirEntry;
pub use dir::ReadDir;
pub use file::File;
pub use file::OpenOptions;
pub use ops::canonicalize;
pub use ops::copy;
pub use ops::create_dir;
pub use ops::create_dir_all;
pub use ops::exists;
pub use ops::hard_link;
pub use ops::is_dir;
pub use ops::is_file;
pub use ops::is_symlink;
pub use ops::metadata;
pub use ops::read;
pub use ops::read_dir;
pub use ops::read_link;
pub use ops::read_to_string;
pub use ops::remove_dir;
pub use ops::remove_dir_all;
pub use ops::remove_file;
pub use ops::rename;
pub use ops::set_permissions;
pub use ops::sleep;
pub use ops::symlink_dir;
pub use ops::symlink_file;
pub use ops::symlink_metadata;
pub use ops::write;
pub use proof::IoLane;
pub use proof::ReadProof;
pub use proof::Unlaned;
pub use proof::WriteLane;
pub use proof::WriteProof;
