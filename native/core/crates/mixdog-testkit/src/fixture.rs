//! Fixture files read at run time instead of embedded with `include_str!` / `include_bytes!`: an
//! embedded recording is lexed, expanded, codegened and linked in every test build of its crate.
//! Each file is read once per test process and kept for its lifetime.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::PoisonError;

/// The bytes of the file at `path`, read on first use.
pub fn bytes(path: &'static str) -> &'static [u8] {
    static READ: Mutex<BTreeMap<&'static str, &'static [u8]>> = Mutex::new(BTreeMap::new());
    let mut read = READ.lock().unwrap_or_else(PoisonError::into_inner);
    read.entry(path).or_insert_with(|| Box::leak(crate::read(path).into_boxed_slice()))
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
