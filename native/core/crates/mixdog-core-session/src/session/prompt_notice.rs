//! The prompt-settings notice a turn carries (Node `ask-turn-prepare.mjs:204`, `ask-turn-settle.mjs:155-156`).
//!
//! The run reads the pending notice after the turn's settings were reconciled and puts it into the request
//! (`mixdog-core` `turn_notice`); it tells the actor which revision it carried through this cell, and the actor
//! acknowledges that revision once the turn was accepted. A turn that fails or is interrupted acknowledges
//! nothing, so the notice stays pending for the next turn.

use std::sync::Arc;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

/// The revision of the notice a run carried; revisions start at 1, so 0 is "none".
#[derive(Clone, Default)]
pub struct CarriedNotice(Arc<AtomicI64>);

impl CarriedNotice {
    /// The run put the notice of `revision` into its request.
    pub fn carry(&self, revision: i64) {
        self.0.store(revision, Ordering::SeqCst);
    }

    /// The revision carried, handed out once.
    pub fn take(&self) -> Option<i64> {
        match self.0.swap(0, Ordering::SeqCst) {
            0 => None,
            revision => Some(revision),
        }
    }
}
