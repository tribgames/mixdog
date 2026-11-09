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

/// Told when the session catalog is published to clients (a `thread/list` page, a `thread/summary/updated` row): Node's
/// `onSessions` to the download service (`remote-relay.ts:450`, `retainSessions`). A session counts as seen once it was in one.
pub trait CatalogObserver: Send + Sync {
    fn published(&self, session_ids: &[&str]);
}

pub trait StatePublisher: Send + Sync {
    /// Bumps the `(section, key)` revision and appends the section's notification to the feed
    /// named by `section.feed()` (the app feed, or the thread/scoped feed of `key`). Called by
    /// the owning actor after the state is durable; never waits.
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange);

    /// The keys of a scoped `section` that a client holds open (a live feed with a route); none for an app
    /// section or a publisher that routes nothing. Node's global events reach every open client, whatever it shows.
    fn open_keys(&self, _section: SectionName) -> Vec<String> {
        Vec::new()
    }
}
