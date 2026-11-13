//! The thread feed's read model (`FeedView`): the acked state as the snapshot shows it. Built
//! by the actor at release and swapped into the feed by pointer (RL §5.1); encoded only on
//! cpu-interactive, single-flighted and cached by the feed (SPEC R4).

use std::sync::Arc;

use bytes::Bytes;
use mixdog_app_protocol::v2::thread::StorageState;
use mixdog_app_protocol::v2::thread::ThreadState;
use mixdog_core_api::FeedView;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::TurnId;
use mixdog_protocol::ItemMeta;
use mixdog_protocol::ItemStatus;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::ThreadSummary;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use serde::Serialize;

use super::frames::Note;
use super::frames::frame;
use super::state::SessionState;

pub(crate) struct SessionView {
    pub feed: FeedId,
    pub summary: ThreadSummary,
    pub state: ThreadState,
    /// The UI window, oldest first, then the in-progress items.
    pub items: Arc<[Arc<ThreadItem>]>,
    pub has_older: bool,
}

/// `thread/snapshot` params and the `thread/read` result (`ThreadReadResponse` shape).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotParams<'a> {
    pub thread: &'a ThreadSummary,
    pub state: &'a ThreadState,
    pub items: Vec<&'a ThreadItem>,
    pub has_older: bool,
}

impl SessionView {
    pub fn build(
        feed: FeedId,
        summary: ThreadSummary,
        state: &SessionState,
        storage: StorageState,
        items: Option<Arc<[Arc<ThreadItem>]>>,
    ) -> Self {
        let items = items.unwrap_or_else(|| Self::items_of(state));
        Self {
            feed,
            summary,
            state: state.thread_state(storage),
            items,
            has_older: state.has_older,
        }
    }

    /// Window rows plus in-progress items (status `inProgress`).
    pub fn items_of(state: &SessionState) -> Arc<[Arc<ThreadItem>]> {
        state
            .window
            .iter()
            .map(|row| row.item.clone())
            .chain(state.live.iter().map(|live| {
                let mut item = live.item.clone();
                meta_mut(&mut item).status = Some(ItemStatus::InProgress);
                Arc::new(item)
            }))
            .collect()
    }

    fn select(&self, window: &Window) -> Vec<&ThreadItem> {
        let all = self.items.iter().map(|item| item.as_ref());
        match window {
            Window::Fixed => all.collect(),
            Window::HeaderOnly => Vec::new(),
            Window::LastItems(n) => {
                let skip = self.items.len().saturating_sub(usize::from(*n));
                all.skip(skip).collect()
            }
            Window::LastTurns(n) => {
                let mut turns: Vec<&TurnId> = Vec::new();
                let mut start = self.items.len();
                for (index, item) in self.items.iter().enumerate().rev() {
                    if let Some(turn) = meta(item).turn_id.as_ref()
                        && !turns.contains(&turn)
                    {
                        if turns.len() == usize::from(*n) {
                            break;
                        }
                        turns.push(turn);
                    }
                    start = index;
                }
                all.skip(start).collect()
            }
        }
    }
}

/// Whether rows older than the snapshot's exist: the store has rows older than the view (`store_has_older`), or the
/// window sent only the newest `sent` of the view's `held` rows. The desktop follows a thread with `lastItems: 32` of a
/// view of up to 200, and pages older rows only while this says some exist: a thread whose whole history fitted the
/// view answered "none older" and the rows above its newest 32 could not be scrolled to.
fn snapshot_has_older(store_has_older: bool, window: &Window, sent: usize, held: usize) -> bool {
    store_has_older || (matches!(window, Window::LastItems(_) | Window::LastTurns(_)) && sent < held)
}

impl FeedView for SessionView {
    fn encode_snapshot(
        &self,
        _lane: &InLane<CpuInteractive>,
        at: FeedPosition,
        window: &Window,
    ) -> Bytes {
        let items = self.select(window);
        let params = SnapshotParams {
            thread: &self.summary,
            state: &self.state,
            has_older: snapshot_has_older(self.has_older, window, items.len(), self.items.len()),
            items,
        };
        frame(
            &Note::new("thread/snapshot", &params),
            &self.feed,
            &at.epoch,
            at.seq,
        )
    }
}

pub(crate) fn meta(item: &ThreadItem) -> &ItemMeta {
    match item {
        ThreadItem::UserMessage { meta, .. }
        | ThreadItem::AgentMessage { meta, .. }
        | ThreadItem::Reasoning { meta, .. }
        | ThreadItem::ContextCompaction { meta, .. }
        | ThreadItem::SubAgentActivity { meta, .. }
        | ThreadItem::ToolCall { meta, .. }
        | ThreadItem::StatusRow { meta, .. }
        | ThreadItem::TurnEnd { meta, .. }
        | ThreadItem::RoomRow { meta, .. }
        | ThreadItem::AgentJob { meta, .. } => meta,
    }
}

pub(crate) fn meta_mut(item: &mut ThreadItem) -> &mut ItemMeta {
    match item {
        ThreadItem::UserMessage { meta, .. }
        | ThreadItem::AgentMessage { meta, .. }
        | ThreadItem::Reasoning { meta, .. }
        | ThreadItem::ContextCompaction { meta, .. }
        | ThreadItem::SubAgentActivity { meta, .. }
        | ThreadItem::ToolCall { meta, .. }
        | ThreadItem::StatusRow { meta, .. }
        | ThreadItem::TurnEnd { meta, .. }
        | ThreadItem::RoomRow { meta, .. }
        | ThreadItem::AgentJob { meta, .. } => meta,
    }
}

#[cfg(test)]
mod has_older_tests {
    use super::*;

    #[test]
    fn a_window_that_sends_only_the_newest_rows_says_older_ones_exist() {
        // 150 rows held, the newest 32 sent: the 118 above are reachable.
        assert!(snapshot_has_older(false, &Window::LastItems(32), 32, 150));
        assert!(snapshot_has_older(false, &Window::LastTurns(2), 10, 150));
        // Everything held was sent, and the store has nothing older.
        assert!(!snapshot_has_older(false, &Window::LastItems(32), 20, 20));
        // The store's own older rows still count.
        assert!(snapshot_has_older(true, &Window::LastItems(32), 20, 20));
        // A header-only window sends no rows by design.
        assert!(!snapshot_has_older(false, &Window::HeaderOnly, 0, 150));
    }
}
