//! Fixture files read at run time instead of embedded with `include_str!` / `include_bytes!`: an
//! embedded recording is lexed, expanded, codegened and linked in every test build of its crate.
//! Each file is read once per test process and kept for its lifetime.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;

/// This crate's manifest from the checkout's root: what marks a directory as the checkout.
const SELF_MANIFEST: &str = "native/core/crates/mixdog-testkit/Cargo.toml";

/// The checkout the test binary was built in: this crate's manifest directory is four levels below it.
fn built_root() -> Option<&'static Path> {
    Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4)
}

/// The checkout the test runs in: the one holding the manifest directory cargo and nextest name in the test's
/// environment (nextest names the moved one for an archived or relocated build). None when the test binary is
/// started by hand, without that variable.
fn run_root() -> Option<&'static Path> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| {
        let manifest_dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR")?);
        manifest_dir.ancestors().find(|dir| dir.join(SELF_MANIFEST).is_file()).map(Path::to_path_buf)
    })
    .as_deref()
}

/// `path` (a file of the checkout the binary was built in) in the checkout the test runs in. A path outside the
/// built checkout, or a run without a known checkout, is `path` itself.
fn relocated(path: &Path, built_root: Option<&Path>, run_root: Option<&Path>) -> PathBuf {
    match (built_root, run_root) {
        (Some(built), Some(run)) => path.strip_prefix(built).map_or_else(|_| path.to_path_buf(), |inside| run.join(inside)),
        _ => path.to_path_buf(),
    }
}

/// The bytes of the file at `path`, read on first use: from the checkout the test runs in, which is the one it
/// was built in unless the build was moved.
pub fn bytes(path: &'static str) -> &'static [u8] {
    static READ: Mutex<BTreeMap<&'static str, &'static [u8]>> = Mutex::new(BTreeMap::new());
    let mut read = READ.lock().unwrap_or_else(PoisonError::into_inner);
    read.entry(path).or_insert_with(|| Box::leak(crate::read(relocated(Path::new(path), built_root(), run_root())).into_boxed_slice()))
}

/// The UTF-8 text of the file at `path`, read on first use.
pub fn text(path: &'static str) -> &'static str {
    std::str::from_utf8(bytes(path)).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// A fixture named in a `const` or `static` item; derefs to its text.
#[derive(Clone, Copy)]
pub struct Fixture(&'static str);

impl Fixture {
    pub const fn at(path: &'static str) -> Self {
        Self(path)
    }
}

impl std::ops::Deref for Fixture {
    type Target = str;

    fn deref(&self) -> &str {
        text(self.0)
    }
}

/// The text of a file relative to the calling crate's manifest directory: `fixture!("../../fixtures/x.json")`.
#[macro_export]
macro_rules! fixture {
    ($path:literal) => {
        $crate::fixture_text(concat!(env!("CARGO_MANIFEST_DIR"), "/", $path))
    };
}

/// The bytes of a file relative to the calling crate's manifest directory.
#[macro_export]
macro_rules! fixture_bytes {
    ($path:literal) => {
        $crate::fixture_read(concat!(env!("CARGO_MANIFEST_DIR"), "/", $path))
    };
}

/// A [`Fixture`] for a `const` item, relative to the calling crate's manifest directory.
#[macro_export]
macro_rules! fixture_const {
    ($path:literal) => {
        $crate::Fixture::at(concat!(env!("CARGO_MANIFEST_DIR"), "/", $path))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_moved_build_reads_the_checkout_it_runs_in() {
        let built = Path::new("/built/checkout");
        let run = Path::new("/moved/checkout");
        let inside = Path::new("/built/checkout/native/core/crates/mixdog-ai/../../fixtures/a/golden.json");
        assert_eq!(
            relocated(inside, Some(built), Some(run)),
            Path::new("/moved/checkout/native/core/crates/mixdog-ai/../../fixtures/a/golden.json")
        );
        // In place, outside the checkout, and started by hand: the path as written.
        assert_eq!(relocated(inside, Some(built), Some(built)), inside);
        let outside = Path::new("/elsewhere/golden.json");
        assert_eq!(relocated(outside, Some(built), Some(run)), outside);
        assert_eq!(relocated(inside, Some(built), None), inside);
    }

    #[test]
    fn the_running_checkout_is_found_from_the_test_environment() {
        // cargo and nextest run a test with its package's manifest directory in the environment.
        assert_eq!(run_root(), built_root());
        assert_eq!(text(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")), crate::read_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")));
    }
}
