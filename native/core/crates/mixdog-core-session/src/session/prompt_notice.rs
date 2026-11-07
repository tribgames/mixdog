//! The staged reminders a turn carries (Node `ask-turn-prepare.mjs:147-246`, `ask-turn-settle.mjs:148-164`).
//!
//! The run reads every pending reminder after the turn's settings were reconciled and puts them into the request
//! (`mixdog-core` `turn_reminders`); it tells the actor which revision of each it carried through this cell, and
//! the actor acknowledges those revisions ([`super::reminders::acknowledge`]) once the turn was accepted. A turn
//! that fails or is interrupted acknowledges nothing, so every reminder stays pending for the next turn.

use std::sync::Arc;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

/// No revision carried. A revision is a JS number a header holds; this integer is none of them.
const NONE: i64 = i64::MIN;

/// The revision of each staged reminder a run carried; `None` is a reminder the turn did not carry. The goal
/// reminder is acknowledged on its own (`goal_reminder::acknowledge`), as it is read by the actor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Revisions {
    /// `promptSettingsNotice`.
    pub settings: Option<i64>,
    /// `workflowSwitch`.
    pub workflow: Option<i64>,
    /// `orchestrationModeSwitch`.
    pub orchestration: Option<i64>,
    /// `workspaceReroot`.
    pub workspace: Option<i64>,
    /// `pendingSetupNotice`.
    pub setup: Option<i64>,
    /// `pendingDeferredToolDelta`.
    pub deferred: Option<i64>,
}

struct Cell(AtomicI64);

impl Default for Cell {
    fn default() -> Self {
        Self(AtomicI64::new(NONE))
    }
}

impl Cell {
    fn put(&self, revision: Option<i64>) {
        self.0.store(revision.unwrap_or(NONE), Ordering::SeqCst);
    }

    fn take(&self) -> Option<i64> {
        match self.0.swap(NONE, Ordering::SeqCst) {
            NONE => None,
            revision => Some(revision),
        }
    }
}

#[derive(Default)]
struct Cells {
    settings: Cell,
    workflow: Cell,
    orchestration: Cell,
    workspace: Cell,
    setup: Cell,
    deferred: Cell,
}

/// Where a run records the reminders it carried.
#[derive(Clone, Default)]
pub struct CarriedNotice(Arc<Cells>);

impl CarriedNotice {
    /// The run put these reminders into its request.
    pub fn carry(&self, revisions: Revisions) {
        let cells = &self.0;
        cells.settings.put(revisions.settings);
        cells.workflow.put(revisions.workflow);
        cells.orchestration.put(revisions.orchestration);
        cells.workspace.put(revisions.workspace);
        cells.setup.put(revisions.setup);
        cells.deferred.put(revisions.deferred);
    }

    /// The revisions carried, handed out once.
    pub fn take(&self) -> Revisions {
        let cells = &self.0;
        Revisions {
            settings: cells.settings.take(),
            workflow: cells.workflow.take(),
            orchestration: cells.orchestration.take(),
            workspace: cells.workspace.take(),
            setup: cells.setup.take(),
            deferred: cells.deferred.take(),
        }
    }
}
