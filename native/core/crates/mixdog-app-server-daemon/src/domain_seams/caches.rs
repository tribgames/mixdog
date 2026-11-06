//! The session layer's memoized answers that a setting change drops.

/// `invalidateContextStatusCache()`: the context gauge re-measures at its next read, for every
/// session the process holds. The gauge behind `thread/contextStatus` implements it.
pub trait ContextStatusCaches: Send + Sync {
    fn invalidate_all(&self);
}
