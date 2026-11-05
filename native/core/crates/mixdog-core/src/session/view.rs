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

impl FeedView for SessionView {
    fn encode_snapshot(
        &self,
        _lane: &InLane<CpuInteractive>,
        at: FeedPosition,
        window: &Window,
    ) -> Bytes {
        let params = SnapshotParams {
            thread: &self.summary,
            state: &self.state,
            items: self.select(window),
            has_older: self.has_older,
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

fn meta_mut(item: &mut ThreadItem) -> &mut ItemMeta {
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
