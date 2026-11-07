//! Node's `surfaceGeneration` (`session-runtime/tool-surface.mjs`): a counter every
//! `invalidatePreSessionToolSurface()` moves. The owners of the events that call it in Node (an extension or
//! feature change, a route set on an empty session, onboarding's Lead route, a session switch, resume or
//! delete) hold a clone and bump it; an empty thread's surface that was brought to an older value is
//! rebuilt at its next turn (the `availabilityKey` of `tool-policy-refresh.mjs`).

use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

#[derive(Clone, Default)]
pub struct SurfaceGeneration(Arc<AtomicU64>);

impl SurfaceGeneration {
    /// `surfaceGeneration += 1`.
    pub fn bump(&self) {
        self.0.fetch_add(1, Ordering::AcqRel);
    }

    pub fn get(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }
}