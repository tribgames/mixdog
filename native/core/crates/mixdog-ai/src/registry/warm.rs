//! A successful cache warm of a session, as the warmer's touch store records it (`warmUseRecord`).
//!
//! The record is the warmer's own history; the transcript's tail evidence is the session's cache book
//! (`crate::cache_tail`), which a warm feeds only through the evidence of its own admitted attempt.

/// One successful warm: when it ran and the prefix it read.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WarmUse {
    /// Epoch ms.
    pub at: u64,
    pub provider: String,
    pub model: String,
    /// Empty for a provider without a roster.
    pub account_id: String,
}
