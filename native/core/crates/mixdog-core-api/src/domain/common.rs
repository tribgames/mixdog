//! Primitives every domain trait shares: pull streams and absolute paths.

use std::path::Path;
use std::path::PathBuf;

use async_trait::async_trait;

/// A single-consumer pull source. `None` ends it. Dropping the source is the
/// consumer's cancellation: an implementation stops producing and releases
/// what it holds.
#[async_trait]
pub trait EventSource<T: Send>: Send {
    async fn next(&mut self) -> Option<T>;
}

/// An absolute path. Relative paths are resolved by the caller against the
/// call's working directory before they reach a domain service.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct AbsPath(PathBuf);

impl AbsPath {
    /// `None` for a path that is not absolute on this platform.
    pub fn new(path: impl Into<PathBuf>) -> Option<Self> {
        let path = path.into();
        path.is_absolute().then_some(Self(path))
    }
    pub fn as_path(&self) -> &Path {
        &self.0
    }
    pub fn join(&self, relative: impl AsRef<Path>) -> AbsPath {
        Self(self.0.join(relative))
    }
}

impl AsRef<Path> for AbsPath {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}
