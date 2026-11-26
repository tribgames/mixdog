//! The thread feed's read model (`FeedView`): the acked state as the snapshot shows it. Built
//! by the actor at release and swapped into the feed by pointer (RL §5.1); encoded only on
//! cpu-interactive, single-flighted and cached by the feed (SPEC R4).

use std::sync::Arc;
use std::sync::OnceLock;

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
    /// Cached worst-case byte length of a positioned snapshot frame without carried units.
    positioned_envelope: OnceLock<usize>,
}

/// The newest stored records as a page of them reads ([`super::reads::transcript_units`]), oldest first.
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

struct ByteCounter(usize);

impl std::io::Write for ByteCounter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn json_len<T: Serialize>(value: &T) -> usize {
    let mut counter = ByteCounter(0);
    serde_json::to_writer(&mut counter, value).map_or(0, |()| counter.0)
}

impl SessionView {
    pub fn build(feed: FeedId, summary: ThreadSummary, state: &SessionState, storage: StorageState, items: Option<Arc<[Arc<ThreadItem>]>>) -> Self {
        let items = items.unwrap_or_else(|| Self::items_of(state));
        Self {
            feed,
            summary,
            state: state.thread_state(storage),
            items,
            has_older: state.has_older,
            lineage: state.history_rev,
            tail: StoredTail::default(),
            positioned_envelope: OnceLock::new(),
        }
    }

    fn in_progress_items(&self) -> Vec<&ThreadItem> {
        // A record's row is its unit's, whatever its status says.
        let in_progress =
            |item: &&ThreadItem| matches!(meta(item).status, Some(ItemStatus::InProgress)) && !meta(item).ext.contains_key(super::reads::HISTORY_POSITION);
        self.items.iter().map(|item| item.as_ref()).filter(in_progress).collect()
    }

    /// Worst-case encoded byte length of a positioned snapshot frame carrying an empty `tail` range (covering the
    /// JSON-RPC envelope, worst-case `windowVersion`/`seq`/`epoch`, and `at_delivery` retry digits).
    fn positioned_envelope_bytes(&self) -> usize {
        *self.positioned_envelope.get_or_init(|| {
            let window = SnapshotWindow {
                window_version: u64::MAX,
                lineage: self.lineage,
                ranges: vec![WindowRange { id: TAIL_RANGE.into(), older: WindowEdge::End, newer: WindowEdge::End }],
                added: vec![WindowAdded { range: TAIL_RANGE.into(), units: Vec::new() }],
                follow_tail: true,
            };
            let params = SnapshotParams { thread: &self.summary, state: &self.state, items: self.in_progress_items(), has_older: false, window: Some(window) };
            const OUTER_OVERHEAD: usize = 200;
            json_len(&params) + json_len(&self.feed.as_str()) + OUTER_OVERHEAD
        })
    }

    /// The stored records a positioned snapshot of `rows` rows carries: the newest whole records that show at most
    /// that many rows and fit half a frame beside the state (carrying the newest unit alone even above half a frame
    /// so long as the full snapshot still fits the transport frame budget), and whether stored records older than
    /// them exist.
    fn carried(&self, rows: u16) -> (&[Arc<StoredUnit>], bool) {
        let units = &self.tail.units;
        let bounded = self.tail.budget != usize::MAX;
        let envelope = if bounded { self.positioned_envelope_bytes() } else { 0 };
        let end_edge_len = if bounded { json_len(&WindowEdge::End) } else { 0 };
        let (mut from, mut shown, mut bytes) = (units.len(), 0usize, 0usize);
        while from > 0 {
            let unit = &units[from - 1];
            let comma = usize::from(from < units.len());
            let next_bytes = bytes.saturating_add(unit.bytes).saturating_add(comma);
            let edge_extra = if bounded && (self.tail.older || from > 1) {
                json_len(&WindowEdge::Continuation { position: unit.unit.position.clone() }).saturating_sub(end_edge_len)
            } else {
                0
            };
            let fits_frame = !bounded || envelope.saturating_add(next_bytes).saturating_add(edge_extra) <= self.tail.budget;
            let fits = if from == units.len() {
                fits_frame
            } else {
                fits_frame && next_bytes <= self.tail.budget / 2 && shown + unit.unit.items.len() <= usize::from(rows)
            };
            if !fits {
                break;
            }
            shown += unit.unit.items.len();
            bytes = next_bytes;
            from -= 1;
        }
        (&units[from..], self.tail.older || from > 0)
    }

