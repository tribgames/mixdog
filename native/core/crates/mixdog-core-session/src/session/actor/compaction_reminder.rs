//! The Goal reminder of a pre-send compaction (`pre-send-compact.mjs`): the run asks for it before
//! the pass and gives it back once the pass is over; the session's header is the actor's.

use super::*;

use super::super::goal_reminder::GoalReminder;

/// The Goal the runtime shows, read for a pre-send compaction's reminder.
pub(crate) struct ReminderRead {
    turn: TurnId,
    preview: bool,
    goal: Option<Goal>,
    reply: oneshot::Sender<Option<GoalReminder>>,
}

impl SessionActor {
    /// `snapshotPendingGoalReminder` reads the stored Goal, after the earlier Goal calls of this thread.
    pub(super) fn compaction_reminder_asked(&mut self, turn: TurnId, preview: bool, reply: oneshot::Sender<Option<GoalReminder>>) {
        if !self.active(&turn) {
            return drop(reply.send(None));
        }
        let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
        self.goal_call(Box::pin(async move {
            let goal = goals.stored_goal(&thread).await.ok().flatten();
            JobDone::CompactionReminder(Box::new(ReminderRead { turn, preview, goal, reply }))
        }));
    }

    /// The pass's reminder over the header as it stands: the real pass marks the session's pending reminder for the
    /// compaction and reads it (`compactBeforeSend`); the savings preview prices the same text on a copy
    /// (`preSendCompactDecision`) and the session keeps its header.
    pub(super) fn compaction_reminder_read(&mut self, read: ReminderRead) {
        let ReminderRead { turn, preview, goal, reply } = read;
        if !self.active(&turn) {
            return drop(reply.send(None));
        }
        let (reminder, change) = super::super::goal_reminder::compaction(&self.projected.header, goal, self.deps.clock.now_ms());
        if !preview {
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
        let _ = reply.send(reminder);
    }

    /// `acknowledgePendingGoalReminder(session, revision)`: a later mark of the reminder stays pending.
    pub(super) fn compaction_reminder_acknowledged(&mut self, revision: u64) {
        if let Some(change) = super::super::goal_reminder::acknowledge(&self.projected.header, revision, self.deps.clock.now_ms()) {
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
    }
}
