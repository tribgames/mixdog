//! The thread feed's read model (`FeedView`): the acked state as the snapshot shows it. Built
//! by the actor at release and swapped into the feed by pointer (RL §5.1); encoded only on
//! cpu-interactive, single-flighted and cached by the feed (SPEC R4).

use std::sync::Arc;

use bytes::Bytes;
use mixdog_app_protocol::v2::thread::SnapshotWindow;
use mixdog_app_protocol::v2::thread::StorageState;
use mixdog_app_protocol::v2::thread::ThreadState;
use mixdog_app_protocol::v2::thread::TranscriptUnit;
use mixdog_app_protocol::v2::thread::WindowAdded;
use mixdog_app_protocol::v2::thread::WindowEdge;
use mixdog_app_protocol::v2::thread::WindowRange;
use mixdog_core_api::FeedView;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::GrantAsk;
use mixdog_core_api::feed::GrantRange;
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
use super::reads::StoredUnit;
use super::state::SessionState;

pub(crate) struct SessionView {
    pub feed: FeedId,
    pub summary: ThreadSummary,
    pub state: ThreadState,
    /// The UI window, oldest first, then the in-progress items.
    pub items: Arc<[Arc<ThreadItem>]>,
    pub has_older: bool,
    /// The history revision the window's records belong to: the lineage of a positioned grant.
    pub lineage: u64,
    /// The newest stored records: the rows a positioned snapshot carries.
    pub tail: StoredTail,
}

/// The newest stored records as a page of them reads ([`super::reads::units`]), oldest first.
#[derive(Clone)]
pub(crate) struct StoredTail {
    pub units: Arc<[Arc<StoredUnit>]>,
    /// Records older than `units` are stored.
    pub older: bool,
    /// One past the newest stored record read for the positioned subscriptions: a followed tail holds from here on.
    pub next: u64,
    /// The most bytes a frame of the feed may have and still be delivered.
    pub budget: usize,
}

impl Default for StoredTail {
    fn default() -> Self {
        Self { units: Arc::from(Vec::new()), older: false, next: 0, budget: usize::MAX }
    }
}

/// `thread/snapshot` params and the `thread/read` result (`ThreadReadResponse` shape).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotParams<'a> {
    pub thread: &'a ThreadSummary,
    pub state: &'a ThreadState,
    pub items: Vec<&'a ThreadItem>,
    pub has_older: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<SnapshotWindow>,
}

pub(crate) use mixdog_core_api::feed::TAIL_RANGE;

impl SessionView {
    pub fn build(feed: FeedId, summary: ThreadSummary, state: &SessionState, storage: StorageState, items: Option<Arc<[Arc<ThreadItem>]>>) -> Self {
        let items = items.unwrap_or_else(|| Self::items_of(state));
        Self { feed, summary, state: state.thread_state(storage), items, has_older: state.has_older, lineage: state.history_rev, tail: StoredTail::default() }
    }

    /// The stored records a positioned snapshot of `rows` rows carries: the newest whole records that show at most
    /// that many rows and fit half a frame beside the state, and whether stored records older than them exist.
    fn carried(&self, rows: u16) -> (&[Arc<StoredUnit>], bool) {
        let units = &self.tail.units;
        let (mut from, mut shown, mut bytes) = (units.len(), 0usize, 0usize);
        while from > 0 {
            let unit = &units[from - 1];
            let fits = bytes + unit.bytes <= self.tail.budget / 2 && (from == units.len() || shown + unit.unit.items.len() <= usize::from(rows));
            if !fits {
                break;
            }
            shown += unit.unit.items.len();
            bytes += unit.bytes;
            from -= 1;
        }
        (&units[from..], self.tail.older || from > 0)
    }

