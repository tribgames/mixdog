//! Directory handles: listing, entries and creation with options.

use std::ffi::OsString;
use std::fs::FileType;
use std::fs::Metadata;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use crate::proof::ReadProof;
use crate::proof::WriteProof;

/// [`std::fs::ReadDir`]; opened by [`crate::read_dir`].
#[derive(Debug)]
pub struct ReadDir(std::fs::ReadDir);

impl ReadDir {
    pub(crate) fn from_std(inner: std::fs::ReadDir) -> Self {
        Self(inner)
    }
}

impl Iterator for ReadDir {
    type Item = io::Result<DirEntry>;

    fn next(&mut self) -> Option<Self::Item> {
        self.0.next().map(|entry| entry.map(DirEntry))
    }
}

/// [`std::fs::DirEntry`].
#[derive(Debug)]
pub struct DirEntry(std::fs::DirEntry);

impl DirEntry {
    /// The full path of the entry.
    pub fn path(&self) -> PathBuf {
        self.0.path()
    }

    /// The name of the entry within its directory.
    pub fn file_name(&self) -> OsString {
        self.0.file_name()
    }

    /// [`std::fs::DirEntry::metadata`].
    pub fn metadata<P: ReadProof>(&self, _proof: &P) -> io::Result<Metadata> {
        self.0.metadata()
    }

    /// [`std::fs::DirEntry::file_type`].
    pub fn file_type<P: ReadProof>(&self, _proof: &P) -> io::Result<FileType> {
        self.0.file_type()
    }
}

/// [`std::fs::DirBuilder`].
#[derive(Debug)]
pub struct DirBuilder(std::fs::DirBuilder);

impl DirBuilder {
    pub fn new() -> Self {
        Self(std::fs::DirBuilder::new())
    }

    /// Whether missing ancestors are created too.
    pub fn recursive(&mut self, recursive: bool) -> &mut Self {
        self.0.recursive(recursive);
        self
    }

    /// The Unix mode of what is created (subject to the umask).
    #[cfg(unix)]
    pub fn mode(&mut self, mode: u32) -> &mut Self {
        std::os::unix::fs::DirBuilderExt::mode(&mut self.0, mode);
        self
    }

    /// [`std::fs::DirBuilder::create`].
    pub fn create<P: WriteProof>(&self, _proof: &P, path: impl AsRef<Path>) -> io::Result<()> {
        self.0.create(path)
    }
}

impl Default for DirBuilder {
    fn default() -> Self {
        Self::new()
    }
}