    /// The positioned snapshot's rows and the range that holds them, as of feed seq `at`: the stored records it
    /// carries, as units, and beside them only the output still in progress, whatever the window asks for. Every
    /// settled row is an occurrence of the log and reaches the subscription as its unit: a record shown and not yet
    /// stored is in neither, and its unit follows once it is stored.
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
        (self.in_progress_items(), has_older, window)
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
    fn encode_frame(&self, at: FeedPosition, window: &Window) -> Bytes {
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
}

/// Whether rows older than the snapshot's exist: the store has rows older than the view (`store_has_older`), or the
/// window sent only the newest `sent` of the view's `held` rows.
pub(crate) fn snapshot_has_older(store_has_older: bool, window: &Window, sent: usize, held: usize) -> bool {
    store_has_older || (matches!(window, Window::LastItems(_) | Window::LastTurns(_) | Window::Positioned(_)) && sent < held)
}

impl FeedView for SessionView {
    fn encode_snapshot(&self, _lane: &InLane<CpuInteractive>, at: FeedPosition, window: &Window) -> Bytes {
        self.encode_frame(at, window)
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

    fn stored_unit(ordinal: u64, iid: &str, text: &str, bytes_override: Option<usize>) -> Arc<StoredUnit> {
        let item = ThreadItem::AgentMessage {
            id: mixdog_core_api::ids::ItemId::from(iid),
            text: mixdog_protocol::MaybeBlob::Inline(text.to_owned()),
            imported_tool_runs: Vec::new(),
            meta: ItemMeta::default(),
        };
        let unit = TranscriptUnit { position: super::super::reads::record_position(iid), items: vec![item], ordinal: Some(ordinal) };
        let exact = serde_json::to_vec(&unit).expect("unit serializes").len();
        assert_eq!(super::super::reads::unit_bytes(&unit), exact, "allocation-free counter matches JSON byte length");
        Arc::new(StoredUnit { ordinal, unit, bytes: bytes_override.unwrap_or(exact) })
    }

    fn view_with_tail(units: Vec<Arc<StoredUnit>>, older: bool, budget: usize) -> SessionView {
        let state = SessionState::new(200);
        let summary: ThreadSummary = serde_json::from_value(serde_json::json!({
            "id": "t-1",
            "preview": "",
            "title": "",
            "updatedAt": 0,
            "messageCount": 0,
            "cwd": "",
            "classification": {},
            "projectPath": null,
        }))
        .expect("summary");
        let mut view = SessionView::build(FeedId::from("t-1"), summary, &state, StorageState::Ok, None);
        view.tail = StoredTail { units: Arc::from(units), older, next: 100, budget };
        view
    }

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

    #[test]
    fn carried_always_includes_the_newest_unit_even_when_it_exceeds_half_budget() {
        let budget = 8192;
        let small = stored_unit(1, "u1", "older", Some(100));
        let large_text = "a".repeat(4200);
        let large = stored_unit(2, "u2", &large_text, None);
        assert!(large.bytes > budget / 2, "unit exceeds half budget ({})", large.bytes);
        let view = view_with_tail(vec![small, large.clone()], false, budget);
        assert!(view.positioned_envelope_bytes() + large.bytes < budget, "unit fits frame budget");

        let (carried, has_older) = view.carried(50);
        assert_eq!(carried.len(), 1, "newest unit is carried when above budget / 2 yet within frame budget");
        assert_eq!(carried[0].ordinal, large.ordinal);
        assert!(has_older, "older unit was not carried");
        let frame = view.encode_frame(
            FeedPosition { epoch: mixdog_core_api::ids::FeedEpoch::from("0193b2f2-7c1e-7d5a-9d0e-5f3c2a1b4c6d".to_owned()), seq: 1 },
            &Window::Positioned(50),
        );
        assert!(frame.len() <= budget, "encoded snapshot ({}) must fit transport reservation ({budget})", frame.len());

        // When the single large unit is the only unit in the thread, has_older stays false.
        let solo = view_with_tail(vec![large.clone()], false, budget);
        let (carried, has_older) = solo.carried(50);
        assert_eq!(carried.len(), 1);
        assert_eq!(carried[0].ordinal, large.ordinal);
        assert!(!has_older);
    }

    #[test]
    fn oversized_newest_unit_is_omitted_so_positioned_snapshot_fits_frame_budget() {
        let budget = 2048;
        let small = stored_unit(1, "u1", "older", Some(100));
        let oversized_text = "x".repeat(budget);
        let oversized = stored_unit(2, "u2", &oversized_text, None);
        let view = view_with_tail(vec![small, oversized.clone()], false, budget);

        let (carried, has_older) = view.carried(50);
        assert!(carried.is_empty(), "oversized newest unit must not overflow frame budget");
        assert!(has_older, "omitted stored units remain reachable as older history");
        let grant = view.first_grant(&Window::Positioned(50)).expect("positioned grant");
        assert!(grant.ranges.is_empty(), "empty carried snapshot installs no range yet");
        assert_eq!(grant.tail_from, Some(100));

        let frame = view.encode_frame(
            FeedPosition { epoch: mixdog_core_api::ids::FeedEpoch::from("0193b2f2-7c1e-7d5a-9d0e-5f3c2a1b4c6d".to_owned()), seq: 7 },
            &Window::Positioned(50),
        );
        assert!(frame.len() <= budget, "fallback snapshot ({}) must fit transport reservation ({budget})", frame.len());
        let parsed: serde_json::Value = serde_json::from_slice(&frame).expect("valid snapshot json");
        assert_eq!(parsed["params"]["hasOlder"], serde_json::json!(true));
        assert_eq!(parsed["params"]["window"]["followTail"], serde_json::json!(true));
        assert_eq!(parsed["params"]["window"]["ranges"], serde_json::json!([]));
        assert_eq!(parsed["params"]["window"]["added"], serde_json::json!([]));

        // Solo oversized unit is also omitted cleanly with has_older = true.
        let solo = view_with_tail(vec![oversized], false, budget);
        let (carried, has_older) = solo.carried(50);
        assert!(carried.is_empty());
        assert!(has_older);
    }

    #[test]
    fn carried_honors_last_items_above_32_within_budget() {
        let units: Vec<Arc<StoredUnit>> = (0..60_u64).map(|i| stored_unit(i, &format!("u{i}"), "ok", None)).collect();
        let view = view_with_tail(units, false, 3 << 20);

        let (carried, has_older) = view.carried(50);
        assert_eq!(carried.len(), 50);
        assert_eq!(carried.first().unwrap().ordinal, 10);
        assert_eq!(carried.last().unwrap().ordinal, 59);
        assert!(has_older);
    }
}