    /// The positioned snapshot's rows and the range that holds them, as of feed seq `at`: the stored records it
    /// carries, and every row no record holds (the in-progress items and the live-only rows), whatever the window asks
    /// for. A record shown and not yet stored is in neither: its unit follows once it is stored.
    fn positioned(&self, rows: u16, at: u64) -> (Vec<&ThreadItem>, bool, SnapshotWindow) {
        let (carried, has_older) = self.carried(rows);
        let older = match carried.first() {
            Some(first) if has_older => WindowEdge::Continuation { position: first.unit.position.clone() },
            _ => WindowEdge::End,
        };
        let held = !carried.is_empty();
        let units: Vec<TranscriptUnit> = carried.iter().map(|unit| unit.unit.clone()).collect();
        let window = SnapshotWindow {
            window_version: at,
            lineage: self.lineage,
            ranges: held.then(|| WindowRange { id: TAIL_RANGE.into(), older, newer: WindowEdge::End }).into_iter().collect(),
            added: held.then(|| WindowAdded { range: TAIL_RANGE.into(), units }).into_iter().collect(),
            follow_tail: true,
        };
        let loose = self.items.iter().map(|item| item.as_ref()).filter(|item| !meta(item).ext.contains_key(super::reads::HISTORY_POSITION)).collect();
        (loose, has_older, window)
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

    pub(crate) fn select(&self, window: &Window) -> Vec<&ThreadItem> {
        let all = self.items.iter().map(|item| item.as_ref());
        match window {
            Window::Fixed => all.collect(),
            Window::HeaderOnly => Vec::new(),
            Window::LastItems(n) | Window::Positioned(n) => {
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
/// window sent only the newest `sent` of the view's `held` rows.
pub(crate) fn snapshot_has_older(store_has_older: bool, window: &Window, sent: usize, held: usize) -> bool {
    store_has_older || (matches!(window, Window::LastItems(_) | Window::LastTurns(_) | Window::Positioned(_)) && sent < held)
}

impl FeedView for SessionView {
    fn encode_snapshot(&self, _lane: &InLane<CpuInteractive>, at: FeedPosition, window: &Window) -> Bytes {
        let params = match window {
            Window::Positioned(rows) => {
                let (items, has_older, window) = self.positioned(*rows, at.seq);
                SnapshotParams { thread: &self.summary, state: &self.state, has_older, items, window: Some(window) }
            }
            window => {
                let items = self.select(window);
                SnapshotParams {
                    thread: &self.summary,
                    state: &self.state,
                    has_older: snapshot_has_older(self.has_older, window, items.len(), self.items.len()),
                    items,
                    window: None,
                }
            }
        };
        frame(&Note::new("thread/snapshot", &params), &self.feed, &at.epoch, at.seq)
    }

    /// The stored records the positioned snapshot carries, and every record stored after the newest one read: exactly
    /// what the subscription is sent.
    fn first_grant(&self, window: &Window) -> Option<GrantAsk> {
        let Window::Positioned(rows) = window else { return None };
        let (carried, has_older) = self.carried(*rows);
        let ranges: Vec<GrantRange> = carried
            .first()
            .zip(carried.last())
            .map(|(first, last)| {
                let (from, to): (Arc<str>, Arc<str>) = (Arc::from(first.unit.position.as_str()), Arc::from(last.unit.position.as_str()));
                GrantRange {
                    id: Arc::from(TAIL_RANGE),
                    first: first.ordinal,
                    last: last.ordinal,
                    older: has_older.then(|| from.clone()),
                    newer: None,
                    from,
                    to,
                }
            })
            .into_iter()
            .collect();
        let tail_from = ranges.first().map_or(self.tail.next, |range| self.tail.next.max(range.last + 1));
        Some(GrantAsk { lineage: self.lineage, ranges, tail_from: Some(tail_from) })
    }

    /// The window version the shared encoding states is the feed seq: the copy a subscription gets states its own.
    fn at_window_version(&self, frame: Bytes, version: u64) -> Bytes {
        const KEY: &[u8] = b"\"window\":{\"windowVersion\":";
        let Some(key) = frame.windows(KEY.len()).position(|bytes| bytes == KEY) else { return frame };
        let start = key + KEY.len();
        let end = start + frame[start..].iter().take_while(|byte| byte.is_ascii_digit()).count();
        let mut out = Vec::with_capacity(frame.len() + 20);
        out.extend_from_slice(&frame[..start]);
        out.extend_from_slice(version.to_string().as_bytes());
        out.extend_from_slice(&frame[end..]);
        Bytes::from(out)
    }

    /// A thread that is retrying shows the wait left when the snapshot is delivered, not when it was first encoded: the cached bytes
    /// serve every attach at the seq, so each delivery gets a copy with the digits of `retryInMs` set (the frame's size in copying,
    /// nothing in encoding), and only while the view's spinner is `reconnecting`.
    fn at_delivery(&self, frame: Bytes) -> Bytes {
        let reconnecting = self
            .state
            .runtime
            .as_ref()
            .and_then(|runtime| runtime.spinner.as_ref())
            .and_then(|spinner| spinner.get("mode"))
            .and_then(serde_json::Value::as_str)
            == Some("reconnecting");
        if !reconnecting {
            return frame;
        }
        match super::spinner::project_retry_bytes(&frame, super::spinner::core_now_ms()) {
            Some(projected) => Bytes::from(projected),
            None => frame,
        }
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
