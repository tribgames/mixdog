//! Section publication (DS §2.1–2.2, SPEC R14). One publisher for every domain; no domain owns
//! an event bus or a publication timer.

use bytes::Bytes;
use mixdog_protocol::SectionName;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SectionChange {
    /// The encoded JSON value (≤ `INLINE_MAX`).
    Set(Bytes),
    /// The value exceeds `INLINE_MAX`; clients page it with the section's list method.
    Stub {
        count: u64,
    },
    Removed,
}

pub trait StatePublisher: Send + Sync {
    /// Bumps the `(section, key)` revision and appends the section's notification to the feed
    /// named by `section.feed()` (the app feed, or the thread/scoped feed of `key`). Called by
    /// the owning actor after the state is durable; never waits.
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange);
}
